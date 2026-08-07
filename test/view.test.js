import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_THRESHOLDS } from "../.build/lib/format.js";
import { renderKey, renderKeySvg } from "../.build/lib/render.js";
import { thresholdsFrom, viewFor } from "../.build/lib/view.js";

const snapshot = {
  sessionPct: 40,
  weeklyPct: 60,
  sessionResetAt: new Date("2026-08-07T14:00:00Z"),
  weeklyResetAt: new Date("2026-08-10T00:00:00Z"),
  fetchedAt: new Date("2026-08-07T12:00:00Z"),
};

describe("viewFor", () => {
  it("shows a loading card before the first reading", () => {
    const view = viewFor({ status: "loading" }, {});
    assert.equal(view.kind, "message");
    assert.equal(view.subtitle, "loading");
  });

  it("defaults to showing both windows", () => {
    const view = viewFor({ status: "ok", snapshot }, {});
    assert.equal(view.kind, "usage");
    assert.equal(view.mode, "both");
  });

  it("distinguishes never-signed-in from an expired token", () => {
    const signedOut = viewFor(
      { status: "fail", failure: { kind: "signed-out", message: "x" } }, {},
    );
    assert.equal(signedOut.title, "SIGN IN");

    const stale = viewFor({ status: "fail", failure: { kind: "stale", message: "x" } }, {});
    assert.equal(stale.title, "EXPIRED");
  });

  it("keeps showing the last good numbers through a transient error", () => {
    // A dropped wifi packet should not blank out numbers mid-glance.
    const view = viewFor(
      { status: "fail", failure: { kind: "error", message: "ECONNRESET" }, lastGood: snapshot },
      { mode: "weekly" },
    );
    assert.equal(view.kind, "usage");
    assert.equal(view.mode, "weekly");
    assert.equal(view.snapshot.weeklyPct, 60);
  });

  it("falls back to an error card when there is no prior reading", () => {
    const view = viewFor(
      { status: "fail", failure: { kind: "error", message: "ECONNRESET" } }, {},
    );
    assert.equal(view.kind, "message");
    assert.equal(view.title, "ERROR");
  });

  it("returns the resets screen when peeking with a good reading", () => {
    const view = viewFor({ status: "ok", snapshot }, {}, true);
    assert.equal(view.kind, "resets");
    assert.equal(view.snapshot.weeklyPct, 60);
  });

  it("carries the key's mode into the peek, so it shows only what the key shows", () => {
    for (const mode of ["both", "session", "weekly"]) {
      const view = viewFor({ status: "ok", snapshot }, { mode }, true);
      assert.equal(view.kind, "resets");
      assert.equal(view.mode, mode);
    }
    // An unset mode peeks as the default combined face rather than guessing.
    assert.equal(viewFor({ status: "ok", snapshot }, {}, true).mode, "both");
  });

  it("falls back to the resets view built from lastGood on a warm error while peeking", () => {
    const view = viewFor(
      { status: "fail", failure: { kind: "error", message: "ECONNRESET" }, lastGood: snapshot },
      {},
      true,
    );
    assert.equal(view.kind, "resets");
    assert.equal(view.snapshot.sessionPct, 40);
  });

  it("ignores a peek while loading — there is nothing to show yet", () => {
    const view = viewFor({ status: "loading" }, {}, true);
    assert.equal(view.kind, "message");
    assert.equal(view.subtitle, "loading");
  });

  it("ignores a peek while signed out — the sign-in card wins", () => {
    const view = viewFor(
      { status: "fail", failure: { kind: "signed-out", message: "x" } }, {}, true,
    );
    assert.equal(view.kind, "message");
    assert.equal(view.title, "SIGN IN");
  });

  it("ignores a peek on a cold error with no lastGood", () => {
    const view = viewFor(
      { status: "fail", failure: { kind: "error", message: "ECONNRESET" } }, {}, true,
    );
    assert.equal(view.kind, "message");
    assert.equal(view.title, "ERROR");
  });

  it("computes projectionHours from history on a single-window peek", () => {
    const now = new Date("2026-08-07T14:00:00Z");
    // Weekly climbing 5 pct/hour over 2h, resetting well after it would fill.
    const history = [
      { at: now.getTime() - 2 * 60 * 60 * 1000, sessionPct: 40, weeklyPct: 50 },
      { at: now.getTime(), sessionPct: 40, weeklyPct: 60 },
    ];
    const state = { status: "ok", snapshot: { ...snapshot, weeklyPct: 60 }, history };
    const view = viewFor(state, { mode: "weekly" }, true, now);
    assert.equal(view.kind, "resets");
    // (100 - 60) / 5 = 8 hours to fill.
    assert.equal(view.projectionHours, 8);
  });

  it("leaves projectionHours undefined on the combined 'both' peek", () => {
    const now = new Date("2026-08-07T14:00:00Z");
    const history = [
      { at: now.getTime() - 2 * 60 * 60 * 1000, sessionPct: 40, weeklyPct: 50 },
      { at: now.getTime(), sessionPct: 40, weeklyPct: 60 },
    ];
    const state = { status: "ok", snapshot: { ...snapshot, weeklyPct: 60 }, history };
    const view = viewFor(state, { mode: "both" }, true, now);
    assert.equal(view.kind, "resets");
    assert.equal(view.projectionHours, undefined);
  });
});

describe("thresholdsFrom", () => {
  it("accepts a sane pair", () => {
    assert.deepEqual(thresholdsFrom({ warnAt: 50, critAt: 80 }), { warn: 50, crit: 80 });
  });

  it("rejects an inverted pair rather than drawing an unreachable band", () => {
    assert.deepEqual(thresholdsFrom({ warnAt: 90, critAt: 70 }), DEFAULT_THRESHOLDS);
    assert.deepEqual(thresholdsFrom({ warnAt: 80, critAt: 80 }), DEFAULT_THRESHOLDS);
  });

  it("rejects out-of-range and missing values", () => {
    assert.deepEqual(thresholdsFrom({ warnAt: -5, critAt: 80 }), DEFAULT_THRESHOLDS);
    assert.deepEqual(thresholdsFrom({ warnAt: 50, critAt: 140 }), DEFAULT_THRESHOLDS);
    assert.deepEqual(thresholdsFrom({}), DEFAULT_THRESHOLDS);
  });

  it("coerces the strings the property inspector actually sends", () => {
    // sdpi-range hands back strings, not numbers.
    assert.deepEqual(thresholdsFrom({ warnAt: "60", critAt: "85" }), { warn: 60, crit: 85 });
  });
});

describe("renderKey", () => {
  const modes = ["both", "session", "weekly"];
  const edgeSnapshots = [
    { ...snapshot, sessionPct: 0, weeklyPct: 0 },
    { ...snapshot, sessionPct: 100, weeklyPct: 100 },
    { ...snapshot, sessionResetAt: null, weeklyResetAt: null },
    { ...snapshot, sessionPct: Number.NaN, weeklyPct: Number.NaN },
  ];

  it("emits a base64 SVG data URI", () => {
    const uri = renderKey({ kind: "usage", mode: "both", snapshot });
    assert.match(uri, /^data:image\/svg\+xml;base64,/);
    const decoded = Buffer.from(uri.split(",")[1], "base64").toString("utf-8");
    assert.match(decoded, /^<svg /);
  });

  it("never emits NaN, undefined, or null into the markup", () => {
    for (const mode of modes) {
      for (const snap of edgeSnapshots) {
        const svg = renderKeySvg({ kind: "usage", mode, snapshot: snap });
        assert.doesNotMatch(svg, /NaN|undefined|null/, `${mode} produced bad markup: ${svg}`);
        assert.match(svg.trim(), /<\/svg>$/);
      }
    }
    for (const mode of modes) {
      for (const snap of edgeSnapshots) {
        const svg = renderKeySvg({ kind: "resets", mode, snapshot: snap });
        assert.doesNotMatch(svg, /NaN|undefined|null/, `resets ${mode} produced bad markup: ${svg}`);
        assert.match(svg.trim(), /<\/svg>$/);
      }
    }
    // Same sweep, but carrying a projectionHours value (including edge values
    // like NaN/0) so the new bottom line can't sneak bad markup through.
    // `now` is fixed so a pass/fail never depends on where the promo-notice
    // window falls relative to the real wall clock.
    const fixedNow = new Date("2026-08-07T12:00:00Z");
    for (const mode of modes) {
      for (const projectionHours of [3, 0, Number.NaN, null, undefined]) {
        for (const snap of edgeSnapshots) {
          const svg = renderKeySvg({
            kind: "resets",
            mode,
            snapshot: snap,
            projectionHours,
            now: fixedNow,
          });
          assert.doesNotMatch(
            svg,
            /NaN|undefined|null/,
            `resets ${mode} projectionHours=${projectionHours} produced bad markup: ${svg}`,
          );
          assert.match(svg.trim(), /<\/svg>$/);
        }
      }
    }
  });

  it("renders a resets screen with both windows' countdowns", () => {
    const uri = renderKey({
      kind: "resets",
      mode: "both",
      snapshot,
      now: new Date("2026-08-07T12:00:00Z"),
    });
    assert.match(uri, /^data:image\/svg\+xml;base64,/);
    const decoded = Buffer.from(uri.split(",")[1], "base64").toString("utf-8");
    assert.match(decoded, /^<svg /);
    // sessionResetAt is 2h away, weeklyResetAt is a couple of days away.
    assert.match(decoded, />2h00m</);
    assert.match(decoded, />2d12h</);
  });

  it("shows only the session countdown when the key is in 5-hour mode", () => {
    const svg = renderKeySvg({
      kind: "resets",
      mode: "session",
      snapshot,
      now: new Date("2026-08-07T12:00:00Z"),
    });
    assert.match(svg, />2h00m</, "expected the session countdown");
    assert.doesNotMatch(svg, />2d12h</, "weekly countdown must not appear in session mode");
    assert.match(svg, />5-HOUR</);
  });

  it("shows only the weekly countdown when the key is in weekly mode", () => {
    const svg = renderKeySvg({
      kind: "resets",
      mode: "weekly",
      snapshot,
      now: new Date("2026-08-07T12:00:00Z"),
    });
    assert.match(svg, />2d12h</, "expected the weekly countdown");
    assert.doesNotMatch(svg, />2h00m</, "session countdown must not appear in weekly mode");
    assert.match(svg, />WEEKLY</);
  });

  it("renders an em dash, never the literal 'null', when a reset time is missing", () => {
    for (const mode of modes) {
      const svg = renderKeySvg({
        kind: "resets",
        mode,
        snapshot: { ...snapshot, sessionResetAt: null, weeklyResetAt: null },
      });
      assert.doesNotMatch(svg, /null/);
      assert.match(svg, />—</);
    }
  });

  it("no longer shows a countdown on the both-mode face", () => {
    const svg = renderKeySvg({ kind: "usage", mode: "both", snapshot });
    assert.doesNotMatch(svg, /↺/);
    assert.doesNotMatch(svg, /2h00m|2d12h/);
  });

  it("escapes text in message cards", () => {
    const svg = renderKeySvg({ kind: "message", title: "a<b&c", subtitle: '"quoted"' });
    assert.match(svg, /a&lt;b&amp;c/);
    assert.doesNotMatch(svg, /a<b&c/);
  });

  it("colours each window independently in combined mode", () => {
    // Session healthy, weekly critical: both colours must appear.
    const svg = renderKeySvg({
      kind: "usage",
      mode: "both",
      snapshot: { ...snapshot, sessionPct: 10, weeklyPct: 95 },
    });
    assert.match(svg, /#4ade80/);
    assert.match(svg, /#f87171/);
  });

  describe("the resets bottom line", () => {
    // Inside the +50% promo window (WEEKLY_BOOST_ENDS_AT is 2026-08-20).
    const promoNow = new Date("2026-08-15T12:00:00Z");

    it("renders the projection line on the single-window weekly peek when projectionHours is set", () => {
      const svg = renderKeySvg({
        kind: "resets",
        mode: "weekly",
        snapshot,
        projectionHours: 3,
        now: promoNow,
      });
      assert.match(svg, />FULL IN 3h</);
    });

    it("lets the projection take priority over the boost notice when both apply", () => {
      const svg = renderKeySvg({
        kind: "resets",
        mode: "weekly",
        snapshot,
        projectionHours: 3,
        now: promoNow,
      });
      assert.match(svg, />FULL IN 3h</);
      assert.doesNotMatch(svg, /\+50%/);
    });

    it("falls back to the boost notice when there is no projection, on weekly mode only", () => {
      const weekly = renderKeySvg({
        kind: "resets",
        mode: "weekly",
        snapshot,
        projectionHours: null,
        now: promoNow,
      });
      assert.match(weekly, /\+50%/);

      // Session mode never shows the promo notice — it only affects the
      // weekly cap.
      const session = renderKeySvg({
        kind: "resets",
        mode: "session",
        snapshot,
        projectionHours: null,
        now: promoNow,
      });
      assert.doesNotMatch(session, /\+50%/);
    });

    it("renders neither line on the two-row 'both' peek, whatever is passed", () => {
      const svg = renderKeySvg({
        kind: "resets",
        mode: "both",
        snapshot,
        projectionHours: 3,
        now: promoNow,
      });
      assert.doesNotMatch(svg, /FULL/);
      assert.doesNotMatch(svg, /\+50%/);
    });
  });
});
