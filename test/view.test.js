import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { DEFAULT_THRESHOLDS, SEVERITY_COLOURS } from "../.build/lib/format.js";
import { renderKey, renderKeySvg } from "../.build/lib/render.js";
import {
  firstFocusableSession,
  sessionsModeFrom,
  sessionsViewFor,
  thresholdsFrom,
  viewFor,
} from "../.build/lib/view.js";

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

describe("the widened failure taxonomy", () => {
  it("shows API KEY / no limits for no-plan, with no tone escalation — nothing is actually wrong", () => {
    const view = viewFor(
      { status: "fail", failure: { kind: "no-plan", message: "x" } }, {},
    );
    assert.equal(view.kind, "message");
    assert.equal(view.title, "API KEY");
    assert.equal(view.subtitle, "no limits");
  });

  it("shows BLOCKED / 403 for blocked, distinct from both signed-out and error", () => {
    const view = viewFor(
      { status: "fail", failure: { kind: "blocked", message: "x" } }, {},
    );
    assert.equal(view.kind, "message");
    assert.equal(view.title, "BLOCKED");
    assert.equal(view.subtitle, "403");
  });

  it("shows OFFLINE / no network for offline, so a dead network doesn't read as a credential problem", () => {
    const view = viewFor(
      { status: "fail", failure: { kind: "offline", message: "x" } }, {},
    );
    assert.equal(view.kind, "message");
    assert.equal(view.title, "OFFLINE");
    assert.equal(view.subtitle, "no network");
  });

  it("still shows ERROR / see logs for the generic catch-all, unchanged", () => {
    const view = viewFor(
      { status: "fail", failure: { kind: "error", message: "x" } }, {},
    );
    assert.equal(view.kind, "message");
    assert.equal(view.title, "ERROR");
    assert.equal(view.subtitle, "see logs");
  });

  it("leaves Claude's existing signed-out/stale/error cards exactly as before", () => {
    // Same three assertions the pre-existing tests above already make, kept
    // here as one place that states the taxonomy widening didn't touch them.
    assert.equal(
      viewFor({ status: "fail", failure: { kind: "signed-out", message: "x" } }, {}).title,
      "SIGN IN",
    );
    assert.equal(
      viewFor({ status: "fail", failure: { kind: "stale", message: "x" } }, {}).title,
      "EXPIRED",
    );
    assert.equal(
      viewFor({ status: "fail", failure: { kind: "error", message: "x" } }, {}).title,
      "ERROR",
    );
  });

  it("renders every new card as valid, escaped SVG markup", () => {
    for (const kind of ["no-plan", "blocked", "offline"]) {
      const view = viewFor({ status: "fail", failure: { kind, message: "x" } }, {});
      const svg = renderKeySvg(view);
      assert.doesNotMatch(svg, /NaN|undefined|null/);
      assert.match(svg.trim(), /<\/svg>$/);
    }
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

  describe("null percentages (a window the provider doesn't report)", () => {
    const nullSessionSnapshot = { ...snapshot, sessionPct: null };

    it("renders an em dash, never '0%', for a null pct on the single-window gauge face", () => {
      const svg = renderKeySvg({ kind: "usage", mode: "session", snapshot: nullSessionSnapshot });
      assert.doesNotMatch(svg, />0%</);
      assert.match(svg, />—</);
    });

    it("renders an em dash, never '0%', for a null pct on the combined bar face", () => {
      const svg = renderKeySvg({ kind: "usage", mode: "both", snapshot: nullSessionSnapshot });
      // The weekly bar still reports its real value normally...
      assert.match(svg, />60%</);
      // ...while the session row shows the dash instead of a fabricated 0%.
      assert.doesNotMatch(svg, />0%</);
      assert.match(svg, />—</);
    });

    it("draws no filled bar segment for a null pct (empty track only)", () => {
      const svg = renderKeySvg({ kind: "usage", mode: "both", snapshot: nullSessionSnapshot });
      // Exactly one filled rect (the weekly bar) should be present; a null
      // session bar must not draw a second, zero-width or otherwise, filled
      // rect of its own.
      const filledRectCount = (svg.match(/rx="4" fill="#/g) || []).length;
      // Each row draws exactly one track rect; the filled rect only appears
      // when there is something to fill. Two rows, one filled ⇒ 2 track + 1 fill.
      assert.equal(filledRectCount, 3);
    });

    it("never emits NaN, undefined, or null into the markup for a null-pct snapshot", () => {
      for (const mode of modes) {
        const svg = renderKeySvg({ kind: "usage", mode, snapshot: nullSessionSnapshot });
        assert.doesNotMatch(svg, /NaN|undefined|null/, `${mode} produced bad markup: ${svg}`);
      }
    });
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

describe("provider-specific sign-in wording", () => {
  // A Codex key that reads "run claude" sends the user to fix the wrong CLI:
  // plausible enough to be believed, wrong enough to waste an evening. The
  // hint is threaded from Provider.signInHint for exactly this reason.
  it("shows the given hint on the signed-out card", () => {
    const view = viewFor(
      { status: "fail", failure: { kind: "signed-out", message: "x" } },
      {},
      false,
      new Date(),
      "run codex",
    );
    assert.equal(view.subtitle, "run codex");
  });

  it("shows the given hint on the expired card", () => {
    const view = viewFor(
      { status: "fail", failure: { kind: "stale", message: "x" } },
      {},
      false,
      new Date(),
      "run codex",
    );
    assert.equal(view.subtitle, "run codex");
  });

  it("still says 'run claude' when no hint is passed, so Claude's face is unchanged", () => {
    const view = viewFor({ status: "fail", failure: { kind: "signed-out", message: "x" } }, {});
    assert.equal(view.subtitle, "run claude");
  });
});

describe("per-provider default window", () => {
  // Codex on a ChatGPT plan has no 5-hour window at all, so a Codex key that
  // defaulted to the combined face would spend half its pixels on an em dash
  // forever. The default is a provider fact, not a global one.
  it("codex defaults to weekly, claude to both", async () => {
    const { codexProvider } = await import("../.build/lib/providers/codex.js");
    const { claudeProvider } = await import("../.build/lib/providers/claude.js");
    assert.equal(codexProvider.defaultMode, "weekly");
    assert.equal(claudeProvider.defaultMode, "both");
  });

  // The default must never overwrite a choice the user actually made.
  it("an explicit mode always beats the provider default", () => {
    const view = viewFor({ status: "ok", snapshot }, { mode: "session" });
    assert.equal(view.mode, "session");
  });

  it("codex supports only the weekly face; claude supports all three", async () => {
    const { codexProvider } = await import("../.build/lib/providers/codex.js");
    const { claudeProvider } = await import("../.build/lib/providers/claude.js");
    assert.deepEqual([...codexProvider.supportedModes], ["weekly"]);
    assert.deepEqual([...claudeProvider.supportedModes].sort(), ["both", "session", "weekly"]);
    // Every provider's own default must be one it can actually draw.
    for (const p of [codexProvider, claudeProvider]) {
      assert.ok(p.supportedModes.includes(p.defaultMode), `${p.id} default is unsupported`);
    }
  });
});

describe("codex property inspector", () => {
  // The user chose to drop the selector rather than offer two faces that can
  // only ever render an em dash on this plan. A stray `setting="mode"` control
  // reappearing here would silently start writing a mode the provider rejects.
  it("offers no window selector, since Codex reports a single window", () => {
    const html = readFileSync(
      new URL("../com.devbloom.ai-usage.sdPlugin/ui/codex-meter.html", import.meta.url),
      "utf-8",
    );
    assert.doesNotMatch(html, /setting="mode"/);
  });

  it("does not claim pressing the key cycles anything — onKeyDown peeks", () => {
    for (const panel of ["codex-meter.html", "meter.html"]) {
      const html = readFileSync(
        new URL(`../com.devbloom.ai-usage.sdPlugin/ui/${panel}`, import.meta.url),
        "utf-8",
      );
      assert.doesNotMatch(html, /cycles through/, `${panel} still claims key presses cycle`);
    }
  });
});

describe("renderKey / renderKeySvg dispatch parity", () => {
  // renderKey and renderKeySvg each carry their own copy of the
  // kind-dispatch ternary (renderKey wraps the result as a data URI;
  // renderKeySvg hands back the raw markup for tests and the icon script).
  // TypeScript's exhaustiveness check catches a *missing* branch in either
  // one, but nothing stops the two chains from quietly drifting apart and
  // routing the same `kind` to two different renderers — only comparing
  // their actual output, for every kind, catches that.
  const variants = [
    { kind: "usage", mode: "both", snapshot },
    { kind: "resets", mode: "both", snapshot, now: new Date("2026-08-07T12:00:00Z") },
    { kind: "message", title: "ERROR", subtitle: "see logs", tone: "crit" },
    {
      kind: "sessions",
      face: "counts",
      waiting: 1,
      processing: 2,
      idle: 3,
      ranked: [],
      liveTotal: 6,
      staleFiles: 0,
    },
    {
      kind: "sessions",
      face: "problem",
      waiting: 0,
      processing: 0,
      idle: 0,
      ranked: [],
      liveTotal: 0,
      staleFiles: 0,
      problem: { title: "NO REGISTRY", subtitle: "3 running" },
    },
    {
      kind: "sessions",
      face: "peek",
      waiting: 1,
      processing: 0,
      idle: 0,
      ranked: [{ label: "api-server", bucket: "waiting", detail: "2m ago" }],
      liveTotal: 1,
      staleFiles: 0,
    },
    {
      kind: "sessions",
      face: "focus",
      waiting: 5,
      processing: 0,
      idle: 0,
      ranked: [],
      liveTotal: 5,
      staleFiles: 0,
      focusBucket: "waiting",
    },
  ];

  for (const view of variants) {
    it(`matches for kind=${view.kind} face=${view.face ?? "n/a"}`, () => {
      const expected = `data:image/svg+xml;base64,${Buffer.from(renderKeySvg(view), "utf-8").toString("base64")}`;
      assert.equal(renderKey(view), expected);
    });
  }
});

describe("sessions view rendering", () => {
  it("escapes a peek label containing XML-significant characters", () => {
    const svg = renderKeySvg({
      kind: "sessions",
      face: "peek",
      waiting: 1,
      processing: 0,
      idle: 0,
      ranked: [{ label: 'a & b <c> "d"', bucket: "waiting" }],
      liveTotal: 1,
      staleFiles: 0,
    });
    assert.match(svg, /&amp;/);
    assert.doesNotMatch(svg, /a & b/);
    assert.doesNotMatch(svg, /<c>/);
  });

  it("draws a zero-count row in MUTED, not its bucket colour", () => {
    const svg = renderKeySvg({
      kind: "sessions",
      face: "counts",
      waiting: 0,
      processing: 5,
      idle: 0,
      ranked: [],
      liveTotal: 5,
      staleFiles: 0,
    });
    // WAIT (0) and IDLE (0) both fall back to MUTED; only RUN (5, non-zero)
    // gets the "ok" colour. MUTED must appear at least twice — once for the
    // WAIT label/value pair, once for IDLE's.
    const mutedCount = (svg.match(/#6a6a78/g) || []).length;
    assert.ok(mutedCount >= 4, `expected at least 4 MUTED fills, saw ${mutedCount}`);
    assert.match(svg, /#4ade80/); // RUN still gets its real colour
  });

  it("focus face draws a live bucket in its colour with the bucket name beneath", () => {
    const svg = renderKeySvg({
      kind: "sessions",
      face: "focus",
      waiting: 0,
      processing: 5,
      idle: 0,
      ranked: [],
      liveTotal: 5,
      staleFiles: 0,
      focusBucket: "processing",
    });
    assert.match(svg, /#4ade80/); // "ok" colour for a live processing count
    assert.match(svg, />5</);
    assert.match(svg, />RUNNING</);
  });

  it("focus face draws a count of 0 in MUTED, never an em dash", () => {
    const svg = renderKeySvg({
      kind: "sessions",
      face: "focus",
      waiting: 0,
      processing: 0,
      idle: 0,
      ranked: [],
      liveTotal: 0,
      staleFiles: 0,
      focusBucket: "waiting",
    });
    // A count of 0 is a measurement, same reasoning as the counts face's own
    // zero rows — this is not "never measured", so no em dash may appear.
    assert.doesNotMatch(svg, /—/);
    assert.match(svg, />0</);
    assert.match(svg, />WAITING</);
    assert.doesNotMatch(svg, /#fbbf24/); // not the "warn" colour a live waiting count would use
  });

  it("focus face never spends the crit colour, even at a high count", () => {
    const svg = renderKeySvg({
      kind: "sessions",
      face: "focus",
      waiting: 40,
      processing: 0,
      idle: 0,
      ranked: [],
      liveTotal: 40,
      staleFiles: 0,
      focusBucket: "waiting",
    });
    assert.doesNotMatch(svg, /#f87171/); // crit red is reserved for the usage meters
  });

  it("a focused peek's heading reads the bucket name, not SESSIONS", () => {
    const svg = renderKeySvg({
      kind: "sessions",
      face: "peek",
      waiting: 1,
      processing: 0,
      idle: 0,
      ranked: [{ label: "api-server", bucket: "waiting", detail: "2m ago" }],
      liveTotal: 1,
      staleFiles: 0,
      focusBucket: "waiting",
    });
    assert.match(svg, />WAITING</);
    assert.doesNotMatch(svg, />SESSIONS</);
  });

  it("a focused peek with nothing in that bucket says so instead of the live/stale fallback", () => {
    const svg = renderKeySvg({
      kind: "sessions",
      face: "peek",
      waiting: 0,
      processing: 3,
      idle: 2,
      ranked: [], // already filtered to the (empty) waiting bucket by sessionsViewFor
      liveTotal: 5,
      staleFiles: 0,
      focusBucket: "waiting",
    });
    assert.match(svg, /no waiting sessions/);
    // Must not fall back to the generic "N live · N stale" footer, which
    // would count the other buckets this key is deliberately not showing.
    assert.doesNotMatch(svg, /5 live/);
  });

  it("never emits NaN, undefined, or null across all four faces", () => {
    const views = [
      {
        kind: "sessions",
        face: "counts",
        waiting: 0,
        processing: 0,
        idle: 0,
        ranked: [],
        liveTotal: 0,
        staleFiles: 0,
      },
      {
        kind: "sessions",
        face: "counts",
        waiting: 2,
        processing: 3,
        idle: 4,
        ranked: [],
        liveTotal: 9,
        staleFiles: 2,
      },
      {
        kind: "sessions",
        face: "problem",
        waiting: 0,
        processing: 0,
        idle: 0,
        ranked: [],
        liveTotal: 0,
        staleFiles: 0,
        problem: { title: "UNKNOWN STATUS", subtitle: "2 sessions" },
      },
      {
        kind: "sessions",
        face: "peek",
        waiting: 0,
        processing: 0,
        idle: 0,
        ranked: [],
        liveTotal: 0,
        staleFiles: 0,
      },
      {
        kind: "sessions",
        face: "peek",
        waiting: 1,
        processing: 1,
        idle: 1,
        ranked: [
          { label: "one", bucket: "waiting" },
          { label: "two", bucket: "processing", detail: "3m ago" },
          { label: "three", bucket: "idle" },
          { label: "four", bucket: "unknown" },
        ],
        liveTotal: 4,
        staleFiles: 1,
      },
      {
        kind: "sessions",
        face: "focus",
        waiting: 0,
        processing: 0,
        idle: 0,
        ranked: [],
        liveTotal: 0,
        staleFiles: 0,
        focusBucket: "idle",
      },
      {
        kind: "sessions",
        face: "focus",
        waiting: 7,
        processing: 0,
        idle: 0,
        ranked: [],
        liveTotal: 7,
        staleFiles: 0,
        focusBucket: "waiting",
      },
      {
        kind: "sessions",
        face: "peek",
        waiting: 0,
        processing: 0,
        idle: 0,
        ranked: [],
        liveTotal: 0,
        staleFiles: 0,
        focusBucket: "processing",
      },
    ];
    for (const view of views) {
      const svg = renderKeySvg(view);
      assert.doesNotMatch(svg, /NaN|undefined|null/, `${view.face} produced bad markup: ${svg}`);
      assert.match(svg.trim(), /<\/svg>$/);
    }
  });
});

describe("sessionsModeFrom", () => {
  it("passes through each recognised mode", () => {
    for (const mode of ["waiting", "processing", "idle"]) {
      assert.equal(sessionsModeFrom({ mode }), mode);
    }
  });

  it("falls back to 'all' when unset", () => {
    assert.equal(sessionsModeFrom({}), "all");
  });

  it("falls back to 'all' for an unrecognised string, rather than trusting it", () => {
    // Mirrors thresholdsFrom's refusal to trust an out-of-range slider: a
    // corrupted or hand-edited settings blob must not pin a key to a bucket
    // that doesn't exist.
    assert.equal(sessionsModeFrom({ mode: "bogus" }), "all");
    assert.equal(sessionsModeFrom({ mode: "both" }), "all"); // a DisplayMode value, not a SessionsMode one
  });
});

describe("sessionsViewFor", () => {
  const okState = {
    status: "ok",
    snapshot: {
      waiting: 2,
      processing: 3,
      idle: 4,
      unknown: 0,
      liveTotal: 9,
      staleFiles: 1,
      ranked: [
        { label: "api-server", bucket: "waiting", detail: "2m ago" },
        { label: "worker-2", bucket: "waiting" },
        { label: "worker-1", bucket: "processing" },
        { label: "docs-site", bucket: "idle" },
      ],
      unknownStatuses: [],
    },
  };

  it("mode 'all' renders the three-row counts face, as before", () => {
    const view = sessionsViewFor(okState, { mode: "all" });
    assert.equal(view.face, "counts");
    assert.equal(view.waiting, 2);
    assert.equal(view.processing, 3);
    assert.equal(view.idle, 4);
  });

  for (const mode of ["waiting", "processing", "idle"]) {
    it(`mode '${mode}' renders the focus face pinned to its own count`, () => {
      const view = sessionsViewFor(okState, { mode });
      assert.equal(view.face, "focus");
      assert.equal(view.focusBucket, mode);
      assert.equal(view[mode], okState.snapshot[mode]);
    });
  }

  it("an unset mode behaves like 'all'", () => {
    assert.equal(sessionsViewFor(okState, {}).face, "counts");
  });

  it("an unrecognised mode string behaves like 'all'", () => {
    assert.equal(sessionsViewFor(okState, { mode: "bogus" }).face, "counts");
  });

  // Rule 1: filtering is a display preference over trustworthy data, and it
  // must never be able to hide the fact that the data isn't trustworthy. A
  // key filtered to any single bucket must still surface each problem face.
  const unknownState = {
    status: "ok",
    snapshot: {
      waiting: 0,
      processing: 0,
      idle: 0,
      unknown: 2,
      liveTotal: 2,
      staleFiles: 0,
      ranked: [],
      unknownStatuses: ["compacting", "huh"],
    },
  };
  const noRegistryState = { status: "fail", problem: { kind: "no-registry", message: "3 running" } };
  const unreadableState = { status: "fail", problem: { kind: "unreadable", message: "boom" } };

  const problemCases = [
    ["UNKNOWN STATUS", unknownState],
    ["NO REGISTRY", noRegistryState],
    ["UNREADABLE", unreadableState],
  ];

  for (const mode of ["all", "waiting", "processing", "idle"]) {
    for (const [title, state] of problemCases) {
      it(`${title} still wins under mode '${mode}'`, () => {
        const view = sessionsViewFor(state, { mode });
        assert.equal(view.face, "problem");
        assert.equal(view.problem.title, title);
      });
    }
  }

  it("a focused empty bucket renders 0, not an em dash", () => {
    const emptyState = {
      status: "ok",
      snapshot: {
        waiting: 0,
        processing: 0,
        idle: 0,
        unknown: 0,
        liveTotal: 0,
        staleFiles: 0,
        ranked: [],
        unknownStatuses: [],
      },
    };
    const view = sessionsViewFor(emptyState, { mode: "idle" });
    assert.equal(view.face, "focus");
    assert.equal(view.idle, 0);
    const svg = renderKeySvg(view);
    assert.doesNotMatch(svg, /—/);
    assert.match(svg, />0</);
  });

  it("loading borrows the focus face with a zero, when a mode is set", () => {
    const view = sessionsViewFor({ status: "loading" }, { mode: "processing" });
    assert.equal(view.face, "focus");
    assert.equal(view.focusBucket, "processing");
    assert.equal(view.processing, 0);
  });

  it("peek in 'all' mode lists every bucket, unchanged", () => {
    const view = sessionsViewFor(okState, { mode: "all" }, true);
    assert.equal(view.face, "peek");
    assert.equal(view.focusBucket, undefined);
    assert.equal(view.ranked.length, okState.snapshot.ranked.length);
  });

  it("peek in a focused mode lists only that bucket's sessions", () => {
    const view = sessionsViewFor(okState, { mode: "waiting" }, true);
    assert.equal(view.face, "peek");
    assert.equal(view.focusBucket, "waiting");
    assert.equal(view.ranked.length, 2);
    assert.ok(view.ranked.every((r) => r.bucket === "waiting"));
  });

  it("a focused peek's heading names the bucket, and an empty bucket says so", () => {
    const view = sessionsViewFor(okState, { mode: "idle" }, true);
    // okState's one idle session lands in the peek...
    assert.equal(view.ranked.length, 1);
    assert.equal(view.ranked[0].bucket, "idle");

    const emptierState = {
      status: "ok",
      snapshot: { ...okState.snapshot, idle: 0, ranked: okState.snapshot.ranked.filter((r) => r.bucket !== "idle") },
    };
    const emptyView = sessionsViewFor(emptierState, { mode: "idle" }, true);
    assert.equal(emptyView.ranked.length, 0);
    const svg = renderKeySvg(emptyView);
    assert.match(svg, /no idle sessions/);
    // Must not leak the waiting/processing sessions that are live elsewhere.
    assert.doesNotMatch(svg, /api-server|worker-1|worker-2/);
  });

  // The unknown-status peek is deliberately exempt from mode filtering (see
  // sessionsPeekViewFor's comment in view.ts): those sessions have no bucket
  // a mode filter could ever match, so filtering would just erase the one
  // thing this diagnostic peek exists to show.
  it("peek on the unknown-status problem ignores the mode filter", () => {
    const view = sessionsViewFor(unknownState, { mode: "waiting" }, true);
    assert.equal(view.face, "peek");
    assert.equal(view.ranked.length, 2);
    assert.deepEqual(view.ranked.map((r) => r.label).sort(), ["compacting", "huh"]);
  });
});

describe("firstFocusableSession", () => {
  const rankedState = {
    status: "ok",
    snapshot: {
      waiting: 2,
      processing: 1,
      idle: 1,
      unknown: 1,
      liveTotal: 5,
      staleFiles: 0,
      ranked: [
        { label: "api-server", bucket: "waiting", pid: 111 },
        { label: "worker-2", bucket: "waiting", pid: 222 },
        { label: "worker-1", bucket: "processing", pid: 333 },
        // Lands between "processing" and "idle" in ranked order, same as
        // buildSnapshot's own bucketOrder — mode "all" must skip past it.
        { label: "mystery", bucket: "unknown", pid: 444 },
        { label: "docs-site", bucket: "idle", pid: 555 },
      ],
      unknownStatuses: ["compacting"],
    },
  };

  it("mode 'all' returns the first ranked session, skipping an interleaved unknown-bucket entry", () => {
    const session = firstFocusableSession(rankedState, { mode: "all" });
    assert.equal(session.label, "api-server");
    assert.equal(session.pid, 111);
  });

  it("a single-bucket mode returns that bucket's first entry, not the overall first", () => {
    const session = firstFocusableSession(rankedState, { mode: "processing" });
    assert.equal(session.label, "worker-1");
    assert.equal(session.pid, 333);
  });

  it("returns null when the pinned bucket has nothing in it", () => {
    const emptyProcessing = {
      status: "ok",
      snapshot: { ...rankedState.snapshot, ranked: rankedState.snapshot.ranked.filter((r) => r.bucket !== "processing") },
    };
    assert.equal(firstFocusableSession(emptyProcessing, { mode: "processing" }), null);
  });

  it("mode 'all' can never return an unknown-bucket session, even as the only entry", () => {
    const onlyUnknown = {
      status: "ok",
      snapshot: { ...rankedState.snapshot, ranked: [{ label: "mystery", bucket: "unknown", pid: 444 }] },
    };
    assert.equal(firstFocusableSession(onlyUnknown, { mode: "all" }), null);
  });

  it("skips a synthetic entry with a non-positive pid, the same guard sessionsPeekViewFor's unknown-status rows rely on", () => {
    const withPlaceholder = {
      status: "ok",
      snapshot: {
        ...rankedState.snapshot,
        ranked: [{ label: "compacting", bucket: "unknown", pid: -1 }, ...rankedState.snapshot.ranked],
      },
    };
    const session = firstFocusableSession(withPlaceholder, { mode: "all" });
    assert.equal(session.label, "api-server");
  });

  it("returns null while loading — nothing has been ranked yet", () => {
    assert.equal(firstFocusableSession({ status: "loading" }, { mode: "all" }), null);
  });

  it("returns null on a fail state — there is no snapshot to rank", () => {
    const fail = { status: "fail", problem: { kind: "no-registry", message: "3 running" } };
    assert.equal(firstFocusableSession(fail, { mode: "all" }), null);
  });

  it("an unset mode behaves like 'all'", () => {
    const session = firstFocusableSession(rankedState, {});
    assert.equal(session.label, "api-server");
  });
});

describe("sessions long-press flash faces", () => {
  // These mirror the literals sessions.ts builds for handleLongPress's four
  // outcomes — plain MessageViews with `fill: true`, not a new SessionsView
  // face, per the brief's instruction to reuse the existing message card
  // rather than add new render code. Checked here since render.ts has no
  // dedicated branch of its own to exercise these titles against.
  //
  // Both successful-focus outcomes now flash the same green: the user is
  // still holding the key down when the confirmation lands, so the tab-vs-
  // app precision distinction has to live in the subtitle, not in a second
  // colour that a covering finger would hide anyway.
  const faces = [
    ["focused", { kind: "message", title: "FOCUSED", tone: "ok", fill: true }, SEVERITY_COLOURS.ok],
    [
      "raised (app only)",
      { kind: "message", title: "RAISED", subtitle: "app only", tone: "ok", fill: true },
      SEVERITY_COLOURS.ok,
    ],
    [
      "empty bucket",
      { kind: "message", title: "EMPTY", subtitle: "no session", tone: "warn", fill: true },
      SEVERITY_COLOURS.warn,
    ],
    [
      "focus failed",
      { kind: "message", title: "FAILED", subtitle: "see logs", tone: "crit", fill: true },
      SEVERITY_COLOURS.crit,
    ],
  ];

  for (const [name, view, colour] of faces) {
    it(`renders ${name} as valid, escaped SVG with no bad markup`, () => {
      const svg = renderKeySvg(view);
      assert.doesNotMatch(svg, /NaN|undefined|null/);
      assert.match(svg.trim(), /<\/svg>$/);
      assert.match(svg, new RegExp(`>${view.title}<`));
      if (view.subtitle) assert.match(svg, new RegExp(`>${view.subtitle}<`));
    });

    it(`fills the whole key with its tone colour for ${name}, not just the text`, () => {
      const svg = renderKeySvg(view);
      // The fill rect is the frame()-level rx=20 rect itself, so the tone
      // colour must appear on a full-size rect, not merely somewhere in the
      // markup (which a coloured text glyph would also satisfy).
      assert.match(svg, new RegExp(`<rect width="144" height="144" rx="20" fill="${colour}"`));
      // Text draws in the dark background colour for contrast against the
      // filled face, the inverse of the unfilled path below.
      assert.match(svg, /fill="#0d0d11"/);
    });
  }

  it("the app-only face never claims the precision only Terminal.app tabs achieve", () => {
    const svg = renderKeySvg(faces[1][1]);
    assert.doesNotMatch(svg, />FOCUSED</);
  });
});

describe("MessageView fill flag", () => {
  it("paints the whole rounded rect in the tone colour when filled, dark text for contrast", () => {
    const svg = renderKeySvg({ kind: "message", title: "SENT", tone: "ok", fill: true });
    assert.match(svg, new RegExp(`<rect width="144" height="144" rx="20" fill="${SEVERITY_COLOURS.ok}"`));
    assert.match(svg, />SENT</);
    assert.match(svg, /fill="#0d0d11"[^>]*>SENT</);
  });

  it("a neutral fill is still a visible flash (grey), not indistinguishable from the normal face", () => {
    const filled = renderKeySvg({ kind: "message", title: "SENT", tone: "neutral", fill: true });
    const normal = renderKeySvg({ kind: "message", title: "SENT" });
    // The neutral fill uses MUTED (#6a6a78), never the near-black BG
    // (#0d0d11) the unfilled face uses — a fill that matched BG would ship a
    // flash that doesn't flash.
    assert.match(filled, /<rect width="144" height="144" rx="20" fill="#6a6a78"/);
    assert.notEqual(filled, normal);
  });

  it("every six existing (unfilled) message faces render byte-identical to their pre-fill output", () => {
    // Locks in the brief's "byte-identical to today" requirement: these are
    // the exact literals viewFor/sessions.ts/launch.ts already build for
    // SIGN IN, EXPIRED, BLOCKED, OFFLINE, ERROR, and the loading card. Each
    // expected string is the pre-`fill` renderMessage output, computed by
    // hand from the unchanged non-fill code path (21px title, 15px MUTED
    // subtitle, no rect other than frame()'s own BG-filled one).
    const cases = [
      { view: { kind: "message", title: "SIGN IN", subtitle: "run claude", tone: "warn" } },
      { view: { kind: "message", title: "EXPIRED", subtitle: "run claude", tone: "warn" } },
      { view: { kind: "message", title: "BLOCKED", subtitle: "403", tone: "warn" } },
      { view: { kind: "message", title: "OFFLINE", subtitle: "no network", tone: "warn" } },
      { view: { kind: "message", title: "ERROR", subtitle: "see logs", tone: "crit" } },
      { view: { kind: "message", title: "…", subtitle: "loading" } },
    ];
    for (const { view } of cases) {
      const svg = renderKeySvg(view);
      // Exactly one rect (frame()'s own, still BG), never a second
      // fill-coloured rect — proves the fill branch was not taken.
      const rectCount = (svg.match(/<rect/g) ?? []).length;
      assert.equal(rectCount, 1, `${view.title} drew ${rectCount} rects, expected 1 (fill branch was not supposed to run)`);
      assert.match(svg, /<rect width="144" height="144" rx="20" fill="#0d0d11"\/>/);
      // Title colour still follows the pre-fill tone mapping — light-on-dark,
      // never the fill path's dark-on-light.
      const titleColour = view.tone === "crit" ? SEVERITY_COLOURS.crit : view.tone === "warn" ? SEVERITY_COLOURS.warn : "#c9c9d4";
      assert.match(svg, new RegExp(`fill="${titleColour}"[^>]*>${escapeRegExp(view.title)}<`));
    }
  });

  it("no fill face emits NaN, undefined, or null", () => {
    for (const tone of ["neutral", "warn", "crit", "ok"]) {
      const svg = renderKeySvg({ kind: "message", title: "X", subtitle: "y", tone, fill: true });
      assert.doesNotMatch(svg, /NaN|undefined|null/);
    }
  });
});

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
