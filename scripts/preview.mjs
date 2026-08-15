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
  // Codex shapes: a provider that reports only the weekly window leaves
  // sessionPct null, which must draw an em dash and an empty track — never a
  // fabricated 0%. These are the faces that regressed most easily while the
  // nullable-percentage change went in, so they are previewed explicitly.
  ["codex-no-session-both", { kind: "usage", mode: "both", snapshot: { ...snapshot(null, 0), sessionResetAt: null }, now }],
  ["codex-no-session-only", { kind: "usage", mode: "session", snapshot: { ...snapshot(null, 0), sessionResetAt: null }, now }],
  ["codex-weekly-mid", { kind: "usage", mode: "weekly", snapshot: { ...snapshot(null, 61), sessionResetAt: null }, now }],
  ["codex-weekly-high", { kind: "usage", mode: "weekly", snapshot: { ...snapshot(null, 93), sessionResetAt: null }, now }],
  ["codex-resets-weekly", { kind: "resets", mode: "weekly", snapshot: { ...snapshot(null, 61), sessionResetAt: null }, now }],
  ["codex-signed-out", { kind: "message", title: "SIGN IN", subtitle: "open ChatGPT", tone: "warn" }],
  ["codex-expired", { kind: "message", title: "EXPIRED", subtitle: "open ChatGPT", tone: "warn" }],
  ["codex-launch-idle", { kind: "message", title: "CODEX" }],
  // The widened UsageFailure taxonomy (see usage.ts): each of these used to
  // collapse into the generic ERROR card, which is exactly the bug this
  // taxonomy exists to fix — "no-plan" isn't shown here as a Codex-specific
  // case because the card itself carries no provider identity, only Codex
  // currently produces it (see checkCredentials in codex.ts).
  ["no-plan", { kind: "message", title: "API KEY", subtitle: "no limits" }],
  ["blocked", { kind: "message", title: "BLOCKED", subtitle: "403", tone: "warn" }],
  ["offline", { kind: "message", title: "OFFLINE", subtitle: "no network", tone: "warn" }],
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

  // Sessions key: the "counts" face, one case per row-emphasis pattern so a
  // reviewer can eyeball that a zero row really does go grey while a live
  // one keeps its bucket colour.
  [
    "sessions-mixed",
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
  ],
  [
    "sessions-idle-only",
    {
      kind: "sessions",
      face: "counts",
      waiting: 0,
      processing: 0,
      idle: 3,
      ranked: [],
      liveTotal: 3,
      staleFiles: 0,
    },
  ],
  [
    "sessions-none",
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
  ],

  // The "problem" face, one case per SessionsProblem kind plus the
  // ok-but-unclassified case that also routes here.
  [
    "sessions-unknown",
    {
      kind: "sessions",
      face: "problem",
      waiting: 1,
      processing: 1,
      idle: 1,
      ranked: [],
      liveTotal: 3,
      staleFiles: 0,
      problem: { title: "UNKNOWN STATUS", subtitle: "2 sessions" },
    },
  ],
  [
    "sessions-no-registry",
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
  ],
  [
    "sessions-unreadable",
    {
      kind: "sessions",
      face: "problem",
      waiting: 0,
      processing: 0,
      idle: 0,
      ranked: [],
      liveTotal: 0,
      staleFiles: 0,
      problem: { title: "UNREADABLE", subtitle: "see logs" },
    },
  ],

  // The "peek" face: three full rows plus the live/stale footer, then a
  // second case that exercises the truncation and XML-escape path on
  // genuinely adversarial label text — this is the first face in the
  // plugin that ever draws user-controlled strings.
  [
    "sessions-peek",
    {
      kind: "sessions",
      face: "peek",
      waiting: 1,
      processing: 1,
      idle: 1,
      ranked: [
        { label: "api-server", bucket: "waiting", detail: "2m ago" },
        { label: "web-client", bucket: "processing", detail: "running" },
        { label: "docs-site", bucket: "idle", detail: "12m ago" },
      ],
      liveTotal: 3,
      staleFiles: 1,
    },
  ],
  [
    "sessions-peek-longname",
    {
      kind: "sessions",
      face: "peek",
      waiting: 1,
      processing: 1,
      idle: 0,
      ranked: [
        {
          label: "this-is-a-forty-character-session-label!",
          bucket: "waiting",
          detail: "just now",
        },
        { label: 'a & b <c> "d"', bucket: "processing" },
      ],
      liveTotal: 2,
      staleFiles: 0,
    },
  ],

  // The "focus" face: a key pinned to one bucket via its mode setting. One
  // live case per bucket colour, plus the empty-bucket case that must draw
  // "0" in MUTED rather than the counts face's own em-dash vocabulary — a
  // focused bucket with nothing in it is still a measurement, not "unknown".
  [
    "sessions-focus-waiting",
    {
      kind: "sessions",
      face: "focus",
      waiting: 4,
      processing: 0,
      idle: 0,
      ranked: [],
      liveTotal: 4,
      staleFiles: 0,
      focusBucket: "waiting",
    },
  ],
  [
    "sessions-focus-running",
    {
      kind: "sessions",
      face: "focus",
      waiting: 0,
      processing: 2,
      idle: 0,
      ranked: [],
      liveTotal: 2,
      staleFiles: 0,
      focusBucket: "processing",
    },
  ],
  [
    "sessions-focus-idle-zero",
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
  ],

  // Peek in a focused mode: the heading reads the bucket name instead of
  // "SESSIONS", and only that bucket's rows appear even though other
  // buckets are live in this fixture.
  [
    "sessions-peek-focus",
    {
      kind: "sessions",
      face: "peek",
      waiting: 2,
      processing: 1,
      idle: 1,
      ranked: [
        { label: "api-server", bucket: "waiting", detail: "2m ago" },
        { label: "worker-2", bucket: "waiting", detail: "just now" },
      ],
      liveTotal: 4,
      staleFiles: 0,
      focusBucket: "waiting",
    },
  ],

  // Long-press flash faces (sessions.ts's handleLongPress). Plain
  // MessageViews with `fill: true` — a whole-key colour flash, not a new
  // SessionsView face — reusing the existing card rather than adding new
  // render code, per the long-press brief. The confirmation lands while the
  // user is still holding the key, so these are previewed filled: a centred
  // title alone (the pre-fill design) is exactly what a covering finger
  // would hide.
  ["sessions-longpress-focused", { kind: "message", title: "FOCUSED", tone: "ok", fill: true }],
  // "RAISED", not "FOCUSED": macOS exposes no way to select VS Code's or
  // Cursor's integrated terminal pane, so this face must not claim a
  // precision the press didn't actually achieve — hence same green fill as
  // FOCUSED, with the precision distinction kept in the subtitle instead of
  // spent on a second colour.
  [
    "sessions-longpress-raised",
    { kind: "message", title: "RAISED", subtitle: "app only", tone: "ok", fill: true },
  ],
  // A hold that appears to do nothing is indistinguishable from a broken
  // gesture, so an empty bucket still gets a face, not silence.
  [
    "sessions-longpress-empty",
    { kind: "message", title: "EMPTY", subtitle: "no session", tone: "warn", fill: true },
  ],
  [
    "sessions-longpress-failed",
    { kind: "message", title: "FAILED", subtitle: "see logs", tone: "crit", fill: true },
  ],
];

for (const [name, view] of cases) {
  writeFileSync(join(outDir, `${name}.svg`), renderKeySvg(view), "utf-8");
}

console.log(`wrote ${cases.length} previews to ${outDir}`);
