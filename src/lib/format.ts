/**
 * Small pure helpers shared by the renderer and the action.
 * Kept dependency-free so they can be unit-tested without the Stream Deck SDK.
 */

export type Severity = "ok" | "warn" | "crit";

export type Thresholds = {
  /** Percentage at or above which the key turns amber. */
  warn: number;
  /** Percentage at or above which the key turns red. */
  crit: number;
};

export const DEFAULT_THRESHOLDS: Thresholds = { warn: 70, crit: 90 };

/**
 * Map a 0..100 utilisation percentage onto a severity band.
 *
 * Comparisons are inclusive at the lower edge so a threshold of 90 means
 * "90% is already critical", which is what people expect when they type 90
 * into the settings box.
 */
export function severityFor(pct: number, t: Thresholds = DEFAULT_THRESHOLDS): Severity {
  if (pct >= t.crit) return "crit";
  if (pct >= t.warn) return "warn";
  return "ok";
}

/** The colour ramp. Tuned to stay legible against the dark key background. */
export const SEVERITY_COLOURS: Record<Severity, string> = {
  ok: "#4ade80",
  warn: "#fbbf24",
  crit: "#f87171",
};

/**
 * Format the gap between now and a reset timestamp as a compact countdown.
 *
 * Deliberately lossy: on a 72px key there is room for roughly six characters,
 * so we drop to the two most significant units ("2h14m", "3d 4h", "47m").
 * Returns null when there is nothing useful to show, which the renderer takes
 * as "omit the footer line entirely" rather than printing a placeholder.
 */
export function formatCountdown(resetAt: Date | null, now: Date = new Date()): string | null {
  if (resetAt === null) return null;
  const ms = resetAt.getTime() - now.getTime();
  // A reset in the past means our snapshot straddled the rollover. The next
  // poll will correct it; showing "0m" for a few seconds beats showing a
  // negative number or stale future time.
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return "now";

  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${minutes.toString().padStart(2, "0")}m`;
  return `${minutes}m`;
}

/**
 * Round a percentage for display.
 *
 * Floors rather than rounds: showing "100%" while a request would still
 * succeed is more alarming than useful, so 99.6% reads as 99% and only a
 * true 100 reads as 100.
 */
export function formatPct(pct: number): string {
  // Via clamp() rather than Math.min/max directly: those propagate NaN, which
  // would put the literal text "NaN%" on the key.
  return `${Math.floor(clamp(pct, 0, 100))}%`;
}

/** Clamp a number into a range, tolerating NaN by falling back to `lo`. */
export function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Map Anthropic's own per-window status string onto a severity, or null.
 *
 * Null means "no opinion" and is deliberate, not an oversight: Anthropic can
 * introduce a status string we have never seen (they already went from a
 * boolean-ish "allowed" to graded strings like "allowed_warning"), and
 * guessing a severity for an unrecognised value would either cry wolf on
 * something benign or hide a real enforcement change. Null tells the caller
 * to fall back to the local threshold bands, which is exactly today's
 * behaviour and therefore always a safe default.
 */
export function severityFromStatus(raw: string | null | undefined): Severity | null {
  if (raw === null || raw === undefined) return null;
  const s = raw.trim().toLowerCase();
  if (s === "") return null;
  if (s === "allowed") return "ok";
  // Critical words are tested before "warn" so a compound status such as
  // "limit_reached_warning" reads as critical rather than merely amber. The
  // rule everywhere in this file is that we are never *less* alarming than a
  // source suggests, and matching "warn" first would break it.
  if (["reject", "block", "exceed", "deny", "denied", "limit"].some((w) => s.includes(w))) {
    return "crit";
  }
  if (s.includes("warn")) return "warn";
  return null;
}

/**
 * Pick the most severe of several severities, ignoring absent ones.
 *
 * Defaults to "ok" when nothing usable was passed, matching the meaning of
 * an empty input: no evidence of a problem.
 */
export function mostSevere(...severities: Array<Severity | null | undefined>): Severity {
  const order: Severity[] = ["crit", "warn", "ok"];
  for (const candidate of order) {
    if (severities.includes(candidate)) return candidate;
  }
  return "ok";
}

/** Which window Anthropic currently treats as binding, or null if unknown. */
export type BindingWindow = "session" | "weekly" | null;

/**
 * Parse Anthropic's "representative claim" header, which names the window it
 * considers binding right now (observed value: "seven_day").
 */
export function parseRepresentativeClaim(raw: string | null | undefined): BindingWindow {
  if (raw === null || raw === undefined) return null;
  const s = raw.trim().toLowerCase();
  if (s === "") return null;
  if (s.includes("seven") || s.includes("7")) return "weekly";
  if (s.includes("five") || s.includes("5")) return "session";
  return null;
}

/**
 * The severity actually shown on a key: the more severe of the user's local
 * threshold band and the provider's own status for that window.
 *
 * The API's status is authoritative about what will actually be enforced,
 * but the user's sliders exist precisely so they can be warned EARLIER than
 * the provider would warn them. Taking the more severe of the two honours
 * both — the key is never less alarming than either source thinks it should
 * be. Never take only one: that would either ignore the user's own warning
 * preference or ignore what the provider is about to do.
 *
 * `pct` is nullable because some providers don't report every window (Codex
 * leaves `secondary_window` out entirely rather than reporting it at 0). A
 * null pct has no threshold band to compare against, so this falls back to
 * the provider's status alone — and if that has no opinion either, the
 * result is null, not "ok": "ok" would claim a fact ("this is fine") the
 * caller never actually observed. Every existing call site passed a number
 * before this change, so Claude's output is bit-for-bit unchanged.
 */
export function effectiveSeverity(
  pct: number | null,
  t: Thresholds,
  status: string | null | undefined,
): Severity | null {
  const fromStatus = severityFromStatus(status);
  const fromPct = pct === null ? null : severityFor(pct, t);
  if (fromStatus === null && fromPct === null) return null;
  return mostSevere(fromStatus, fromPct);
}
