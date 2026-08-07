/**
 * Renders every key state to standalone SVG files so the visual design can be
 * eyeballed without a Stream Deck attached. Run after `tsc --outDir .build`.
 *
 *   node scripts/preview.mjs <outDir>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { renderKeySvg } from "../.build/lib/render.js";

const outDir = process.argv[2] ?? "/tmp/preview";
mkdirSync(outDir, { recursive: true });

// Fixed clock so countdown text is deterministic between runs.
const now = new Date("2026-08-07T12:00:00Z");
const inMinutes = (m) => new Date(now.getTime() + m * 60_000);

const snapshot = (sessionPct, weeklyPct, sessionMins = 134, weeklyMins = 4_500) => ({
  sessionPct,
  weeklyPct,
  sessionResetAt: inMinutes(sessionMins),
  weeklyResetAt: inMinutes(weeklyMins),
  fetchedAt: now,
});

const cases = [
  ["both-low", { kind: "usage", mode: "both", snapshot: snapshot(12, 34), now }],
  ["both-mid", { kind: "usage", mode: "both", snapshot: snapshot(58, 76), now }],
  ["both-high", { kind: "usage", mode: "both", snapshot: snapshot(94, 88), now }],
  // Anthropic's own status can agree with (or override) the local sliders.
  // "weekly" is the binding window here, so its label draws brighter.
  [
    "both-api-warning",
    {
      kind: "usage",
      mode: "both",
      snapshot: {
        ...snapshot(58, 76),
        sessionStatus: "allowed",
        weeklyStatus: "allowed_warning",
        binding: "weekly",
      },
      now,
    },
  ],
  // Proves the API status can escalate a key the local thresholds alone
  // would call fine: weeklyPct is well under the default 70% warn line.
  [
    "both-api-escalates-low",
    {
      kind: "usage",
      mode: "both",
      snapshot: {
        ...snapshot(12, 20),
        sessionStatus: "allowed",
        weeklyStatus: "allowed_warning",
        binding: "weekly",
      },
      now,
    },
  ],
  ["session-low", { kind: "usage", mode: "session", snapshot: snapshot(7, 20), now }],
  ["session-mid", { kind: "usage", mode: "session", snapshot: snapshot(73, 40), now }],
  ["session-high", { kind: "usage", mode: "session", snapshot: snapshot(96, 40, 12), now }],
  ["weekly-mid", { kind: "usage", mode: "weekly", snapshot: snapshot(30, 62), now }],
  ["weekly-high", { kind: "usage", mode: "weekly", snapshot: snapshot(30, 97), now }],
  ["resets-both", { kind: "resets", mode: "both", snapshot: snapshot(58, 76), now }],
  ["resets-both-hot", { kind: "resets", mode: "both", snapshot: snapshot(94, 88), now }],
  ["resets-session", { kind: "resets", mode: "session", snapshot: snapshot(58, 76), now }],
  ["resets-weekly", { kind: "resets", mode: "weekly", snapshot: snapshot(30, 97), now }],
  // Burn-rate projection line: the most urgent thing the bottom line can say,
  // so it wins over the promo notice below even though `now` also falls
  // inside the boost window.
  [
    "resets-weekly-projection",
    {
      kind: "resets",
      mode: "weekly",
      snapshot: snapshot(30, 97),
      projectionHours: 3,
      now,
    },
  ],
  // With no projection, the weekly peek falls back to the promo notice — but
  // only while WEEKLY_BOOST_ENDS_AT (src/lib/promo.ts) is still in the
  // future relative to the *real* wall clock renderKeySvg reads by default.
  // This case intentionally omits `now` rather than faking the date, so it
  // renders the notice only until the promotion actually ends.
  [
    "resets-weekly-boost",
    {
      kind: "resets",
      mode: "weekly",
      snapshot: snapshot(30, 97),
      projectionHours: null,
    },
  ],
  ["signed-out", { kind: "message", title: "SIGN IN", subtitle: "run claude", tone: "warn" }],
  ["stale", { kind: "message", title: "EXPIRED", subtitle: "run claude", tone: "warn" }],
  ["error", { kind: "message", title: "ERROR", subtitle: "see logs", tone: "crit" }],
  ["loading", { kind: "message", title: "…", subtitle: "loading" }],
];

for (const [name, view] of cases) {
  writeFileSync(join(outDir, `${name}.svg`), renderKeySvg(view), "utf-8");
}

console.log(`wrote ${cases.length} previews to ${outDir}`);
