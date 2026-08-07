import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_THRESHOLDS,
  clamp,
  formatCountdown,
  formatPct,
  severityFor,
} from "../.build/lib/format.js";

describe("severityFor", () => {
  it("bands a percentage against the defaults", () => {
    assert.equal(severityFor(0), "ok");
    assert.equal(severityFor(69.9), "ok");
    assert.equal(severityFor(75), "warn");
    assert.equal(severityFor(95), "crit");
  });

  it("treats each threshold as inclusive at its lower edge", () => {
    // Typing 90 into the settings box should mean "90 is already red".
    assert.equal(severityFor(70, DEFAULT_THRESHOLDS), "warn");
    assert.equal(severityFor(90, DEFAULT_THRESHOLDS), "crit");
  });

  it("honours custom thresholds", () => {
    const t = { warn: 50, crit: 80 };
    assert.equal(severityFor(49, t), "ok");
    assert.equal(severityFor(50, t), "warn");
    assert.equal(severityFor(80, t), "crit");
  });
});

describe("formatCountdown", () => {
  const now = new Date("2026-08-07T12:00:00Z");
  const inMs = (ms) => new Date(now.getTime() + ms);

  it("returns null when there is no reset timestamp", () => {
    assert.equal(formatCountdown(null, now), null);
  });

  it("formats minutes under an hour", () => {
    assert.equal(formatCountdown(inMs(47 * 60_000), now), "47m");
    assert.equal(formatCountdown(inMs(60_000), now), "1m");
  });

  it("zero-pads minutes when hours are shown", () => {
    // "2h4m" reads as twenty-four minutes at a glance; "2h04m" does not.
    assert.equal(formatCountdown(inMs((2 * 60 + 4) * 60_000), now), "2h04m");
    assert.equal(formatCountdown(inMs((2 * 60 + 14) * 60_000), now), "2h14m");
  });

  it("drops to days and hours past 24h", () => {
    assert.equal(formatCountdown(inMs(3 * 1440 * 60_000 + 3 * 3600_000), now), "3d3h");
  });

  it("collapses a reset that has already passed", () => {
    // Snapshots straddle the rollover; showing a negative number would be worse.
    assert.equal(formatCountdown(inMs(-5000), now), "now");
    assert.equal(formatCountdown(inMs(0), now), "now");
  });

  it("survives an invalid date", () => {
    assert.equal(formatCountdown(new Date("nonsense"), now), null);
  });
});

describe("formatPct", () => {
  it("floors rather than rounds", () => {
    // 99.6% must not read as 100% while requests would still succeed.
    assert.equal(formatPct(99.6), "99%");
    assert.equal(formatPct(100), "100%");
    assert.equal(formatPct(0.4), "0%");
  });

  it("clamps out-of-range input", () => {
    assert.equal(formatPct(-10), "0%");
    assert.equal(formatPct(140), "100%");
  });
});

describe("clamp", () => {
  it("falls back to the low bound on NaN", () => {
    assert.equal(clamp(Number.NaN, 5, 10), 5);
    assert.equal(clamp(7, 5, 10), 7);
    assert.equal(clamp(99, 5, 10), 10);
  });
});
