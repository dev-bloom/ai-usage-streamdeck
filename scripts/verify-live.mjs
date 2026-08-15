/**
 * Hit both providers' real endpoints and report what comes back.
 *
 * This exists because of a bug that a fully green `npm test` could never
 * have caught. Every unit test in this repo feeds parsing logic a fixture
 * and never opens a socket, so the entire network layer is untested by
 * construction — and the Codex endpoint sits behind Cloudflare, which
 * fingerprints the TLS ClientHello and rejects some clients with a 403 that
 * looks exactly like an auth failure.
 *
 * The part that actually bit: **which Node build you run decides the
 * answer.** Measured back to back, same code and credentials, Node 20.20.0
 * got 0/5 and Node 24.19.0 got 5/5. Stream Deck ships and runs the plugin on
 * Node 20; a dev shell here is Node 24. Verifying in the dev shell therefore
 * proved nothing about the thing users run.
 *
 * So this script defaults to running under **Stream Deck's own Node**, not
 * whatever `node` is on PATH. Run it with plain `node` and it will tell you
 * it is testing the wrong runtime.
 *
 *   npm run verify:live
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const SD_NODE_DIR = join(
  homedir(),
  "Library",
  "Application Support",
  "com.elgato.StreamDeck",
  "NodeJS",
);

/** Newest Node that Stream Deck has installed, or null if it ships none here. */
function streamDeckNode() {
  if (!existsSync(SD_NODE_DIR)) return null;
  const versions = readdirSync(SD_NODE_DIR)
    .filter((v) => existsSync(join(SD_NODE_DIR, v, "node")))
    .sort();
  const newest = versions.at(-1);
  return newest ? join(SD_NODE_DIR, newest, "node") : null;
}

const here = dirname(fileURLToPath(import.meta.url));
const build = join(here, "..", ".build", "lib", "providers");

// Re-exec under Stream Deck's Node unless we are already there.
if (!process.env.SD_RUNTIME) {
  const sdNode = streamDeckNode();
  if (!sdNode) {
    console.error(
      "Could not find Stream Deck's bundled Node under\n  " +
        SD_NODE_DIR +
        "\nRefusing to verify against the wrong runtime — a 200 here would not mean the plugin works.",
    );
    process.exit(2);
  }
  console.log(`Re-running under Stream Deck's Node: ${sdNode}\n`);
  try {
    execFileSync(sdNode, [fileURLToPath(import.meta.url)], {
      stdio: "inherit",
      env: { ...process.env, SD_RUNTIME: "1" },
    });
  } catch {
    process.exit(1);
  }
  process.exit(0);
}

if (!existsSync(join(build, "codex.js"))) {
  console.error("No .build output. Run:  npx tsc --outDir .build --sourceMap false");
  process.exit(2);
}

console.log(`runtime: node ${process.version} (openssl ${process.versions.openssl})\n`);

const ATTEMPTS = 5;
let failed = false;

for (const name of ["codex", "claude"]) {
  const mod = await import(join(build, `${name}.js`));
  const provider = mod[`${name}Provider`];
  const results = [];

  for (let i = 0; i < ATTEMPTS; i++) {
    try {
      const s = await provider.fetchUsage({ allowRefresh: false });
      results.push({ ok: true, s });
    } catch (e) {
      results.push({ ok: false, kind: e.failure?.kind ?? "?", msg: e.message });
    }
    await new Promise((r) => setTimeout(r, 600));
  }

  const wins = results.filter((r) => r.ok).length;
  const last = results.at(-1);
  console.log(`${name}: ${wins}/${ATTEMPTS} succeeded`);
  if (last.ok) {
    const { sessionPct, weeklyPct, sessionResetAt, weeklyResetAt } = last.s;
    console.log(
      `  session=${sessionPct ?? "— (not reported)"}  weekly=${weeklyPct ?? "— (not reported)"}`,
    );
    console.log(`  resets: session=${sessionResetAt?.toISOString() ?? "—"} weekly=${weeklyResetAt?.toISOString() ?? "—"}`);
  } else {
    console.log(`  last failure [${last.kind}]: ${last.msg}`);
  }

  // A partial success is worse news than a clean failure: it means something
  // intermittent, which is exactly how the TLS fingerprint problem first
  // presented (a single lucky 200 among 403s read as "fixed").
  if (wins !== ATTEMPTS) failed = true;
  if (wins > 0 && wins < ATTEMPTS) {
    console.log("  WARNING: intermittent. Do not treat a partial pass as working.");
  }
  console.log();
}

process.exit(failed ? 1 : 0);
