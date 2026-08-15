import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

/**
 * A source-level guard, the same kind and for the same reason as
 * test/codex-transport.test.js: each property here protects against a
 * failure mode no behavioural test in this repo can observe (a lost write
 * race against the live CLI, a wedged subprocess, a plausible-looking
 * "improvement" that reads transcripts instead), so it asserts on the
 * source text instead of running the code. Do not modernise this file
 * away — a green suite with these assertions removed would still look
 * green while shipping a regression none of the other tests can catch.
 */
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "src", "lib", "sessions.ts"), "utf-8");

describe("sessions.ts source guard", () => {
  it("never writes, unlinks, renames, or opens a write stream on the registry it only reads", () => {
    // ~/.claude/sessions/<pid>.json is owned by the live `claude` CLI, which
    // rewrites each file on every status transition. Losing a write race
    // against it is exactly the harm codex.ts and credentials.ts already
    // document twice for their own read-only files.
    const writeLike =
      /\b(writeFileSync|writeFile|unlinkSync|unlink|renameSync|rename|createWriteStream)\s*\(/.exec(
        source,
      );
    assert.equal(
      writeLike,
      null,
      "sessions.ts must never write/unlink/rename a registry file or open a write stream — " +
        `found a match for ${writeLike ? writeLike[0] : ""}. Losing a write race against the ` +
        "live claude CLI, which owns these files, is the harm this guard exists to prevent.",
    );
  });

  it("bounds the ps call with an explicit timeout", () => {
    const psCall = /execFile\(\s*["'`][^"'`]*\/ps["'`][\s\S]{0,300}?\)/.exec(source);
    assert.notEqual(psCall, null, "expected an execFile(\"/bin/ps\", ...) call in sessions.ts");
    assert.match(
      psCall[0],
      /timeout\s*:/,
      "the execFile(\"/bin/ps\", ...) call must pass an explicit `timeout` — a wedged `ps` " +
        "would stall every later poll behind it",
    );
  });

  it("never reads .jsonl transcripts to infer session state", () => {
    assert.equal(
      source.includes(".jsonl"),
      false,
      "reading transcripts was measured as actively misleading: a blocked permission prompt " +
        "writes nothing to the transcript, so inferring state from it would report a stuck " +
        "session as idle instead of waiting. This is a plausible-looking 'improvement' that no " +
        "behavioural test would object to — hence the guard.",
    );
  });
});
