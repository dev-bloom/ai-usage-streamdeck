import { projectHoursToFull, type Sample } from "./burn.js";
import { DEFAULT_THRESHOLDS, type Thresholds } from "./format.js";
import type { DisplayMode, FocusBucket, KeyView, ResetsView, SessionsView } from "./render.js";
import type { RankedSession, SessionBucket, SessionsSnapshot, SessionsState } from "./sessions.js";
import type { StoreState } from "./store.js";
import type { UsageSnapshot } from "./usage.js";

export type MeterSettings = {
  mode?: DisplayMode;
  intervalSeconds?: number;
  warnAt?: number;
  critAt?: number;
  allowRefresh?: boolean;
};

/**
 * Translate store state plus a key's settings into something the renderer can
 * draw. Kept free of Stream Deck imports so it can be unit-tested directly.
 *
 * `peeking` requests the temporary "resets" screen instead of the normal
 * view. It only takes effect when a snapshot is actually available — mid
 * loading, signed-out, stale, or a cold error there is nothing meaningful to
 * show on a resets screen, so the peek is ignored and the usual card wins.
 */
export function viewFor(
  state: StoreState,
  settings: MeterSettings,
  peeking = false,
  now: Date = new Date(),
  /**
   * What to tell the user to run when their credentials are missing or
   * expired. Provider-specific: a Codex key that said "run claude" would
   * send someone to fix the wrong CLI, which is worse than saying nothing.
   * Defaults to Claude's wording because every caller that predates the
   * provider seam is a Claude caller; new providers must pass their own
   * (Provider.signInHint exists precisely to carry it).
   */
  signInHint = "run claude",
): KeyView {
  const mode = settings.mode ?? "both";
  const thresholds = thresholdsFrom(settings);

  if (state.status === "loading") {
    return { kind: "message", title: "…", subtitle: "loading" };
  }

  if (state.status === "ok") {
    if (peeking) {
      return resetsViewFor(mode, state.snapshot, thresholds, state.history, now);
    }
    return { kind: "usage", mode, snapshot: state.snapshot, thresholds };
  }

  switch (state.failure.kind) {
    case "signed-out":
      return { kind: "message", title: "SIGN IN", subtitle: signInHint, tone: "warn" };
    case "stale":
      return { kind: "message", title: "EXPIRED", subtitle: signInHint, tone: "warn" };
    case "no-plan":
      // An API-key account never has ChatGPT/Claude limits to report, on
      // this poll or any future one, so — unlike the cases below — there is
      // no lastGood worth falling back to here.
      return { kind: "message", title: "API KEY", subtitle: "no limits" };
    case "blocked":
      return { kind: "message", title: "BLOCKED", subtitle: "403", tone: "warn" };
    case "offline":
      return { kind: "message", title: "OFFLINE", subtitle: "no network", tone: "warn" };
    case "error":
      // A blip after a good reading keeps showing the last numbers; only a
      // cold failure gets the error card, since stale data still beats none.
      if (state.lastGood) {
        if (peeking) {
          return resetsViewFor(mode, state.lastGood, thresholds, state.history, now);
        }
        return { kind: "usage", mode, snapshot: state.lastGood, thresholds };
      }
      return { kind: "message", title: "ERROR", subtitle: "see logs", tone: "crit" };
  }
}

/**
 * Build the resets peek, adding a burn-rate projection for a single-window
 * face only. The two-row "both" layout has no spare room for it (see the
 * layout note in render.ts), so projectionHours is left undefined there.
 */
function resetsViewFor(
  mode: DisplayMode,
  snapshot: UsageSnapshot,
  thresholds: Thresholds,
  history: Sample[] | undefined,
  now: Date,
): ResetsView {
  if (mode === "both") {
    return { kind: "resets", mode, snapshot, thresholds };
  }

  const isSession = mode === "session";
  const pct = isSession ? snapshot.sessionPct : snapshot.weeklyPct;
  const resetAt = isSession ? snapshot.sessionResetAt : snapshot.weeklyResetAt;
  const projectionHours = projectHoursToFull(
    history ?? [],
    isSession ? "session" : "weekly",
    pct,
    resetAt,
    now,
  );

  return { kind: "resets", mode, snapshot, thresholds, projectionHours };
}

/**
 * Read thresholds from settings, ignoring anything nonsensical.
 *
 * A warn value at or above crit would make the amber band unreachable, so
 * rather than silently drawing a key that can never turn amber we fall back
 * to the defaults and let the user notice their slider is wrong.
 */
export function thresholdsFrom(settings: MeterSettings): Thresholds {
  const warn = Number(settings.warnAt);
  const crit = Number(settings.critAt);
  if (
    !Number.isFinite(warn) || !Number.isFinite(crit) ||
    warn < 0 || crit > 100 || warn >= crit
  ) {
    return DEFAULT_THRESHOLDS;
  }
  return { warn, crit };
}

/** Which bucket(s) the sessions key shows. Set via the property inspector's dropdown. */
export type SessionsMode = "all" | "waiting" | "processing" | "idle";

export type SessionsSettings = {
  mode?: SessionsMode;
  /**
   * Hold duration, in ms, before a press counts as long — set via the
   * property inspector's slider. Left unvalidated here: `PressTracker.down`
   * already clamps and defaults whatever it's handed, so a second check here
   * would just duplicate that one and risk drifting out of sync with it.
   */
  longPressMs?: number;
};

/**
 * Read the display mode from settings, ignoring anything nonsensical — the
 * same posture `thresholdsFrom` above takes toward a bad slider value. An
 * unset mode is the ordinary case (a key that predates this setting, or one
 * nobody has touched yet); an unrecognised string can only arrive from a
 * corrupted or hand-edited settings blob. Either way, trusting it would pin
 * the key to a bucket that doesn't exist and leave `sessionsViewFor` with no
 * good branch to take, so both fall back to "all" rather than being passed
 * through.
 */
export function sessionsModeFrom(settings: SessionsSettings): SessionsMode {
  const { mode } = settings;
  return mode === "waiting" || mode === "processing" || mode === "idle" ? mode : "all";
}

/**
 * Translate sessions-store state into something the renderer can draw. Kept
 * separate from `viewFor` rather than folded into it: the two stores never
 * share a state shape (`SessionsState` has no snapshot at all on `fail`,
 * unlike `StoreState`'s `lastGood`), so merging the mapping functions would
 * force every usage-key caller to reason about a session kind it can never
 * actually receive.
 *
 * Priority when a key could in principle show more than one problem at
 * once: no-registry > unknown-status > unreadable. In practice
 * `SessionsState` only ever carries one of these per call — unknown-status
 * lives inside the "ok" branch, the other two inside "fail" — so they can
 * never literally co-occur, but the ordering is worth stating up front since
 * it's what decided which branch below wins when this was designed.
 *
 * `settings.mode` only ever reaches the branches below that build a "counts"
 * or "focus" face. Every `sessionsProblemView` call is reached before `mode`
 * is even consulted, which is deliberate, not an oversight: a mode filter is
 * a display preference over trustworthy data, and it must never be able to
 * hide the fact that the data isn't trustworthy. A key filtered to "idle"
 * still has to show UNKNOWN STATUS / NO REGISTRY / UNREADABLE when one of
 * those occurs.
 */
export function sessionsViewFor(
  state: SessionsState,
  settings: SessionsSettings,
  peeking = false,
): SessionsView {
  const mode = sessionsModeFrom(settings);

  if (peeking) {
    return sessionsPeekViewFor(state, mode);
  }

  if (state.status === "loading") {
    // A key that flashes a message card for 3s on every profile switch is
    // worse than one that shows zeros then fills in, so loading borrows
    // whichever summary face `mode` picks — counts or focus — rather than
    // getting its own "…" card.
    return sessionsSummaryView(0, 0, 0, [], 0, 0, mode);
  }

  if (state.status === "ok") {
    const { snapshot } = state;
    if (snapshot.unknown > 0) {
      // Takes priority over showing counts: the other counts may still be
      // right, but the key can no longer claim completeness, and "3 IDLE"
      // sitting next to a small badge would read as "3 idle, full stop" —
      // not "3 idle, plus some unclassified number on top of that."
      // Reversible in one line if this proves noisy in practice: just
      // delete this `if` and let unknown sessions fall through silently.
      return sessionsProblemView(
        { title: "UNKNOWN STATUS", subtitle: `${snapshot.unknown} sessions` },
        snapshot,
      );
    }
    return sessionsSummaryView(
      snapshot.waiting,
      snapshot.processing,
      snapshot.idle,
      snapshot.ranked,
      snapshot.liveTotal,
      snapshot.staleFiles,
      mode,
    );
  }

  const { problem } = state;
  if (problem.kind === "no-registry") {
    // `problem.message` is the running-process count formatted upstream
    // (e.g. "3 running") — the store still knows what's live even without a
    // registry file to read session detail from, so that count is worth
    // keeping rather than discarding it for a static subtitle.
    return sessionsProblemView({ title: "NO REGISTRY", subtitle: problem.message }, null);
  }
  return sessionsProblemView({ title: "UNREADABLE", subtitle: "see logs" }, null);
}

function sessionsCountsView(
  waiting: number,
  processing: number,
  idle: number,
  ranked: RankedSession[],
  liveTotal: number,
  staleFiles: number,
): SessionsView {
  return { kind: "sessions", face: "counts", waiting, processing, idle, ranked, liveTotal, staleFiles };
}

/**
 * The non-peek summary: the three-row "counts" face for `mode: "all"`, or
 * the single-row "focus" face pinned to one bucket otherwise. `ranked` is
 * passed through unfiltered either way — the focus face never reads it (it
 * only draws a count), and filtering it here for a field nothing consumes
 * would just be dead work. Only the peek path below filters `ranked`, since
 * that is the one face that actually lists sessions by name.
 */
function sessionsSummaryView(
  waiting: number,
  processing: number,
  idle: number,
  ranked: RankedSession[],
  liveTotal: number,
  staleFiles: number,
  mode: SessionsMode,
): SessionsView {
  if (mode === "all") {
    return sessionsCountsView(waiting, processing, idle, ranked, liveTotal, staleFiles);
  }
  return {
    kind: "sessions",
    face: "focus",
    waiting,
    processing,
    idle,
    ranked,
    liveTotal,
    staleFiles,
    focusBucket: mode,
  };
}

/**
 * `snapshot` is null for the two `fail` problems (no-registry, unreadable),
 * which carry no snapshot at all — the badge still needs *some* counts to
 * satisfy `SessionsView`'s shape, and zero is the only honest answer when
 * there is nothing behind the problem to count.
 */
function sessionsProblemView(
  problem: { title: string; subtitle: string },
  snapshot: SessionsSnapshot | null,
): SessionsView {
  return {
    kind: "sessions",
    face: "problem",
    waiting: snapshot?.waiting ?? 0,
    processing: snapshot?.processing ?? 0,
    idle: snapshot?.idle ?? 0,
    ranked: snapshot?.ranked ?? [],
    liveTotal: snapshot?.liveTotal ?? 0,
    staleFiles: snapshot?.staleFiles ?? 0,
    problem,
  };
}

/**
 * Unlike `resetsViewFor` above, this answers `peeking` in every state, not
 * just "ok" — the peek is *most* valuable exactly when the summary face is
 * degraded: on the unknown-status problem it substitutes the raw
 * unrecognised status strings for the usual ranked list, which is the
 * entire payload of the detection strategy and otherwise never reaches the
 * key at all. A usage key ignores a peek with nothing to show because a
 * countdown for a window that was never measured is meaningless; a sessions
 * key has no such case — even "definitely nothing running" or "can't tell
 * you anything" is itself the answer worth confirming.
 */
function sessionsPeekViewFor(state: SessionsState, mode: SessionsMode): SessionsView {
  if (state.status === "ok") {
    const { snapshot } = state;
    if (snapshot.unknown > 0) {
      // Deliberately not mode-filtered: `bucketFromStatus` never classifies
      // anything as "unknown" into waiting/processing/idle, so a bucket
      // filter applied here would just empty the list — discarding the one
      // thing this diagnostic peek exists to show, on the one face where
      // rule 1 (problem data always wins) matters most.
      const ranked: RankedSession[] = snapshot.unknownStatuses.map((label: string) => ({
        label,
        bucket: "unknown" as SessionBucket,
        // One entry per distinct raw status string, not per session — several
        // sessions could share the same unknown status, so this list has
        // already lost the individual record identity a real pid would refer
        // to. -1 is not a pid any process can ever have, which is what keeps
        // firstFocusableSession (below) from treating one of these as
        // something a long press could act on.
        pid: -1,
      }));
      return {
        kind: "sessions",
        face: "peek",
        waiting: snapshot.waiting,
        processing: snapshot.processing,
        idle: snapshot.idle,
        ranked,
        liveTotal: snapshot.liveTotal,
        staleFiles: snapshot.staleFiles,
      };
    }
    return sessionsFocusedPeek(
      snapshot.waiting,
      snapshot.processing,
      snapshot.idle,
      snapshot.ranked,
      snapshot.liveTotal,
      snapshot.staleFiles,
      mode,
    );
  }

  if (state.status === "loading") {
    return sessionsFocusedPeek(0, 0, 0, [], 0, 0, mode);
  }

  // `fail`: no snapshot exists to peek at, so the peek shows the same zeros
  // the problem face's counts already fall back to.
  return sessionsFocusedPeek(0, 0, 0, [], 0, 0, mode);
}

/**
 * The peek face, narrowed to one bucket's rows when `mode` isn't "all" — the
 * "peek follows the filter" rule: a key pinned to "waiting only" must never
 * leak another bucket's sessions into its peek just because they happened to
 * be the ones running. When the focused bucket has no sessions, `ranked`
 * comes back empty and `sessionPeekFooter` in render.ts is what turns that
 * into "no waiting sessions" instead of silently listing nothing.
 */
function sessionsFocusedPeek(
  waiting: number,
  processing: number,
  idle: number,
  ranked: RankedSession[],
  liveTotal: number,
  staleFiles: number,
  mode: SessionsMode,
): SessionsView {
  const base: SessionsView = {
    ...sessionsCountsView(waiting, processing, idle, ranked, liveTotal, staleFiles),
    face: "peek",
  };
  if (mode === "all") return base;
  return { ...base, ranked: ranked.filter((r) => r.bucket === mode), focusBucket: mode };
}

/**
 * The one session a long press on this key should focus: the first entry of
 * the snapshot's own `ranked` list that lands in this key's bucket, in the
 * exact order the peek face already lists sessions in. Reading from `ranked`
 * rather than re-deriving an order here is deliberate — a second copy of the
 * ranking rule could drift from what the peek shows, and "first" would stop
 * meaning the same thing on the two faces.
 *
 * Only `state.status === "ok"` has a `ranked` list to draw from; loading and
 * fail states have nothing a long press could act on. `mode: "all"` skips
 * "unknown"-bucket entries: that bucket has no dedicated row on the counts
 * face and isn't one of the three a mode setting can pin a key to, so an
 * unrecognised-status session must never silently become "the" session an
 * unfiltered key's long press jumps to. A non-positive pid marks a synthetic
 * entry that was never a real, live session (see the unknown-status peek
 * built in sessionsPeekViewFor above) and is skipped for the same reason:
 * focusing it would be acting on a placeholder, not a session.
 */
export function firstFocusableSession(
  state: SessionsState,
  settings: SessionsSettings,
): RankedSession | null {
  if (state.status !== "ok") return null;
  const mode = sessionsModeFrom(settings);

  for (const session of state.snapshot.ranked) {
    if (session.pid <= 0) continue;
    if (mode === "all") {
      if (session.bucket === "waiting" || session.bucket === "processing" || session.bucket === "idle") {
        return session;
      }
      continue;
    }
    if (session.bucket === mode) return session;
  }
  return null;
}
