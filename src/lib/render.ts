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
  tone?: "neutral" | "warn" | "crit";
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

export type KeyView = UsageView | MessageView | ResetsView;

/** Render a key view as a data URI suitable for `action.setImage()`. */
export function renderKey(view: KeyView): string {
  const svg =
    view.kind === "usage" ? renderUsage(view)
    : view.kind === "resets" ? renderResets(view)
    : renderMessage(view);
  return toDataUri(svg);
}

function renderUsage(view: UsageView): string {
  const t = view.thresholds ?? DEFAULT_THRESHOLDS;
  const now = view.now ?? new Date();
  const { snapshot, mode } = view;

  if (mode === "both") {
    const sessionSev = effectiveSeverity(snapshot.sessionPct, t, snapshot.sessionStatus);
    const weeklySev = effectiveSeverity(snapshot.weeklyPct, t, snapshot.weeklyStatus);

    return frame(`
      ${bar("5H", snapshot.sessionPct, SEVERITY_COLOURS[sessionSev], 36, snapshot.binding === "session")}
      ${bar("7D", snapshot.weeklyPct, SEVERITY_COLOURS[weeklySev], 90, snapshot.binding === "weekly")}
    `);
  }

  const isSession = mode === "session";
  const pct = isSession ? snapshot.sessionPct : snapshot.weeklyPct;
  const status = isSession ? snapshot.sessionStatus : snapshot.weeklyStatus;
  const colour = SEVERITY_COLOURS[effectiveSeverity(pct, t, status)];

  // Label and value both sit *inside* the ring. An earlier layout put the
  // window name above the gauge, where it collided with the arc — the arc's
  // only gap is at the bottom, so the top edge is never free.
  return frame(`
    ${gauge(pct, colour)}
    <text x="72" y="72" font-family="${FONT}" font-size="32" font-weight="700"
          fill="${colour}" text-anchor="middle">${formatPct(pct)}</text>
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
    const colour = SEVERITY_COLOURS[effectiveSeverity(pct, t, status)];
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

  const sessionColour = SEVERITY_COLOURS[effectiveSeverity(snapshot.sessionPct, t, snapshot.sessionStatus)];
  const weeklyColour = SEVERITY_COLOURS[effectiveSeverity(snapshot.weeklyPct, t, snapshot.weeklyStatus)];
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
  pct: number,
  colour: string,
  baseline: number,
  isBinding = false,
): string {
  const width = 118;
  const filled = Math.round((clamp(pct, 0, 100) / 100) * width);
  const barY = baseline + 12;
  return `
    <text x="13" y="${baseline}" font-family="${FONT}" font-size="16" font-weight="700"
          fill="${isBinding ? "#c9c9d4" : LABEL}" letter-spacing="1">${label}</text>
    <text x="131" y="${baseline + 2}" font-family="${FONT}" font-size="29" font-weight="700"
          fill="${colour}" text-anchor="end">${formatPct(pct)}</text>
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
function gauge(pct: number, colour: string): string {
  const cx = 72;
  const cy = 66;
  const r = 48;
  const startAngle = 135;
  const sweep = 270;
  const path = arcPath(cx, cy, r, startAngle, sweep);
  const length = (sweep / 360) * 2 * Math.PI * r;
  const filled = (clamp(pct, 0, 100) / 100) * length;

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
  const colour =
    view.tone === "crit" ? SEVERITY_COLOURS.crit
    : view.tone === "warn" ? SEVERITY_COLOURS.warn
    : "#c9c9d4";
  const hasSub = Boolean(view.subtitle);

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

function frame(body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <rect width="${SIZE}" height="${SIZE}" rx="20" fill="${BG}"/>
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
    : renderMessage(view)
  );
}
