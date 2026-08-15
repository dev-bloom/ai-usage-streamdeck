import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_THRESHOLDS,
  effectiveSeverity,
  mostSevere,
  parseRepresentativeClaim,
  severityFor,
  severityFromStatus,
} from "../.build/lib/format.js";
import { renderKeySvg } from "../.build/lib/render.js";

describe("severityFromStatus", () => {
  it("maps a clean 'allowed' to ok", () => {
    assert.equal(severityFromStatus("allowed"), "ok");
    // Case and surrounding whitespace should not matter.
    assert.equal(severityFromStatus(" Allowed "), "ok");
  });

  it("maps anything mentioning warn to warn", () => {
    assert.equal(severityFromStatus("allowed_warning"), "warn");
    assert.equal(severityFromStatus("WARN"), "warn");
  });

  it("maps rejecting values to crit", () => {
    assert.equal(severityFromStatus("rejected"), "crit");
    assert.equal(severityFromStatus("blocked"), "crit");
    assert.equal(severityFromStatus("limit_exceeded"), "crit");
  });

  it("has no opinion on missing or blank values", () => {
    assert.equal(severityFromStatus(null), null);
    assert.equal(severityFromStatus(undefined), null);
    assert.equal(severityFromStatus(""), null);
    assert.equal(severityFromStatus("   "), null);
  });

  it("has no opinion on a status it does not recognise", () => {
    // Anthropic can add a status string we have never seen; inventing a
    // severity for it would either cry wolf or hide a real problem.
    assert.equal(severityFromStatus("banana"), null);
  });

  it("reads a compound status as critical, never merely amber", () => {
    // A status carrying both a critical word and "warning" must resolve to
    // crit — being less alarming than a source suggests is the one thing
    // this mapping must never do.
    assert.equal(severityFromStatus("limit_reached_warning"), "crit");
    assert.equal(severityFromStatus("rejected_warning"), "crit");
  });
});

describe("mostSevere", () => {
  it("picks crit over warn over ok", () => {
    assert.equal(mostSevere("warn", "crit", "ok"), "crit");
    assert.equal(mostSevere("ok", "warn"), "warn");
  });

  it("ignores nulls and undefineds", () => {
    assert.equal(mostSevere(null, undefined, "warn"), "warn");
  });

  it("defaults to ok when nothing usable is passed", () => {
    assert.equal(mostSevere(), "ok");
    assert.equal(mostSevere(null, undefined), "ok");
  });
});

describe("parseRepresentativeClaim", () => {
  it("recognises the observed seven-day value", () => {
    assert.equal(parseRepresentativeClaim("seven_day"), "weekly");
  });

  it("recognises a five-hour variant", () => {
    assert.equal(parseRepresentativeClaim("five_hour"), "session");
  });

  it("returns null for unknown or absent values", () => {
    assert.equal(parseRepresentativeClaim("banana"), null);
    assert.equal(parseRepresentativeClaim(null), null);
    assert.equal(parseRepresentativeClaim(undefined), null);
  });
});

describe("effectiveSeverity", () => {
  it("respects the user's earlier warning even when the API says allowed", () => {
    // pct is above the user's warn threshold; the API must not downgrade it.
    assert.equal(effectiveSeverity(75, DEFAULT_THRESHOLDS, "allowed"), "warn");
  });

  it("lets the API escalate a key the local thresholds would call fine", () => {
    // pct is below the user's warn threshold, but Anthropic is already warning.
    assert.equal(effectiveSeverity(20, DEFAULT_THRESHOLDS, "allowed_warning"), "warn");
  });

  it("falls back to exactly what severityFor returns when the status is unrecognised", () => {
    for (const pct of [10, 75, 95]) {
      assert.equal(
        effectiveSeverity(pct, DEFAULT_THRESHOLDS, "banana"),
        severityFor(pct, DEFAULT_THRESHOLDS),
      );
    }
  });

  it("has no local threshold band for a null pct and falls back to status alone", () => {
    // A provider that doesn't report this window (Codex's secondary_window)
    // still lets the provider's own status escalate the key.
    assert.equal(effectiveSeverity(null, DEFAULT_THRESHOLDS, "limit_reached"), "crit");
    assert.equal(effectiveSeverity(null, DEFAULT_THRESHOLDS, "allowed"), "ok");
  });

  it("returns null, never 'ok', when both pct and status are missing", () => {
    // "ok" would claim a fact ("this is fine") that was never actually
    // observed — a null percentage with no status opinion means "unknown",
    // not "known and fine".
    assert.equal(effectiveSeverity(null, DEFAULT_THRESHOLDS, null), null);
    assert.equal(effectiveSeverity(null, DEFAULT_THRESHOLDS, undefined), null);
  });
});

describe("binding-window emphasis on the combined face", () => {
  const snapshot = {
    sessionPct: 40,
    weeklyPct: 60,
    sessionResetAt: new Date("2026-08-07T14:00:00Z"),
    weeklyResetAt: new Date("2026-08-10T00:00:00Z"),
    fetchedAt: new Date("2026-08-07T12:00:00Z"),
  };

  it("draws the binding window's label brighter and the other muted", () => {
    const svg = renderKeySvg({
      kind: "usage",
      mode: "both",
      snapshot: { ...snapshot, binding: "weekly" },
    });
    assert.match(svg, /fill="#c9c9d4" letter-spacing="1">7D</);
    assert.match(svg, /fill="#7d7d8a" letter-spacing="1">5H</);
  });

  it("keeps both labels muted when nothing is binding", () => {
    const svg = renderKeySvg({
      kind: "usage",
      mode: "both",
      snapshot: { ...snapshot, binding: null },
    });
    assert.match(svg, /fill="#7d7d8a" letter-spacing="1">5H</);
    assert.match(svg, /fill="#7d7d8a" letter-spacing="1">7D</);
    assert.doesNotMatch(svg, /fill="#c9c9d4" letter-spacing="1">/);
  });
});

describe("renderKey with status/binding fields", () => {
  it("never emits NaN, undefined, or null into the markup for an edge snapshot carrying them", () => {
    const snapshot = {
      sessionPct: 0,
      weeklyPct: 100,
      sessionResetAt: null,
      weeklyResetAt: null,
      fetchedAt: new Date("2026-08-07T12:00:00Z"),
      sessionStatus: undefined,
      weeklyStatus: "allowed_warning",
      binding: "weekly",
    };
    for (const mode of ["both", "session", "weekly"]) {
      const svg = renderKeySvg({ kind: "usage", mode, snapshot });
      assert.doesNotMatch(svg, /NaN|undefined|null/, `${mode} produced bad markup: ${svg}`);
      assert.match(svg.trim(), /<\/svg>$/);
    }
  });
});
