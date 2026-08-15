import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  checkCredentials,
  classifyProbeError,
  jwtAccountId,
  jwtExpirySeconds,
  mapUsagePayload,
  parseCodexAuthFile,
  readCodexCredentialsFile,
} from "../.build/lib/providers/codex.js";

/** Build an unsigned JWT with the given payload, base64url-encoded like a real one. */
function fakeJwt(payload) {
  const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${b64url({ alg: "none" })}.${b64url(payload)}.signature`;
}

// The exact payload observed from GET https://chatgpt.com/backend-api/codex/usage,
// redacted. primary_window carries limit_window_seconds: 604800 (7 days) —
// the WEEKLY window sitting in the "primary" slot, confirmed independently
// via the x-codex-primary-window-minutes header on a different endpoint.
const REAL_PAYLOAD = {
  user_id: "u",
  account_id: "a",
  email: "e",
  plan_type: "plus",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 0,
      limit_window_seconds: 604800,
      reset_after_seconds: 604798,
      reset_at: 1787370966,
    },
    secondary_window: null,
  },
  code_review_rate_limit: null,
  additional_rate_limits: null,
  credits: { has_credits: false, unlimited: false, overage_limit_reached: false, balance: "0" },
  spend_control: { reached: false, individual_limit: null },
  rate_limit_reached_type: null,
  promo: null,
};

describe("mapUsagePayload", () => {
  const now = new Date("2026-08-14T00:00:00Z");

  it("classifies the real payload's primary_window as weekly despite the slot name", () => {
    // This is the whole trap: OpenAI puts the 7-day window under "primary".
    // Trusting the slot name instead of limit_window_seconds would silently
    // swap this onto sessionPct instead.
    const snapshot = mapUsagePayload(REAL_PAYLOAD, now);
    assert.equal(snapshot.weeklyPct, 0);
    assert.equal(snapshot.sessionPct, null);
  });

  it("treats a null secondary_window as 'not reported', not 0%", () => {
    const snapshot = mapUsagePayload(REAL_PAYLOAD, now);
    assert.equal(snapshot.sessionPct, null);
    assert.notEqual(snapshot.sessionPct, 0);
  });

  it("parses reset_at as Unix seconds via the shared parseReset", () => {
    const snapshot = mapUsagePayload(REAL_PAYLOAD, now);
    assert.equal(snapshot.weeklyResetAt?.getTime(), 1787370966 * 1000);
  });

  it("falls back to reset_after_seconds when reset_at is absent or 0", () => {
    const payload = {
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: {
          used_percent: 10,
          limit_window_seconds: 604800,
          reset_after_seconds: 3600,
          reset_at: 0,
        },
        secondary_window: null,
      },
    };
    const snapshot = mapUsagePayload(payload, now);
    assert.equal(snapshot.weeklyResetAt?.getTime(), now.getTime() + 3600 * 1000);
  });

  it("classifies by duration, not by slot name, in both directions", () => {
    // Session window placed in "secondary", weekly in "primary" — the
    // observed real-world arrangement.
    const swapped = {
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: { used_percent: 20, limit_window_seconds: 604800 },
        secondary_window: { used_percent: 55, limit_window_seconds: 18000 },
      },
    };
    let snapshot = mapUsagePayload(swapped, now);
    assert.equal(snapshot.weeklyPct, 20);
    assert.equal(snapshot.sessionPct, 55);

    // Same two windows, opposite slots — the classifier must not care.
    const straight = {
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: { used_percent: 55, limit_window_seconds: 18000 },
        secondary_window: { used_percent: 20, limit_window_seconds: 604800 },
      },
    };
    snapshot = mapUsagePayload(straight, now);
    assert.equal(snapshot.weeklyPct, 20);
    assert.equal(snapshot.sessionPct, 55);
  });

  it("ignores a window whose duration matches neither band", () => {
    // 12 hours: above the 6h session ceiling, below the 24h weekly floor.
    const payload = {
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: { used_percent: 40, limit_window_seconds: 12 * 3600 },
        secondary_window: null,
      },
    };
    const snapshot = mapUsagePayload(payload, now);
    assert.equal(snapshot.sessionPct, null);
    assert.equal(snapshot.weeklyPct, null);
  });

  it("treats used_percent as already 0..100, never multiplying by 100", () => {
    const payload = {
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: { used_percent: 42, limit_window_seconds: 604800 },
        secondary_window: null,
      },
    };
    assert.equal(mapUsagePayload(payload, now).weeklyPct, 42);
  });

  it("maps limit_reached to a status severityFromStatus already treats as critical", () => {
    const payload = {
      rate_limit: {
        allowed: false,
        limit_reached: true,
        primary_window: { used_percent: 100, limit_window_seconds: 604800 },
        secondary_window: null,
      },
    };
    const snapshot = mapUsagePayload(payload, now);
    assert.equal(snapshot.weeklyStatus, "limit_reached");
    assert.equal(snapshot.sessionStatus, "limit_reached");
  });

  it("maps a plain allowed response to 'allowed'", () => {
    const snapshot = mapUsagePayload(REAL_PAYLOAD, now);
    assert.equal(snapshot.weeklyStatus, "allowed");
  });

  it("binds to the single reported window, and stays null when both or neither are reported", () => {
    // Exactly one window reported (the common real-world shape): binding.
    assert.equal(mapUsagePayload(REAL_PAYLOAD, now).binding, "weekly");

    // Both reported: no per-window signal exists to pick one, so null —
    // never guessed from whichever percentage happens to be higher.
    const both = {
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: { used_percent: 90, limit_window_seconds: 604800 },
        secondary_window: { used_percent: 10, limit_window_seconds: 18000 },
      },
    };
    assert.equal(mapUsagePayload(both, now).binding, null);

    // Neither reported.
    const neither = { rate_limit: { allowed: true, limit_reached: false } };
    assert.equal(mapUsagePayload(neither, now).binding, null);
  });

  it("survives a malformed or empty payload without throwing", () => {
    assert.doesNotThrow(() => mapUsagePayload({}, now));
    assert.doesNotThrow(() => mapUsagePayload(null, now));
    assert.doesNotThrow(() => mapUsagePayload("garbage", now));
    const snapshot = mapUsagePayload({}, now);
    assert.equal(snapshot.sessionPct, null);
    assert.equal(snapshot.weeklyPct, null);
    assert.equal(snapshot.binding, null);
  });
});

describe("parseCodexAuthFile", () => {
  it("parses the documented chatgpt auth_mode shape", () => {
    const raw = JSON.stringify({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: "x",
        access_token: "at",
        refresh_token: "rt",
        account_id: "acct-1",
      },
      last_refresh: "2026-08-06T19:39:33.968742Z",
    });
    const creds = parseCodexAuthFile(raw);
    assert.equal(creds.authMode, "chatgpt");
    assert.equal(creds.accessToken, "at");
    assert.equal(creds.accountId, "acct-1");
  });

  it("parses the apikey auth_mode shape", () => {
    const raw = JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-...", tokens: null });
    const creds = parseCodexAuthFile(raw);
    assert.equal(creds.authMode, "apikey");
    assert.equal(creds.accessToken, "");
  });

  it("throws a plain Error on invalid JSON", () => {
    assert.throws(() => parseCodexAuthFile("not json"), /not valid JSON/);
  });
});

describe("readCodexCredentialsFile", () => {
  it("maps a missing file to a signed-out UsageError", () => {
    assert.throws(
      () => readCodexCredentialsFile("/nonexistent/path/does-not-exist/auth.json"),
      (e) => e.failure?.kind === "signed-out",
    );
  });

  it("reads and parses a real file on disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-auth-"));
    const file = join(dir, "auth.json");
    try {
      writeFileSync(
        file,
        JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "at", account_id: "acct-1" } }),
      );
      const creds = readCodexCredentialsFile(file);
      assert.equal(creds.accessToken, "at");
      assert.equal(creds.accountId, "acct-1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("maps invalid JSON on disk to an error UsageError", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-auth-"));
    const file = join(dir, "auth.json");
    try {
      writeFileSync(file, "not json");
      assert.throws(() => readCodexCredentialsFile(file), (e) => e.failure?.kind === "error");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("checkCredentials", () => {
  const now = new Date("2026-08-14T00:00:00Z");

  it("refuses an apikey auth_mode without ever needing a network call", () => {
    const failure = checkCredentials({ authMode: "apikey", accessToken: "" }, now);
    // no-plan, not error: an API key has no ChatGPT subscription behind it,
    // so this can never resolve into a real reading — it must not be lumped
    // in with retryable/transient problems.
    assert.equal(failure?.kind, "no-plan");
    assert.match(failure.message, /API key/);
  });

  it("reports signed-out when there is no access token", () => {
    const failure = checkCredentials({ authMode: "chatgpt", accessToken: "" }, now);
    assert.equal(failure?.kind, "signed-out");
  });

  it("reports stale for an expired JWT and tells the user to run codex", () => {
    const expired = fakeJwt({ exp: Math.floor(now.getTime() / 1000) - 3600 });
    const failure = checkCredentials({ authMode: "chatgpt", accessToken: expired }, now);
    assert.equal(failure?.kind, "stale");
    assert.match(failure.message, /run `codex`/);
  });

  it("passes a token that expires well in the future", () => {
    const fresh = fakeJwt({ exp: Math.floor(now.getTime() / 1000) + 3600 });
    const failure = checkCredentials({ authMode: "chatgpt", accessToken: fresh }, now);
    assert.equal(failure, null);
  });

  it("does not treat a token with no exp claim as expired", () => {
    // An older or nonstandard token shape; letting a 401 report the real
    // problem beats guessing expiry from a missing claim.
    const noExp = fakeJwt({ sub: "x" });
    const failure = checkCredentials({ authMode: "chatgpt", accessToken: noExp }, now);
    assert.equal(failure, null);
  });
});

describe("jwtExpirySeconds", () => {
  it("extracts the exp claim from a well-formed JWT", () => {
    const token = fakeJwt({ exp: 1787370966 });
    assert.equal(jwtExpirySeconds(token), 1787370966);
  });

  it("returns null for a token that isn't JWT-shaped", () => {
    assert.equal(jwtExpirySeconds("not-a-jwt"), null);
    assert.equal(jwtExpirySeconds(""), null);
  });
});

describe("classifyProbeError", () => {
  // These are the codes `req.on("error", ...)` in `probe` can hand back for
  // a socket that never reached the endpoint at all — the user's network,
  // not the plugin.
  for (const code of ["ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"]) {
    it(`maps ${code} to offline`, () => {
      const err = Object.assign(new Error(`simulated ${code}`), { code });
      const failure = classifyProbeError(err);
      assert.equal(failure.kind, "offline");
    });
  }

  it("maps the request-timeout Error (no .code, message-identified) to offline", () => {
    // Mirrors exactly what `probe`'s req.setTimeout callback constructs.
    const err = new Error("Codex usage request timed out after 15000ms");
    assert.equal(classifyProbeError(err).kind, "offline");
  });

  it("falls back to error for a network failure that isn't one of the offline codes", () => {
    const err = Object.assign(new Error("something else broke"), { code: "EPIPE" });
    assert.equal(classifyProbeError(err).kind, "error");
  });

  it("carries the original error message into the failure", () => {
    const err = Object.assign(new Error("simulated ENOTFOUND"), { code: "ENOTFOUND" });
    assert.match(classifyProbeError(err).message, /simulated ENOTFOUND/);
  });
});

describe("jwtAccountId", () => {
  it("reads the chatgpt_account_id claim as a fallback", () => {
    const token = fakeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-9" } });
    assert.equal(jwtAccountId(token), "acct-9");
  });

  it("returns undefined when the claim is absent", () => {
    const token = fakeJwt({ sub: "x" });
    assert.equal(jwtAccountId(token), undefined);
  });
});
