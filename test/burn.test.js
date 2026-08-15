import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_SAMPLE_AGE_MS,
  MAX_SAMPLES,
  MIN_SPAN_MS,
  burnRatePerHour,
  formatProjection,
  projectHoursToFull,
  recordSample,
} from "../.build/lib/burn.js";

describe("recordSample", () => {
  it("returns a new array and does not mutate the input", () => {
    const history = [{ at: 1000, sessionPct: 10, weeklyPct: 20 }];
    const frozen = [...history];
    const result = recordSample(history, { sessionPct: 15, weeklyPct: 25 }, 2000);

    assert.notEqual(result, history);
    assert.deepEqual(history, frozen);
    assert.equal(result.length, 2);
    assert.deepEqual(result[1], { at: 2000, sessionPct: 15, weeklyPct: 25 });
  });

  it("prunes samples older than MAX_SAMPLE_AGE_MS and caps length at MAX_SAMPLES", () => {
    const now = 10_000_000;
    // One sample just past the age cutoff, one just within it.
    const history = [
      { at: now - MAX_SAMPLE_AGE_MS - 1, sessionPct: 1, weeklyPct: 1 },
      { at: now - MAX_SAMPLE_AGE_MS + 1, sessionPct: 2, weeklyPct: 2 },
    ];
    const result = recordSample(history, { sessionPct: 3, weeklyPct: 3 }, now);
    assert.equal(result.length, 2);
    assert.equal(result[0].at, now - MAX_SAMPLE_AGE_MS + 1);
    assert.equal(result[1].at, now);

    // Capped at MAX_SAMPLES even when nothing is old enough to prune.
    let long = [];
    for (let i = 0; i < MAX_SAMPLES + 5; i++) {
      long = recordSample(long, { sessionPct: i, weeklyPct: i }, i * 1000);
    }
    assert.equal(long.length, MAX_SAMPLES);
    // The newest samples are the ones kept.
    assert.equal(long[long.length - 1].sessionPct, MAX_SAMPLES + 4);
  });
});

describe("burnRatePerHour", () => {
  it("returns null for 0 or 1 sample", () => {
    assert.equal(burnRatePerHour([], "session"), null);
    assert.equal(burnRatePerHour([{ at: 0, sessionPct: 10, weeklyPct: 10 }], "session"), null);
  });

  it("returns null when the span is under MIN_SPAN_MS", () => {
    const history = [
      { at: 0, sessionPct: 10, weeklyPct: 10 },
      { at: MIN_SPAN_MS - 1, sessionPct: 20, weeklyPct: 20 },
    ];
    assert.equal(burnRatePerHour(history, "session"), null);
  });

  it("computes a correct positive rate for a clean case", () => {
    // 10% -> 20% over 2h == 5 pct/hour.
    const history = [
      { at: 0, sessionPct: 10, weeklyPct: 10 },
      { at: 2 * 60 * 60 * 1000, sessionPct: 20, weeklyPct: 20 },
    ];
    assert.equal(burnRatePerHour(history, "session"), 5);
    assert.equal(burnRatePerHour(history, "weekly"), 5);
  });

  it("returns a negative number when utilisation decayed", () => {
    // 40% -> 20% over 2h == -10 pct/hour: the rolling window aged usage out.
    const history = [
      { at: 0, sessionPct: 40, weeklyPct: 40 },
      { at: 2 * 60 * 60 * 1000, sessionPct: 20, weeklyPct: 20 },
    ];
    assert.equal(burnRatePerHour(history, "session"), -10);
  });

  it("returns null rather than a rate when either sample's pct is null", () => {
    // A provider that never reports this window (Codex's secondary_window)
    // leaves every sample null; there is no rate to compute from data that
    // was never observed, and treating null as 0 would fabricate a slope.
    const oldestMissing = [
      { at: 0, sessionPct: null, weeklyPct: 40 },
      { at: 2 * 60 * 60 * 1000, sessionPct: 30, weeklyPct: 20 },
    ];
    assert.equal(burnRatePerHour(oldestMissing, "session"), null);

    const newestMissing = [
      { at: 0, sessionPct: 30, weeklyPct: 40 },
      { at: 2 * 60 * 60 * 1000, sessionPct: null, weeklyPct: 20 },
    ];
    assert.equal(burnRatePerHour(newestMissing, "session"), null);

    // The other window still computes fine — nulls in one window must not
    // poison the other.
    assert.equal(burnRatePerHour(oldestMissing, "weekly"), -10);
  });
});

describe("projectHoursToFull", () => {
  const now = new Date("2026-08-07T12:00:00Z");

  it("returns null when the rate is <= 0", () => {
    // Flat.
    const flat = [
      { at: 0, sessionPct: 30, weeklyPct: 30 },
      { at: 2 * 60 * 60 * 1000, sessionPct: 30, weeklyPct: 30 },
    ];
    assert.equal(projectHoursToFull(flat, "session", 30, null, now), null);

    // Falling.
    const falling = [
      { at: 0, sessionPct: 40, weeklyPct: 40 },
      { at: 2 * 60 * 60 * 1000, sessionPct: 20, weeklyPct: 20 },
    ];
    assert.equal(projectHoursToFull(falling, "session", 20, null, now), null);
  });

  it("returns null when the window resets before it would fill", () => {
    // Growing 5 pct/hour, at 50% -> 10h to fill, but resets in 2h.
    const history = [
      { at: 0, sessionPct: 40, weeklyPct: 40 },
      { at: 2 * 60 * 60 * 1000, sessionPct: 50, weeklyPct: 50 },
    ];
    const resetAt = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    assert.equal(projectHoursToFull(history, "session", 50, resetAt, now), null);
  });

  it("returns a correct value when it genuinely fills first", () => {
    // Growing 5 pct/hour, at 50% -> 10h to fill; resets in 20h, well after.
    const history = [
      { at: 0, sessionPct: 40, weeklyPct: 40 },
      { at: 2 * 60 * 60 * 1000, sessionPct: 50, weeklyPct: 50 },
    ];
    const resetAt = new Date(now.getTime() + 20 * 60 * 60 * 1000);
    assert.equal(projectHoursToFull(history, "session", 50, resetAt, now), 10);

    // Also correct with no known reset time at all.
    assert.equal(projectHoursToFull(history, "session", 50, null, now), 10);
  });

  it("returns null when currentPct itself is null, without even looking at the rate", () => {
    // Nothing to project towards when the provider isn't reporting this
    // window — there is no "currently at" value, so no "fills in Xh" claim.
    const growing = [
      { at: 0, sessionPct: 40, weeklyPct: 40 },
      { at: 2 * 60 * 60 * 1000, sessionPct: 50, weeklyPct: 50 },
    ];
    assert.equal(projectHoursToFull(growing, "session", null, null, now), null);
  });
});

describe("formatProjection", () => {
  it("covers the <1h branch", () => {
    assert.equal(formatProjection(0.5), "FULL <1h");
    assert.equal(formatProjection(0.99), "FULL <1h");
  });

  it("covers the hours branch", () => {
    assert.equal(formatProjection(3), "FULL IN 3h");
    assert.equal(formatProjection(3.4), "FULL IN 3h");
    assert.equal(formatProjection(23.4), "FULL IN 23h");
  });

  it("covers the days branch", () => {
    assert.equal(formatProjection(48), "FULL IN 2d");
    assert.equal(formatProjection(25), "FULL IN 1d");
  });
});
