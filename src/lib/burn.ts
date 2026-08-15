/**
 * Burn-rate projection: "will I run out before this window resets?" answered
 * purely from observed samples. No Stream Deck imports, no timers — the store
 * feeds this a running history and the view layer decides whether the result
 * is worth drawing.
 */

export type Sample = { at: number; sessionPct: number | null; weeklyPct: number | null };
export type BurnWindow = "session" | "weekly";

export const MAX_SAMPLES = 40;
export const MAX_SAMPLE_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours
export const MIN_SPAN_MS = 120_000; // 2 minutes

/**
 * Append a sample and prune the history, returning a new array.
 *
 * Pruning by both age and count keeps the slope in burnRatePerHour honest: a
 * six-hour-old sample says nothing about the current rate, and an unbounded
 * array would otherwise grow for as long as the plugin keeps polling.
 */
export function recordSample(
  history: Sample[],
  snapshot: { sessionPct: number | null; weeklyPct: number | null },
  at: number,
): Sample[] {
  const appended: Sample[] = [
    ...history,
    { at, sessionPct: snapshot.sessionPct, weeklyPct: snapshot.weeklyPct },
  ];
  const cutoff = at - MAX_SAMPLE_AGE_MS;
  return appended.filter((s) => s.at >= cutoff).slice(-MAX_SAMPLES);
}

/**
 * Percentage points per hour, measured from the oldest to the newest
 * retained sample.
 *
 * Requires a minimum span between the two samples: two polls seconds apart
 * produce a wildly noisy slope — a tiny denominator turns any jitter in the
 * percentage reading into an enormous rate — which would swing the
 * projection between "safe" and "imminent" on every tick.
 */
export function burnRatePerHour(history: Sample[], window: BurnWindow): number | null {
  if (history.length < 2) return null;
  const oldest = history[0];
  const newest = history[history.length - 1];
  if (!oldest || !newest) return null;

  const spanMs = newest.at - oldest.at;
  if (spanMs < MIN_SPAN_MS) return null;

  const oldestPct = window === "session" ? oldest.sessionPct : oldest.weeklyPct;
  const newestPct = window === "session" ? newest.sessionPct : newest.weeklyPct;
  // A provider that doesn't report this window at all (Codex's
  // secondary_window, typically) leaves pct null on every sample. There is
  // no rate to compute from a window that was never observed, and treating
  // null as 0 would fabricate a slope — usually a steep, wrong one — out of
  // missing data.
  if (oldestPct === null || newestPct === null) return null;

  const spanHours = spanMs / 3_600_000;
  return (newestPct - oldestPct) / spanHours;
}

/**
 * Hours until `window` reaches 100% at the current burn rate, but only when
 * that is actually worth saying.
 */
export function projectHoursToFull(
  history: Sample[],
  window: BurnWindow,
  currentPct: number | null,
  resetAt: Date | null,
  now: Date,
): number | null {
  // Nothing to project towards when the provider isn't reporting this
  // window at all — there is no "currently at" value, so there is no "fills
  // in" claim to make either.
  if (currentPct === null) return null;

  const rate = burnRatePerHour(history, window);
  if (rate === null) return null;

  // Both windows are rolling, so utilisation naturally decays as old usage
  // ages out of the window — a flat or falling reading is the normal,
  // healthy case, not a sign of anything to project. Only genuine growth
  // (rate > 0) is worth turning into a "fills in Xh" claim.
  if (rate <= 0) return null;

  if (currentPct >= 100) return null;

  const hours = (100 - currentPct) / rate;
  if (hours <= 0) return null;

  // A projection that arrives after the window has already reset on its own
  // is not a real deadline — the reset defuses it first, so there is nothing
  // to warn about.
  if (resetAt !== null) {
    const hoursToReset = (resetAt.getTime() - now.getTime()) / 3_600_000;
    if (hoursToReset < hours) return null;
  }

  return hours;
}

/**
 * Compact rendering for a 72px key: "FULL <1h", "FULL IN 3h", "FULL IN 2d".
 */
export function formatProjection(hours: number): string {
  if (hours < 1) return "FULL <1h";
  if (hours < 24) return `FULL IN ${Math.round(hours)}h`;
  return `FULL IN ${Math.round(hours / 24)}d`;
}
