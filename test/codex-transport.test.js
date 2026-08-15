import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

/**
 * A source-level guard, which is an unusual thing to write and is here for a
 * specific reason.
 *
 * The Codex usage endpoint sits behind Cloudflare, which rejects Node's
 * `fetch` (undici) with 403 no matter how valid the token is: measured 0/6
 * successful with fetch against 6/6 with node:https, back to back, same
 * credentials and headers. Python's urllib succeeds too, so the endpoint is
 * fine — undici specifically gets fingerprinted.
 *
 * Every other test in this repo feeds `mapUsagePayload` a fixture and never
 * opens a socket, so switching the transport back to `fetch` would leave the
 * entire suite green while the plugin failed 100% of the time on a real
 * machine. That gap is exactly what this file closes. It asserts on the
 * source text rather than behaviour because the alternative — a live network
 * call — would make the suite depend on the user being signed into Codex.
 */
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "src", "lib", "providers", "codex.ts"), "utf-8");

describe("codex transport", () => {
  it("does not call global fetch (Cloudflare 403s undici — see the comment on probe)", () => {
    // Deliberately matches `fetch(` and `await fetch(` but not the word
    // "fetch" inside identifiers like fetchCodexUsage or fetchUsage, which
    // are legitimate names in this file.
    const bareFetch = /(?<![A-Za-z0-9_.])fetch\s*\(/.exec(source);
    assert.equal(
      bareFetch,
      null,
      "codex.ts must use node:https, not global fetch: undici is blocked by Cloudflare with a 403 " +
        "that no unit test in this repo can observe, because they all run against fixtures",
    );
  });

  it("still sends an explicit User-Agent, the other half of clearing the 403", () => {
    assert.match(source, /"User-Agent":\s*USER_AGENT/);
    assert.match(source, /const USER_AGENT = "[^"]+";/);
  });

  it("bounds a request so one dead socket cannot stall every later poll", () => {
    assert.match(source, /setTimeout\(PROBE_TIMEOUT_MS/);
  });

  // A source-level guard for the same reason as the two above: getting a
  // live 403 out of Cloudflare on demand isn't something a unit test can
  // arrange, so this asserts on the code that would handle one instead of
  // the behaviour itself.
  it("maps a 403 to `blocked`, not `error` — a real block, not a rejected credential", () => {
    const match = /if \(res\.status === 403\) \{[\s\S]{0,300}?kind: "blocked"/.exec(source);
    assert.notEqual(
      match,
      null,
      "the 403 branch in fetchCodexUsage must throw a `blocked` UsageFailure, not `error`",
    );
  });
});
