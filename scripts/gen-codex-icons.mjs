/**
 * Generate the PNG assets for the Codex actions, and (despite the filename —
 * see below) the Sessions action too.
 *
 * `scripts/icons.py` drew the Claude assets with cairosvg, which is not
 * installed on this machine and never was. Chromium is, via Playwright (it
 * already backs `scripts/shoot-pi.mjs`), so this script gets the same SVG
 * source to disk by screenshotting it in a headless page instead of piping it
 * through a rasteriser. Colours, the ring-gauge geometry, and the 0.14
 * corner-radius ratio are copied from icons.py so the Codex assets sit in the
 * same visual family as the Claude ones already on disk.
 *
 * The launch mark differs from Claude's on two independent axes — a double
 * chevron instead of a single chevron, teal instead of coral — and that pair
 * reads apart cleanly. The meter mark first shipped with only a colour swap
 * plus a dot-vs-diamond detail too small in area to carry the distinction:
 * at 20px the two gauges read as the same icon. It now differs in silhouette
 * too — the ring is broken into two arcs (a long coloured one, a shorter
 * grey one) with two gaps instead of Claude's one continuous arc with a
 * single gap — and the teal covers a real share of the ring's length rather
 * than sitting in a small marker, so colour does work even before anyone
 * reads the hue. A diamond tick at the boundary between the two arcs is the
 * one holdover from the old marker, there so the "diamond, not a dot" cue
 * from the launch pair still applies if you look closely.
 *
 * The Sessions mark (added later, for the fifth action reporting how many
 * Claude Code sessions are waiting/processing/idle) needed to be neither a
 * gauge arc nor a chevron — both motifs were already spoken for — and to
 * suggest several parallel things in different states rather than one
 * value. It's three status dots in a staggered row, each rendered
 * differently (hollow grey ring, solid filled, ring-with-centre-dot) so the
 * "different states" idea is structural, not just a colour choice. Its
 * accent is violet (`#a78bfa`), chosen for hue distance from both the
 * meter's coral (~15°) and the Codex teal (~172°) — violet sits at ~255°,
 * roughly equidistant from both around the wheel, so it can't be mistaken
 * for a shade of either existing accent.
 *
 * Yes, this script now generates non-Codex assets and its name no longer
 * describes what it does. That's accepted debt, not an oversight — renaming
 * it would churn `package.json`'s `icons:codex` script, `DEVELOPMENT.md`,
 * and everyone's muscle memory for zero functional gain.
 *
 *   node scripts/gen-codex-icons.mjs
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "com.devbloom.ai-usage.sdPlugin", "imgs", "actions");

const BG = "#0d0d11";
const TRACK = "#3a3a46";
const TRACK_SMALL = "#6f6f7a";
const TEAL = "#2dd4bf";
const VIOLET = "#a78bfa";

const rad = (deg) => (deg * Math.PI) / 180;

/** Same arc math as icons.py's `arc()`: a clockwise SVG arc from `startDeg`. */
function arcPath(cx, cy, r, startDeg, sweepDeg) {
  const sx = cx + r * Math.cos(rad(startDeg));
  const sy = cy + r * Math.sin(rad(startDeg));
  const ex = cx + r * Math.cos(rad(startDeg + sweepDeg));
  const ey = cy + r * Math.sin(rad(startDeg + sweepDeg));
  const large = sweepDeg > 180 ? 1 : 0;
  return { d: `M ${sx.toFixed(2)} ${sy.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${ex.toFixed(2)} ${ey.toFixed(2)}`, sx, sy, ex, ey };
}

/**
 * A ring gauge in the same family as the Claude meter's — same centre, same
 * 135-degree start, same overall radius/stroke ratios — but split into two
 * arcs instead of one continuous 270-degree sweep. The long arc (roughly
 * 40% of the full circle) carries the Codex teal; the short arc is the same
 * neutral grey Claude's track uses. Two gaps instead of one is what keeps
 * the silhouette distinct once the icon shrinks to 20px and fine detail
 * stops resolving — a viewer can tell "broken ring" from "ring with one
 * notch" long after they can't tell dot from diamond.
 */
function meterSvg(size, { bg = null, strokeRatio, radiusRatio, track, fill }) {
  const cx = size / 2;
  const cy = size / 2;
  const r = size * radiusRatio;
  const stroke = size * strokeRatio;

  // 135 -> 235: bottom-left up through the left side. This is the teal arc,
  // and deliberately the larger of the two so colour covers a real share of
  // the ring rather than a marker-sized fraction of it.
  const tealArc = arcPath(cx, cy, r, 135, 100);
  // 250 -> 390 (=30): top, right, lower-right. The grey arc, shorter than
  // the teal one, ending near where Claude's own ring does.
  const trackArc = arcPath(cx, cy, r, 250, 140);

  const background = bg ? `<rect width="${size}" height="${size}" rx="${(size * 0.14).toFixed(1)}" fill="${bg}"/>` : "";

  // Diamond tick at the flat end of the teal arc — the seam between the two
  // segments, playing the same "current reading" role Claude's round dot
  // plays at its arc's start, but keeping this mark's own diamond identity.
  const half = stroke * 0.65;
  const tx = tealArc.ex;
  const ty = tealArc.ey;
  const diamond = `M ${tx.toFixed(2)} ${(ty - half).toFixed(2)} L ${(tx + half).toFixed(2)} ${ty.toFixed(2)} L ${tx.toFixed(2)} ${(ty + half).toFixed(2)} L ${(tx - half).toFixed(2)} ${ty.toFixed(2)} Z`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="100%" height="100%">
  ${background}
  <path d="${trackArc.d}" fill="none" stroke="${track}" stroke-width="${stroke.toFixed(2)}" stroke-linecap="butt"/>
  <path d="${tealArc.d}" fill="none" stroke="${fill}" stroke-width="${stroke.toFixed(2)}" stroke-linecap="butt"/>
  <path d="${diamond}" fill="${fill}"/>
</svg>`;
}

/** One right-pointing chevron, stroked (not filled) like Claude's mark. */
function chevronPath(cx, cy, w, h) {
  return `M ${(cx - w / 2).toFixed(2)} ${(cy - h / 2).toFixed(2)} L ${(cx + w / 2).toFixed(2)} ${cy} L ${(cx - w / 2).toFixed(2)} ${(cy + h / 2).toFixed(2)}`;
}

/**
 * Codex's launch mark: a double chevron ("fast-forward" / "next") plus the
 * same underscore cursor bar Claude's launch icon uses, so the two read as
 * siblings from the same "prompt" idea while staying visually distinct —
 * Claude's launch key is a single chevron, this is two, and teal rather than
 * coral. Left unchanged from the first pass; the reviewer confirmed this
 * pair already reads apart cleanly.
 */
function launchSvg(size) {
  const stroke = size * 0.115;
  const cy = size * 0.44;
  const chevW = size * 0.22;
  const chevH = size * 0.4;
  const c1 = chevronPath(size * 0.32, cy, chevW, chevH);
  const c2 = chevronPath(size * 0.5, cy, chevW, chevH);

  const barW = size * 0.16;
  const barH = size * 0.09;
  const barX = size * 0.6;
  const barY = size * 0.72;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="100%" height="100%">
  <rect width="${size}" height="${size}" rx="${(size * 0.14).toFixed(1)}" fill="${BG}"/>
  <path d="${c1}" fill="none" stroke="${TEAL}" stroke-width="${stroke.toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="${c2}" fill="none" stroke="${TEAL}" stroke-width="${stroke.toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="${barX.toFixed(2)}" y="${barY.toFixed(2)}" width="${barW.toFixed(2)}" height="${barH.toFixed(2)}" rx="${(barH / 2).toFixed(2)}" fill="${TEAL}"/>
</svg>`;
}

/**
 * Three status dots in a staggered row — sessions waiting for input,
 * processing, or idle. Each dot is rendered differently rather than just
 * differently coloured, so "several things in different states" is legible
 * in silhouette alone, before colour is read: a hollow grey ring (idle), a
 * solid filled dot raised above the baseline (processing — the one doing
 * something, so it's the one that stands out), and a ring with a small
 * filled centre (waiting — present but not yet running). This is neither a
 * gauge arc nor a chevron, which keeps it structurally distinct from the
 * other four action icons, not just distinct by hue.
 */
function sessionsSvg(size, { bg = null, track = TRACK, accent = VIOLET }) {
  const r = size * 0.14;
  const rRaised = size * 0.16;
  const yBase = size * 0.6;
  const yRaised = size * 0.4;
  const xs = [size * 0.26, size * 0.5, size * 0.74];
  const strokeW = size * 0.075;

  const background = bg ? `<rect width="${size}" height="${size}" rx="${(size * 0.14).toFixed(1)}" fill="${bg}"/>` : "";

  // Idle: hollow ring, neutral grey — present, doing nothing.
  const idleDot = `<circle cx="${xs[0].toFixed(2)}" cy="${yBase.toFixed(2)}" r="${(r - strokeW / 2).toFixed(2)}" fill="none" stroke="${track}" stroke-width="${strokeW.toFixed(2)}"/>`;

  // Processing: solid filled, raised above the other two — the active one.
  const processingDot = `<circle cx="${xs[1].toFixed(2)}" cy="${yRaised.toFixed(2)}" r="${rRaised.toFixed(2)}" fill="${accent}"/>`;

  // Waiting: a ring with a small filled centre — present and about to run,
  // between idle's empty ring and processing's full fill.
  const waitingRing = `<circle cx="${xs[2].toFixed(2)}" cy="${yBase.toFixed(2)}" r="${(r - strokeW / 2).toFixed(2)}" fill="none" stroke="${accent}" stroke-width="${strokeW.toFixed(2)}"/>`;
  const waitingCentre = `<circle cx="${xs[2].toFixed(2)}" cy="${yBase.toFixed(2)}" r="${(r * 0.38).toFixed(2)}" fill="${accent}"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="100%" height="100%">
  ${background}
  ${idleDot}
  ${waitingRing}
  ${waitingCentre}
  ${processingDot}
</svg>`;
}

async function rasterize(page, svg, size, outPath) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<!doctype html><html><head><style>html,body{margin:0;padding:0;background:transparent;}</style></head><body>${svg}</body></html>`,
  );
  await page.screenshot({ path: outPath, omitBackground: true });
  console.log(`  ${outPath} (${size}px)`);
}

async function write(page, relPath, svgFor, size) {
  const out1x = join(ROOT, `${relPath}.png`);
  const out2x = join(ROOT, `${relPath}@2x.png`);
  mkdirSync(dirname(out1x), { recursive: true });
  await rasterize(page, svgFor(size), size, out1x);
  await rasterize(page, svgFor(size * 2), size * 2, out2x);
}

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });

// Action-list / category-sized icon: no background (transparent, so it sits
// correctly on whatever chrome Stream Deck draws behind it), thin grey track,
// same proportions icons.py used for the Claude meter's small icon.
await write(page, "codex-meter/icon", (s) => meterSvg(s, {
  strokeRatio: 0.19,
  radiusRatio: 0.31,
  track: TRACK_SMALL,
  fill: TEAL,
}), 20);

// Default key face, shown for the instant before the first render lands (and,
// since renderKey overdraws the key face at runtime, the face most people
// actually see day to day is this one and the 20px action-list icon above).
await write(page, "codex-meter/key", (s) => meterSvg(s, {
  bg: BG,
  strokeRatio: 0.11,
  radiusRatio: 0.33,
  track: TRACK,
  fill: TEAL,
}), 72);

await write(page, "codex-launch/icon", launchSvg, 20);
await write(page, "codex-launch/key", launchSvg, 72);

// Sessions action-list icon: transparent, same convention as the meter
// icons (it's a monitor, not a launcher, so it gets no background square).
await write(page, "sessions/icon", (s) => sessionsSvg(s, { track: TRACK_SMALL }), 20);

// Sessions default key face: filled dark background like every other key.
await write(page, "sessions/key", (s) => sessionsSvg(s, { bg: BG }), 72);

await browser.close();
console.log("codex icons written");
