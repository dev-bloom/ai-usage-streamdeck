import { projectHoursToFull, type Sample } from "./burn.js";
import { DEFAULT_THRESHOLDS, type Thresholds } from "./format.js";
import type { DisplayMode, KeyView, ResetsView } from "./render.js";
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
      return { kind: "message", title: "SIGN IN", subtitle: "run claude", tone: "warn" };
    case "stale":
      return { kind: "message", title: "EXPIRED", subtitle: "run claude", tone: "warn" };
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
