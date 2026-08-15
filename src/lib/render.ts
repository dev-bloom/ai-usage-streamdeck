import { formatProjection } from "./burn.js";
import {
  DEFAULT_THRESHOLDS,
  SEVERITY_COLOURS,
  clamp,
  effectiveSeverity,
  formatCountdown,
  formatPct,
  type Thresholds,
} from "./format.js";
import { boostNotice } from "./promo.js";
import type { SessionBucket } from "./sessions.js";
import type { UsageSnapshot } from "./usage.js";

/**
 * Keys are 72x72 points; we draw at 144 so the result stays crisp on the
 * Retina-class panels of the MK.2 and XL, and on Stream Deck Mobile.
 */
const SIZE = 144;

/** Which window(s) a key shows. Set via the property inspector's dropdown. */
export type DisplayMode = "both" | "session" | "weekly";

export const DISPLAY_MODES: DisplayMode[] = ["both", "session", "weekly"];

const BG = "#0d0d11";
const TRACK = "#242430";
const LABEL = "#7d7d8a";
const MUTED = "#6a6a78";

/**
 * System font stack. Stream Deck rasterises SVG with the OS text engine, so
 * naming real macOS faces matters — a missing family silently renders nothing
 * rather than falling back gracefully in some versions.
 */
const FONT = "-apple-system, BlinkMacSystemFont, 'Helvetica Neue', Helvetica, Arial, sans-serif";

export type UsageView = {
  kind: "usage";
  mode: DisplayMode;
  snapshot: UsageSnapshot;
  thresholds?: Thresholds;
  /** Injectable for deterministic tests. */
  now?: Date;
};

export type MessageView = {
  kind: "message";
  title: string;
  subtitle?: string;
  // "ok" exists alongside "neutral" specifically so a success outcome (e.g.
  // a long-press focus landing) can pick a colour under `fill` — "neutral"
  // is reserved for "no severity to report" and must stay visually muted
  // even when filled, so success needs its own tone rather than overloading
  // that one.
  tone?: "neutral" | "warn" | "crit" | "ok";
  /**
   * Fill the entire key with the tone colour instead of drawing dark-on-dark
   * text on the usual near-black face. Exists for confirmations shown while
   * the user is still holding the key down — their finger covers the centre
   * at exactly the moment the confirmation appears, so a centred title/
   * subtitle (the only ink the non-fill path draws) is the least visible
   * part of the key right when it matters. A full-face colour survives at
   * the edges, which a finger doesn't cover.
   */
  fill?: boolean;
};

export type ResetsView = {
  kind: "resets";
  /** Which window(s) to show a countdown for — mirrors the key's own mode. */
  mode: DisplayMode;
  snapshot: UsageSnapshot;
  thresholds?: Thresholds;
  /** Hours until this window fills at the current burn rate, when worth showing. */
  projectionHours?: number | null;
  /** Injectable for deterministic tests. */
  now?: Date;
};

/**
 * The running-sessions key. `face` picks which of three layouts to draw;
 * the count/ranked/total fields are carried at the top level (not nested
 * per-face) because `peek` needs them alongside a `problem`-face's data and
 * `problem` needs them alongside a `counts`-face's data — see
 * `sessionsViewFor` in view.ts for how each state fills them in.
 */
/**
 * The buckets a per-key mode setting can pin a key to. Narrower than
 * `SessionBucket`: "unknown" has no dedicated row anywhere in the UI (it
 * only ever appears inside the problem face's peek), so a mode setting that
 * could select it would produce a face this file has no way to draw.
 */
export type FocusBucket = "waiting" | "processing" | "idle";

export type SessionsView = {
  kind: "sessions";
  face: "counts" | "problem" | "peek" | "focus";
  waiting: number;
  processing: number;
  idle: number;
  ranked: { label: string; bucket: SessionBucket; detail?: string }[];
  liveTotal: number;
  staleFiles: number;
  problem?: { title: string; subtitle: string };
  /**
   * Which bucket a per-key mode setting has pinned this key to. Drives the
   * "focus" face's single count, and — when set alongside "peek" — narrows
   * the peek's ranked rows to that bucket too. Undefined everywhere else,
   * mirroring how `problem` only exists on the "problem" face.
   */
  focusBucket?: FocusBucket;
};

export type KeyView = UsageView | MessageView | ResetsView | SessionsView;

/** Render a key view as a data URI suitable for `action.setImage()`. */
export function renderKey(view: KeyView): string {
  const svg =
    view.kind === "usage" ? renderUsage(view)
    : view.kind === "resets" ? renderResets(view)
    : view.kind === "sessions" ? renderSessions(view)
    : renderMessage(view);
  return toDataUri(svg);
}

/**
 * Resolve a severity to a colour, falling back to the neutral "no data"
 * colour when `effectiveSeverity` has no opinion at all (null pct and no
 * usable status). Centralised here because every render site that used to
 * index `SEVERITY_COLOURS[...]` directly would otherwise need its own null
 * check, and a missed one is a crash, not a bad pixel.
 */
function severityColour(
  pct: number | null,
  t: Thresholds,
  status: string | null | undefined,
): string {
  const sev = effectiveSeverity(pct, t, status);
  return sev === null ? MUTED : SEVERITY_COLOURS[sev];
}

function renderUsage(view: UsageView): string {
  const t = view.thresholds ?? DEFAULT_THRESHOLDS;
  const now = view.now ?? new Date();
  const { snapshot, mode } = view;

  if (mode === "both") {
    const sessionColour = severityColour(snapshot.sessionPct, t, snapshot.sessionStatus);
    const weeklyColour = severityColour(snapshot.weeklyPct, t, snapshot.weeklyStatus);

    return frame(`
      ${bar("5H", snapshot.sessionPct, sessionColour, 36, snapshot.binding === "session")}
      ${bar("7D", snapshot.weeklyPct, weeklyColour, 90, snapshot.binding === "weekly")}
    `);
  }

  const isSession = mode === "session";
  const pct = isSession ? snapshot.sessionPct : snapshot.weeklyPct;
  const status = isSession ? snapshot.sessionStatus : snapshot.weeklyStatus;
  const colour = severityColour(pct, t, status);

  // Label and value both sit *inside* the ring. An earlier layout put the
  // window name above the gauge, where it collided with the arc — the arc's
  // only gap is at the bottom, so the top edge is never free.
  return frame(`
    ${gauge(pct, colour)}
    <text x="72" y="72" font-family="${FONT}" font-size="32" font-weight="700"
          fill="${colour}" text-anchor="middle">${pct === null ? "—" : formatPct(pct)}</text>
    <text x="72" y="91" font-family="${FONT}" font-size="12" font-weight="700"
          fill="${LABEL}" text-anchor="middle" letter-spacing="1.2">${isSession ? "5-HOUR" : "WEEKLY"}</text>
  `);
}

/**
 * The dedicated "resets" screen, shown as a temporary peek so the main faces
 * can stay free of countdowns.
 *
 * It mirrors whatever the key is already showing: a single-window face peeks
 * at that window's reset alone, and only the combined face shows both. Asking
 * "when does this reset" about a key showing one number should not answer
 * with two.
 */
function renderResets(view: ResetsView): string {
  const t = view.thresholds ?? DEFAULT_THRESHOLDS;
  const now = view.now ?? new Date();
  const { snapshot, mode } = view;

  const heading = `<text x="72" y="32" font-family="${FONT}" font-size="13" font-weight="700"
          fill="${LABEL}" text-anchor="middle" letter-spacing="1.2">RESETS IN</text>`;

  if (mode !== "both") {
    // One window: give the countdown the same size and position the gauge
    // face gives its percentage, so tapping reads as the number changing in
    // place rather than the key becoming a different thing.
    const isSession = mode === "session";
    const pct = isSession ? snapshot.sessionPct : snapshot.weeklyPct;
    const resetAt = isSession ? snapshot.sessionResetAt : snapshot.weeklyResetAt;
    const status = isSession ? snapshot.sessionStatus : snapshot.weeklyStatus;
    const colour = severityColour(pct, t, status);
    const countdown = formatCountdown(resetAt, now) ?? "—";

    // At most one bottom line, chosen by priority: a burn-rate projection is
    // live and urgent — the window is actually on track to fill — while the
    // promo notice is just a static calendar fact. The projection must never
    // be displaced by the promo notice, so it is checked first and, when
    // present, wins outright.
    // Number.isFinite (not just typeof) so a NaN slipping in from an edge-case
    // snapshot falls through to the promo notice instead of formatting into
    // "FULL IN NaNh" on the key.
    const projectionText =
      typeof view.projectionHours === "number" && Number.isFinite(view.projectionHours)
        ? formatProjection(view.projectionHours)
        : null;
    const promoText = projectionText === null && mode === "weekly" ? boostNotice(now) : null;
    const bottomText = projectionText ?? promoText;
    const bottomColour = projectionText !== null ? SEVERITY_COLOURS.crit : MUTED;

    return frame(`
      ${heading}
      <text x="72" y="84" font-family="${FONT}" font-size="32" font-weight="700"
            fill="${colour}" text-anchor="middle">${countdown}</text>
      <text x="72" y="105" font-family="${FONT}" font-size="12" font-weight="700"
            fill="${LABEL}" text-anchor="middle" letter-spacing="1.2">${isSession ? "5-HOUR" : "WEEKLY"}</text>
      ${
        bottomText
          ? `<text x="72" y="130" font-family="${FONT}" font-size="12" font-weight="600"
                fill="${bottomColour}" text-anchor="middle" letter-spacing="0.5">${bottomText}</text>`
          : ""
      }
    `);
  }

  const sessionColour = severityColour(snapshot.sessionPct, t, snapshot.sessionStatus);
  const weeklyColour = severityColour(snapshot.weeklyPct, t, snapshot.weeklyStatus);
  const sessionCountdown = formatCountdown(snapshot.sessionResetAt, now) ?? "—";
  const weeklyCountdown = formatCountdown(snapshot.weeklyResetAt, now) ?? "—";

  // 23px, not larger: the widest countdown this can produce is five
  // characters ("4h59m" for the session window, "6d23h" for the weekly one),
  // and at 26px that ran within 4px of the row label — which reads as one
  // merged word at the key's real 72px size.
  return frame(`
    ${heading}
    <text x="13" y="80" font-family="${FONT}" font-size="16" font-weight="700"
          fill="${LABEL}" letter-spacing="1">5H</text>
    <text x="131" y="80" font-family="${FONT}" font-size="23" font-weight="700"
          fill="${sessionColour}" text-anchor="end">${sessionCountdown}</text>
    <text x="13" y="122" font-family="${FONT}" font-size="16" font-weight="700"
          fill="${LABEL}" letter-spacing="1">7D</text>
    <text x="131" y="122" font-family="${FONT}" font-size="23" font-weight="700"
          fill="${weeklyColour}" text-anchor="end">${weeklyCountdown}</text>
  `);
}

/**
 * One labelled progress row: "5H .......... 42%" with a bar underneath.
 * `baseline` is the text baseline; the bar sits 12px below it.
 *
 * `isBinding` recolours the row label to the brighter neutral used for text
 * elsewhere on the key when this is the window Anthropic currently treats as
 * binding. Deliberately not a new shape, dot, or badge: the combined face
 * was recently cleaned up and has no spare room at 72px, so recolouring a
 * label that is already there is the only change that costs zero layout.
 */
function bar(
  label: string,
  pct: number | null,
  colour: string,
  baseline: number,
  isBinding = false,
): string {
  const width = 118;
  // A null pct means this provider doesn't report the window at all — draw
  // the empty track with no fill and an em dash for the value, rather than
  // clamping null to 0 and drawing a real (if empty) 0% bar. A 0% bar reads
  // as "measured and empty"; this window was never measured.
  const filled = pct === null ? 0 : Math.round((clamp(pct, 0, 100) / 100) * width);
  const barY = baseline + 12;
  return `
    <text x="13" y="${baseline}" font-family="${FONT}" font-size="16" font-weight="700"
          fill="${isBinding ? "#c9c9d4" : LABEL}" letter-spacing="1">${label}</text>
    <text x="131" y="${baseline + 2}" font-family="${FONT}" font-size="29" font-weight="700"
          fill="${colour}" text-anchor="end">${pct === null ? "—" : formatPct(pct)}</text>
    <rect x="13" y="${barY}" width="${width}" height="8" rx="4" fill="${TRACK}"/>
    ${filled > 0 ? `<rect x="13" y="${barY}" width="${filled}" height="8" rx="4" fill="${colour}"/>` : ""}
  `;
}

/**
 * A 270-degree arc gauge, opening at the bottom.
 *
 * Drawn with stroke-dasharray on a full arc rather than by computing a
 * partial arc path: it keeps the geometry in one place and makes the
 * rounded cap sit correctly at any percentage, including very small ones.
 */
function gauge(pct: number | null, colour: string): string {
  const cx = 72;
  const cy = 66;
  const r = 48;
  const startAngle = 135;
  const sweep = 270;
  const path = arcPath(cx, cy, r, startAngle, sweep);
  const length = (sweep / 360) * 2 * Math.PI * r;
  // Explicit null branch, not a clamp(null, 0, 100) that happens to floor to
  // 0: the pixels come out the same (an empty ring) either way, but writing
  // it out stops a future edit from quietly treating "unknown" as "0%".
  const filled = pct === null ? 0 : (clamp(pct, 0, 100) / 100) * length;

  return `
    <path d="${path}" fill="none" stroke="${TRACK}" stroke-width="11" stroke-linecap="round"/>
    ${
      filled > 0.5
        ? `<path d="${path}" fill="none" stroke="${colour}" stroke-width="11" stroke-linecap="round"
             stroke-dasharray="${filled.toFixed(2)} ${(length - filled + 1).toFixed(2)}"/>`
        : ""
    }
  `;
}

/** Build an SVG arc path clockwise from `startAngle` through `sweep` degrees. */
function arcPath(cx: number, cy: number, r: number, startAngle: number, sweep: number): string {
  const start = polar(cx, cy, r, startAngle);
  const end = polar(cx, cy, r, startAngle + sweep);
  const largeArc = sweep > 180 ? 1 : 0;
  return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
}

/** Degrees measured clockwise from the positive x-axis, SVG y-down. */
function polar(cx: number, cy: number, r: number, degrees: number): { x: number; y: number } {
  const rad = (degrees * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function renderMessage(view: MessageView): string {
  const hasSub = Boolean(view.subtitle);

  if (view.fill) {
    // Reuse frame()'s own rx=20 rect for the fill rather than drawing a
    // second, inset rectangle: the corners are exactly the part still
    // visible around a covering finger, so the filled silhouette has to be
    // pixel-identical to the normal face's, not a smaller card floating
    // inside it.
    return frame(
      `
    <text x="72" y="${hasSub ? 68 : 80}" font-family="${FONT}" font-size="28" font-weight="800"
          fill="${BG}" text-anchor="middle">${escapeXml(view.title)}</text>
    ${
      hasSub
        ? `<text x="72" y="94" font-family="${FONT}" font-size="13" font-weight="600"
             fill="${BG}" text-anchor="middle">${escapeXml(view.subtitle!)}</text>`
        : ""
    }
  `,
      fillColour(view.tone),
    );
  }

  const colour =
    view.tone === "crit" ? SEVERITY_COLOURS.crit
    : view.tone === "warn" ? SEVERITY_COLOURS.warn
    : view.tone === "ok" ? SEVERITY_COLOURS.ok
    : "#c9c9d4";

  return frame(`
    <text x="72" y="${hasSub ? 68 : 80}" font-family="${FONT}" font-size="21" font-weight="700"
          fill="${colour}" text-anchor="middle">${escapeXml(view.title)}</text>
    ${
      hasSub
        ? `<text x="72" y="94" font-family="${FONT}" font-size="15" font-weight="500"
             fill="${MUTED}" text-anchor="middle">${escapeXml(view.subtitle!)}</text>`
        : ""
    }
  `);
}

/**
 * The full-face colour a `fill` message paints, chosen so the three
 * outcomes stay separable by colour alone — no reading required — when
 * only a ring around a covering finger is visible. "neutral" falls back to
 * MUTED rather than a severity colour: it means "nothing to report," and
 * spending a signal colour on it would blur the line between "this
 * happened" and "this happened and you should care."
 */
function fillColour(tone: MessageView["tone"]): string {
  switch (tone) {
    case "ok":
      return SEVERITY_COLOURS.ok;
    case "warn":
      return SEVERITY_COLOURS.warn;
    case "crit":
      return SEVERITY_COLOURS.crit;
    default:
      return MUTED;
  }
}

function renderSessions(view: SessionsView): string {
  if (view.face === "problem") return renderSessionsProblem(view);
  if (view.face === "peek") return renderSessionsPeek(view);
  if (view.face === "focus") return renderSessionsFocus(view);
  return renderSessionsCounts(view);
}

/**
 * A colour per bucket, shared by the counts rows and the peek dots/labels so
 * the two faces read as the same vocabulary. `crit` is never returned here —
 * see the comment on `renderSessionsCounts` for why session state doesn't
 * get to spend that colour.
 */
function bucketColour(bucket: SessionBucket): string {
  switch (bucket) {
    case "waiting":
      return SEVERITY_COLOURS.warn;
    case "processing":
      return SEVERITY_COLOURS.ok;
    case "idle":
    case "unknown":
      return MUTED;
    default:
      // Unreachable for a well-typed SessionBucket; kept as a plain return
      // rather than an assertNever throw so a future added bucket value
      // degrades to a grey dot instead of crashing the render pass.
      return MUTED;
  }
}

/**
 * The uppercase word a focused key (or a focused peek's heading) shows for
 * each bucket. "RUNNING", not "PROCESSING": the counts face's own row label
 * already reads "RUN", and a settings dropdown option that says "Running
 * only" would otherwise pick a bucket whose face then says something else.
 */
function bucketLabel(bucket: FocusBucket): string {
  switch (bucket) {
    case "waiting":
      return "WAITING";
    case "processing":
      return "RUNNING";
    case "idle":
      return "IDLE";
  }
}

/**
 * The single-bucket face for a key pinned to one row via its mode setting.
 * Sized like the usage gauge's own count/label pair (see renderUsage) rather
 * than like a counts-face row, so a focused sessions key reads at the same
 * weight as every other single-number face in this plugin instead of a
 * three-row layout with two rows removed.
 */
function renderSessionsFocus(view: SessionsView): string {
  const bucket: FocusBucket = view.focusBucket!;
  const count = view[bucket];
  // A count of 0 draws in MUTED regardless of bucket — the same rule
  // sessionCountRow enforces below: colour marks only what's live, so
  // pinning the key to an empty bucket must not borrow that bucket's colour
  // just because it's the one on screen.
  const colour = count === 0 ? MUTED : bucketColour(bucket);
  return frame(`
    <text x="72" y="86" font-family="${FONT}" font-size="56" font-weight="700"
          fill="${colour}" text-anchor="middle">${count}</text>
    <text x="72" y="112" font-family="${FONT}" font-size="13" font-weight="700"
          fill="${colour}" text-anchor="middle" letter-spacing="1.2">${bucketLabel(bucket)}</text>
  `);
}

/**
 * Truncate before escaping, always — escaping first can turn a 4-character
 * "&amp;" into a 5-character run, then a naive slice at the character
 * boundary chops it mid-entity into "&am", which is malformed XML rather
 * than merely ugly. Truncating the raw text first means whatever comes out
 * is still a clean string for escapeXml to work on.
 */
export function truncateName(s: string, maxChars = 18): string {
  if (s.length <= maxChars) return s;
  // Reserve one character for the ellipsis itself, so the truncated result
  // (ellipsis included) never exceeds maxChars — slicing to maxChars and
  // then appending "…" would silently run one character over budget.
  return `${s.slice(0, maxChars - 1)}…`;
}

/**
 * Three label/value rows, no bars, no percentage — a session count has no
 * denominator to fill a bar against, and there's no room for one anyway: a
 * `bar()` row spans ~42px of ink (26px value + 12px gap + 8px track), so
 * three rows at 144px would leave zero clearance, against a file that
 * already treats a 4px gap between adjacent text as reading like one merged
 * word at the real 72px size (see the resets face above). Each row here is
 * ~25px of ink with ~17px clear, which is what makes three rows workable.
 */
function renderSessionsCounts(view: SessionsView): string {
  return frame(`
    ${sessionCountRow("WAIT", view.waiting, SEVERITY_COLOURS.warn, 42)}
    ${sessionCountRow("RUN", view.processing, SEVERITY_COLOURS.ok, 84)}
    ${sessionCountRow("IDLE", view.idle, MUTED, 126)}
  `);
}

/**
 * `crit` is deliberately never used for a row here, live or zero: in this
 * plugin red means "about to hit a usage limit," and every other key spends
 * it that way. Letting a session-state row turn red too would dilute that
 * meaning right where it matters most, on the usage meters.
 *
 * A zero count draws label and value in MUTED regardless of which bucket it
 * is, so colour marks only what's actually live on the key — three grey
 * zeros, not three coloured rows that happen to say "0".
 */
function sessionCountRow(label: string, count: number, colour: string, baseline: number): string {
  const rowColour = count === 0 ? MUTED : colour;
  return `
    <text x="13" y="${baseline}" font-family="${FONT}" font-size="13" font-weight="700"
          fill="${rowColour}" letter-spacing="1.2">${label}</text>
    <text x="131" y="${baseline}" font-family="${FONT}" font-size="26" font-weight="700"
          fill="${rowColour}" text-anchor="end">${count}</text>
  `;
}

/**
 * A `SessionsView` face, not a `MessageView`, specifically because
 * `MessageView`'s title is fixed at 21px — which renders at roughly 10px on
 * a real key, far too small for the one face here that must never be
 * mistaken for a number glanced at from across a desk.
 */
function renderSessionsProblem(view: SessionsView): string {
  // `problem` is guaranteed present whenever face is "problem" — enforced by
  // sessionsViewFor, the only place that constructs this face.
  const problem = view.problem!;
  return frame(`
    <text x="72" y="76" font-family="${FONT}" font-size="44" font-weight="700"
          fill="${SEVERITY_COLOURS.crit}" text-anchor="middle">?</text>
    <text x="72" y="102" font-family="${FONT}" font-size="12" font-weight="700"
          fill="${SEVERITY_COLOURS.crit}" text-anchor="middle" letter-spacing="1.2">${escapeXml(truncateName(problem.title, 24))}</text>
    <text x="72" y="122" font-family="${FONT}" font-size="12" font-weight="500"
          fill="${MUTED}" text-anchor="middle">${escapeXml(truncateName(problem.subtitle, 24))}</text>
  `);
}

/**
 * The temporary detail screen. Shown for every state while peeking, unlike
 * the usage meter's resets peek — see `sessionsViewFor` for why: the peek is
 * *most* useful exactly when the summary face is degraded, since it's the
 * only place the raw per-session data (or the raw unrecognised status
 * strings) ever reaches the key.
 */
function renderSessionsPeek(view: SessionsView): string {
  const rows = view.ranked.slice(0, 3);
  const rowBaselines = [58, 88, 118];
  // A focused peek's heading is fixed to the bucket name — WAITING, not
  // SESSIONS — even when that bucket happens to be empty, since "which
  // bucket is this key even showing me" is exactly what the peek must
  // answer for a filtered key. Its colour still follows the live/zero rule
  // used everywhere else: MUTED when this key's own count is 0, its bucket
  // colour otherwise.
  const headingText = view.focusBucket ? bucketLabel(view.focusBucket) : "SESSIONS";
  const heading =
    view.focusBucket ? (view[view.focusBucket] > 0 ? view.focusBucket : null)
    : highestPriorityBucket(view);
  const headingColour = heading === null ? MUTED : bucketColour(heading);

  return frame(`
    <text x="13" y="26" font-family="${FONT}" font-size="13" font-weight="700"
          fill="${headingColour}" letter-spacing="1.2">${headingText}</text>
    ${rows.map((r, i) => sessionPeekRow(r, rowBaselines[i]!)).join("")}
    <text x="13" y="136" font-family="${FONT}" font-size="11" fill="${MUTED}">${escapeXml(sessionPeekFooter(view, rows))}</text>
  `);
}

function sessionPeekRow(session: { label: string; bucket: SessionBucket }, baseline: number): string {
  const colour = bucketColour(session.bucket);
  return `
    <circle cx="17" cy="${baseline - 4}" r="4.5" fill="${colour}"/>
    <text x="28" y="${baseline}" font-family="${FONT}" font-size="13" font-weight="500"
          fill="#c9c9d4">${escapeXml(truncateName(session.label))}</text>
  `;
}

/**
 * The one-line footer, chosen by priority since only one line is available:
 *
 * 0. A focused peek whose bucket is empty — "no waiting sessions", not the
 *    live/stale fallback below, which counts *every* bucket and would claim
 *    activity a bucket-filtered key has no business reporting.
 * 1. Sessions hidden past the three shown rows ("+N more") — this beats
 *    everything else because a hidden session is information the rest of
 *    the face cannot show at all, while the alternatives below are both
 *    recoverable by pressing again later or inferring from the dots.
 * 2. A single session's `detail` (timestamp, project, etc.) — only offered
 *    when there is exactly one session total, so the footer has nothing
 *    more urgent to say and the detail is unambiguously about the one row
 *    on screen rather than "some session, which one?".
 * 3. The live/stale summary, as a fallback that is always well-defined.
 */
function sessionPeekFooter(
  view: SessionsView,
  shown: { label: string; bucket: SessionBucket; detail?: string }[],
): string {
  if (view.focusBucket && shown.length === 0) {
    return `no ${bucketLabel(view.focusBucket).toLowerCase()} sessions`;
  }
  const hidden = view.ranked.length - shown.length;
  if (hidden > 0) return `+${hidden} more`;
  if (shown.length === 1 && shown[0]!.detail) return truncateName(shown[0]!.detail!, 30);
  return `${view.liveTotal} live · ${view.staleFiles} stale`;
}

/**
 * The bucket that should colour the peek heading: the same waiting >
 * processing > idle priority the counts face already draws top-to-bottom,
 * so the heading colour previews which row is "live" before the eye even
 * reaches the rows. `unknown` never wins here — it has no count field of
 * its own on this view (only `SessionsSnapshot` tracks it), since the one
 * place it matters is the dedicated problem face.
 */
function highestPriorityBucket(view: SessionsView): SessionBucket | null {
  if (view.waiting > 0) return "waiting";
  if (view.processing > 0) return "processing";
  if (view.idle > 0) return "idle";
  return null;
}

// `bg` defaults to the shared BG constant so every existing caller (every
// face but a filled MessageView) is untouched — a filled message is the
// only caller that ever passes something else, painting the tone colour
// into the same rx=20 rect instead of a second shape.
function frame(body: string, bg: string = BG): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <rect width="${SIZE}" height="${SIZE}" rx="20" fill="${bg}"/>
  ${body}
</svg>`;
}

/**
 * Base64 rather than percent-encoding: Stream Deck accepts both, but base64
 * avoids any ambiguity around the '#' in our colour literals.
 */
function toDataUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf-8").toString("base64")}`;
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Exposed for tests and for the icon-generation script. */
export function renderKeySvg(view: KeyView): string {
  return (
    view.kind === "usage" ? renderUsage(view)
    : view.kind === "resets" ? renderResets(view)
    : view.kind === "sessions" ? renderSessions(view)
    : renderMessage(view)
  );
}
