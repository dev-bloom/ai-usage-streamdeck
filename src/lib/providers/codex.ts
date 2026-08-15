/**
 * Codex usage provider.
 *
 * Split the way terminal.ts and view.ts are split: `mapUsagePayload` and
 * `parseCodexAuthFile` are pure (no network, no fs) so the interesting
 * logic — window classification, percentage scaling, failure mapping — is
 * unit-testable against fixtures, and a thin wrapper below does the actual
 * fetch and file read.
 *
 * Unlike Claude, Codex has a dedicated read-only usage endpoint, so there is
 * no throwaway probe and polling it costs no quota (see pollCostsQuota on
 * the Provider this file exports).
 */
import { readFileSync } from "node:fs";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";

import { clamp, type BindingWindow } from "../format.js";
import { UsageError, parseReset, type UsageFailure, type UsageSnapshot } from "../usage.js";
import type { Provider } from "./index.js";

/**
 * Codex owns this file and rewrites it whenever it refreshes tokens. This
 * plugin only ever reads it — the same rule and the same reason as
 * credentials.ts's keychain read: a lost write race would log the user out
 * of their own Codex CLI, which is a far worse failure than a stale number
 * on a key.
 */
const AUTH_FILE = join(homedir(), ".codex", "auth.json");

const USAGE_URL = "https://chatgpt.com/backend-api/codex/usage";

/**
 * Cloudflare rejects a request to this endpoint with 403 when the
 * User-Agent is absent or a client default, even with a fully valid token —
 * measured, not assumed. Sending an explicit one is half of what gets a
 * 200; the other half is not using `fetch` at all (see `probe`).
 *
 * This string is not confirmed to be what the real Codex CLI sends; it only
 * has to be a plausible non-default value.
 */
const USER_AGENT = "codex_cli_rs/0.0.0";

/** Cap on a single usage request, so one dead socket cannot stall the poll timer behind it. */
const PROBE_TIMEOUT_MS = 15_000;

/** Mirrors usage.ts's EXPIRY_LEEWAY_MS: never let a poll race the exact expiry boundary. */
const EXPIRY_LEEWAY_MS = 120_000;

/** limit_window_seconds at or below this is the rolling session window. */
const SESSION_MAX_SECONDS = 6 * 3600;
/** limit_window_seconds at or above this is the weekly cap. */
const WEEKLY_MIN_SECONDS = 24 * 3600;

export type CodexCredentials = {
  /** "chatgpt" for OAuth, "apikey" for a bare OPENAI_API_KEY, or "unknown" for an unrecognised/missing value. */
  authMode: string;
  /** Empty string when the file has no access token at all. */
  accessToken: string;
  /** From tokens.account_id; the JWT claim is only consulted as a fallback (see jwtAccountId). */
  accountId?: string;
};

/**
 * Parse the contents of ~/.codex/auth.json. Pure: takes the file's text
 * directly so payload shapes can be covered by fixtures without touching
 * disk.
 */
export function parseCodexAuthFile(raw: string): CodexCredentials {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`~/.codex/auth.json is not valid JSON: ${(e as Error).message}`);
  }

  const tokens = (parsed.tokens && typeof parsed.tokens === "object"
    ? parsed.tokens
    : {}) as Record<string, unknown>;

  return {
    authMode: str(parsed.auth_mode) ?? "unknown",
    accessToken: str(tokens.access_token) ?? "",
    accountId: str(tokens.account_id),
  };
}

/**
 * Decode a JWT's payload segment without verifying its signature. We only
 * ever read the `exp` claim and an account-id fallback out of it; this
 * plugin has no key to verify against and the actual authorization check
 * happens server-side regardless, so signature verification would add
 * complexity without adding safety.
 */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const segment = token.split(".")[1];
  if (!segment) return null;
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf-8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

/** The `exp` claim (Unix seconds), or null if the token isn't a parseable JWT. */
export function jwtExpirySeconds(token: string): number | null {
  const exp = decodeJwtPayload(token)?.exp;
  return typeof exp === "number" ? exp : null;
}

/**
 * Fallback account id from the JWT's `https://api.openai.com/auth` claim.
 * Only consulted when auth.json's own tokens.account_id is missing — the
 * file's value is authoritative because it's what the Codex CLI itself
 * reads.
 */
export function jwtAccountId(token: string): string | undefined {
  const claim = decodeJwtPayload(token)?.["https://api.openai.com/auth"];
  if (!claim || typeof claim !== "object") return undefined;
  return str((claim as Record<string, unknown>).chatgpt_account_id);
}

/**
 * Decide whether already-parsed credentials are usable, before ever sending
 * a request. Pure and exported so the apikey refusal and expiry check are
 * testable without touching the filesystem or the network. `now` is
 * injectable for deterministic expiry tests.
 */
export function checkCredentials(
  creds: CodexCredentials,
  now: Date = new Date(),
): UsageFailure | null {
  if (creds.authMode === "apikey") {
    // Sending the request anyway and letting it fail would still cost a
    // network round trip to report a fact we already know from the file:
    // this endpoint reports ChatGPT subscription rate limits, and an API
    // key has no ChatGPT subscription behind it. `no-plan`, not `error`: no
    // amount of retrying, re-authenticating, or checking the network fixes
    // this — there is nothing to fetch.
    return {
      kind: "no-plan",
      message:
        "Codex is signed in with an API key (OPENAI_API_KEY) — the usage endpoint reports ChatGPT subscription limits, which an API key account has none of",
    };
  }

  if (!creds.accessToken) {
    return {
      kind: "signed-out",
      message:
        "no Codex credentials found — sign in to Codex via the ChatGPT app (or run `codex` if the standalone CLI is installed)",
    };
  }

  const exp = jwtExpirySeconds(creds.accessToken);
  if (exp !== null && exp * 1000 - EXPIRY_LEEWAY_MS <= now.getTime()) {
    // No token-refresh path for Codex (see fetchCodexUsage): the standalone
    // CLI is known to refresh its own token on every launch. Whether opening
    // the ChatGPT app does the same has not been verified on this machine —
    // see the note in DEVELOPMENT.md.
    return {
      kind: "stale",
      message:
        "Codex access token has expired — open the ChatGPT app to refresh it (or run `codex` once if the standalone CLI is installed)",
    };
  }

  return null;
}

/**
 * In-memory credential cache, mirroring usage.ts's `cached`. Less critical
 * here — reading a plaintext file never pops a permission dialog the way
 * the keychain does — but re-parsing and re-decoding a JWT on every 15s
 * tick is needless work, and caching keeps the two providers symmetric.
 */
let cached: CodexCredentials | undefined;

/** Drop the cached credentials. Called after a 401 so the next poll re-reads the file. */
export function invalidateCredentialCache(): void {
  cached = undefined;
}

/**
 * Read and parse the auth file at `path`. Split out from `loadCredentials`
 * only so tests can point it at a fixture file instead of the real
 * ~/.codex/auth.json.
 */
export function readCodexCredentialsFile(path: string): CodexCredentials {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      throw new UsageError({
        kind: "signed-out",
        message:
          "no Codex credentials found — sign in to Codex via the ChatGPT app (or run `codex` if the standalone CLI is installed)",
      });
    }
    throw new UsageError({ kind: "error", message: `reading ${path}: ${err.message}` });
  }

  try {
    return parseCodexAuthFile(raw);
  } catch (e) {
    throw new UsageError({ kind: "error", message: (e as Error).message });
  }
}

function loadCredentials(forceReread: boolean): CodexCredentials {
  if (forceReread) cached = undefined;
  if (cached === undefined) cached = readCodexCredentialsFile(AUTH_FILE);
  return cached;
}

/** Just enough of a response to decide what happened; we only ever want status + body. */
type ProbeResult = { status: number; body: string };

/**
 * Sent on every request. `originator` and the User-Agent identify us the way
 * the Codex CLI identifies itself; see the block comment on `probe` for why
 * the exact set and their order are load-bearing.
 */
function probeHeaders(accessToken: string, accountId: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "chatgpt-account-id": accountId,
    Accept: "application/json",
    originator: "codex_cli_rs",
    "User-Agent": USER_AGENT,
  };
}

/**
 * Deliberately `node:https` rather than global `fetch`.
 *
 * This is not a style preference and must not be "modernised" back to fetch.
 * Cloudflare sits in front of this endpoint and rejects Node's fetch
 * (undici) with 403 regardless of the token: measured 0/6 successful with
 * fetch against 6/6 with node:https, back to back, same credentials, same
 * headers, same machine. Python's urllib also succeeds, so the endpoint is
 * fine — it is specifically undici that gets fingerprinted, presumably on
 * its TLS/ALPN signature and the headers it injects on its own
 * (`accept-language: *` among them), none of which a caller can fully
 * suppress through the fetch API.
 *
 * The reason this is worth so many lines: it fails *only* against the real
 * endpoint. Every unit test in this repo feeds `mapUsagePayload` a fixture
 * and passes either way, so a switch back to fetch would ship a plugin that
 * is broken 100% of the time behind a fully green suite. Adding an
 * `accept-language` header appears to fix it and does not — that combination
 * measured 403/200/403, i.e. noise.
 */
/**
 * `ALPNProtocols` is honoured at runtime but lives on tls.ConnectionOptions,
 * which @types/node does not fold into https.RequestOptions — hence the
 * widened type rather than a cast that would hide a real typo.
 */
type ProbeOptions = RequestOptions & { ALPNProtocols?: string[] };

function probe(accessToken: string, accountId: string): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const options: ProbeOptions = {
      method: "GET",
      headers: probeHeaders(accessToken, accountId),
      // Load-bearing, and the least obvious line in this file.
      //
      // Cloudflare fingerprints the TLS ClientHello, and Node's *default*
      // hello is what gets blocked — which Node build you are on therefore
      // decides whether this endpoint works at all. Measured on this
      // machine, same code, same credentials, back to back:
      //
      //   Node 20.20.0 (the runtime Stream Deck actually ships)  0/5 → 403
      //   Node 24.19.0 (a dev shell)                             5/5 → 200
      //
      // Pinning ALPN to http/1.1 perturbs the hello enough to pass, and
      // measured 5/5 on BOTH runtimes, which is why it is the fix chosen
      // over the two other things that also worked on 20 (minVersion
      // TLSv1.3, a reordered ecdhCurve) — neither of those was verified to
      // be harmless on every runtime, and this one at least states a true
      // intention: node:https speaks HTTP/1.1 here regardless.
      //
      // Do not "simplify" this away. It costs nothing and its absence is a
      // 403 that reads exactly like an auth failure. `curl` is not an
      // escape hatch either — the system curl measured 0/5 against this
      // same endpoint.
      ALPNProtocols: ["http/1.1"],
    };

    const req = httpsRequest(USAGE_URL, options, (res) => {
      let body = "";
      res.setEncoding("utf-8");
      res.on("data", (chunk: string) => {
        body += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });

    req.on("error", (e) => reject(e));
    // The store polls on a timer, so a request left hanging on a dead socket
    // would stall every later poll behind it rather than failing one tick.
    req.setTimeout(PROBE_TIMEOUT_MS, () => {
      req.destroy(new Error(`Codex usage request timed out after ${PROBE_TIMEOUT_MS}ms`));
    });
    req.end();
  });
}

/**
 * Error codes that mean "this machine couldn't reach the endpoint at all",
 * as opposed to the endpoint answering and rejecting us. Node's `req.on(
 * "error", ...)` in `probe` surfaces these on the raw socket error; the
 * request timeout `probe` sets (see PROBE_TIMEOUT_MS) raises a plain `Error`
 * with no `code` at all, identified below by the message it's constructed
 * with instead.
 */
const OFFLINE_ERROR_CODES = new Set(["ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"]);

/**
 * Turn whatever `probe` rejected with into a UsageFailure, without touching
 * `probe` itself. Exported so the classification can be unit-tested against
 * synthetic errors instead of requiring an actual dead socket.
 */
export function classifyProbeError(e: unknown): UsageFailure {
  const err = e as NodeJS.ErrnoException;
  const code = err?.code;
  const message = err?.message ?? String(e);
  if ((code && OFFLINE_ERROR_CODES.has(code)) || /timed out/i.test(message)) {
    return { kind: "offline", message: `Codex usage request failed: ${message}` };
  }
  return { kind: "error", message: `Codex usage request failed: ${message}` };
}

/** Thin wrapper so a `probe` rejection becomes a classified UsageError, without editing `probe` itself. */
async function probeOrThrow(accessToken: string, accountId: string): Promise<ProbeResult> {
  try {
    return await probe(accessToken, accountId);
  } catch (e) {
    throw new UsageError(classifyProbeError(e));
  }
}

/**
 * Fetch current Codex usage from the dedicated endpoint.
 *
 * `allowRefresh` is part of the shared Provider signature but is ignored
 * here on purpose: Claude's refresh path uses Claude Code's known public
 * OAuth client id, and no equivalent id for the Codex CLI could be verified.
 * Shipping a guessed client id and minting tokens against it is worse than
 * the failure mode it would prevent — a Codex access token lasts roughly 10
 * days (measured from a real token's `iat`/`exp` claims), and the CLI
 * refreshes its own token every time it runs, so a `stale` key clears with
 * one `codex` invocation and, at that lifetime, is rare to begin with.
 */
export async function fetchCodexUsage(_opts: { allowRefresh: boolean }): Promise<UsageSnapshot> {
  let creds = loadCredentials(false);
  let failure = checkCredentials(creds);
  if (failure) throw new UsageError(failure);

  let accountId = creds.accountId ?? jwtAccountId(creds.accessToken);
  if (!accountId) {
    throw new UsageError({
      kind: "error",
      message: "no Codex account id in credentials or access token",
    });
  }

  let res = await probeOrThrow(creds.accessToken, accountId);

  // A 401 most likely means the CLI rotated the file since we cached it.
  // Re-read once and retry exactly once, the same shape as usage.ts's own
  // 401 handling for Claude.
  if (res.status === 401) {
    invalidateCredentialCache();
    creds = loadCredentials(true);
    failure = checkCredentials(creds);
    if (failure) throw new UsageError(failure);

    accountId = creds.accountId ?? jwtAccountId(creds.accessToken);
    if (!accountId) {
      throw new UsageError({
        kind: "error",
        message: "no Codex account id in credentials or access token",
      });
    }

    res = await probeOrThrow(creds.accessToken, accountId);
    if (res.status === 401) {
      throw new UsageError({
        kind: "stale",
        message:
          "Codex credentials rejected — sign in again via the ChatGPT app (or run `codex` if the standalone CLI is installed)",
      });
    }
  }

  // TRAP: this endpoint returns 403 from Cloudflare under a default/absent
  // User-Agent even with a completely valid token — same URL, same token,
  // only the header differs. It looks exactly like an auth failure and
  // isn't one; the message below exists so the next person doesn't spend an
  // hour on it the way this was verified the first time. `blocked`, not
  // `error`, so the card can say so instead of sending someone to re-sign in.
  if (res.status === 403) {
    throw new UsageError({
      kind: "blocked",
      message:
        "Codex usage endpoint returned 403 — this is almost always a default/missing User-Agent header being blocked by Cloudflare, not a real auth failure; see USER_AGENT in codex.ts",
    });
  }

  if (res.status < 200 || res.status >= 300) {
    throw new UsageError({ kind: "error", message: `Codex usage request failed (HTTP ${res.status})` });
  }

  let json: unknown;
  try {
    json = JSON.parse(res.body);
  } catch {
    throw new UsageError({ kind: "error", message: "Codex usage response was not JSON" });
  }

  return mapUsagePayload(json, new Date());
}

type RawWindow = Record<string, unknown>;
type ClassifiedWindow = { kind: "session" | "weekly" | "ignore"; window: RawWindow };

/**
 * Classify a rate-limit window by its duration, never by which JSON slot
 * ("primary_window" vs. "secondary_window") it arrived in. OpenAI has been
 * observed putting the WEEKLY window in the "primary" slot and leaving
 * "secondary" null — confirmed independently via the
 * x-codex-primary-window-minutes response header on a different endpoint —
 * which is the opposite of what the names suggest. Trusting the slot name
 * would silently swap the user's 5-hour and weekly numbers.
 */
function classifyWindow(raw: unknown): ClassifiedWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const window = raw as RawWindow;
  const seconds = num(window.limit_window_seconds);
  if (seconds === undefined) return null;
  if (seconds <= SESSION_MAX_SECONDS) return { kind: "session", window };
  if (seconds >= WEEKLY_MIN_SECONDS) return { kind: "weekly", window };
  // A duration between the two bands is not one we recognise as either
  // window; ignoring it is safer than guessing which one it was meant to be.
  return { kind: "ignore", window };
}

function pickWindow(
  primary: ClassifiedWindow | null,
  secondary: ClassifiedWindow | null,
  kind: "session" | "weekly",
): RawWindow | null {
  if (primary?.kind === kind) return primary.window;
  if (secondary?.kind === kind) return secondary.window;
  return null;
}

function usedPercent(window: RawWindow): number | null {
  // Codex reports used_percent already on a 0..100 scale — unlike
  // Anthropic's 0..1 fraction. Multiplying by 100 here would be
  // double-scaling, not a fix; parsePct in usage.ts is deliberately not
  // reused for this reason.
  const pct = num(window.used_percent);
  return pct === undefined ? null : clamp(pct, 0, 100);
}

function windowResetAt(window: RawWindow, now: Date): Date | null {
  // reset_at is Unix seconds — the exact shape usage.ts's parseReset already
  // handles, so it's reused rather than writing a second parser.
  const resetAtSeconds = num(window.reset_at);
  if (resetAtSeconds !== undefined && resetAtSeconds > 0) {
    return parseReset(String(resetAtSeconds));
  }
  // reset_at can be absent or 0 while reset_after_seconds is still present;
  // derive the same answer relative to "now" rather than reporting no reset
  // time at all.
  const resetAfter = num(window.reset_after_seconds);
  if (resetAfter !== undefined && resetAfter >= 0) {
    return new Date(now.getTime() + resetAfter * 1000);
  }
  return null;
}

/**
 * Which window is binding, or null. Only two shapes of evidence are
 * actually knowable from this payload without guessing: when just one of
 * the two windows is reported at all, there is nothing else it could be.
 * `rate_limit_reached_type` might one day name the enforced window, but it
 * was never observed non-null while measuring this endpoint, so trusting it
 * would be exactly the kind of guess this function is here to avoid — same
 * as never picking a binding window from whichever percentage is higher.
 */
function bindingFor(sessionWindow: RawWindow | null, weeklyWindow: RawWindow | null): BindingWindow {
  if (sessionWindow && !weeklyWindow) return "session";
  if (weeklyWindow && !sessionWindow) return "weekly";
  return null;
}

/**
 * Map a parsed usage-endpoint response into a UsageSnapshot. Pure: no
 * network, no fs, no Date.now() — `now` is passed in.
 */
export function mapUsagePayload(json: unknown, now: Date): UsageSnapshot {
  const obj = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  const rateLimit = (obj.rate_limit && typeof obj.rate_limit === "object"
    ? obj.rate_limit
    : {}) as Record<string, unknown>;

  const primary = classifyWindow(rateLimit.primary_window);
  // secondary_window is frequently null in practice ("I could not get it to
  // populate" — this means "not reported", not "0% used"); classifyWindow
  // returns null for it either way, which pickWindow already treats as
  // "this window wasn't found here".
  const secondary = classifyWindow(rateLimit.secondary_window);

  const sessionWindow = pickWindow(primary, secondary, "session");
  const weeklyWindow = pickWindow(primary, secondary, "weekly");

  const allowed = rateLimit.allowed === true;
  const limitReached = rateLimit.limit_reached === true;
  // "limit_reached" deliberately contains the substring "limit" and
  // "allowed" is the exact string format.ts's severityFromStatus already
  // maps to ok/crit — reusing those strings means format.ts needs no
  // Codex-specific severity path.
  const status = limitReached ? "limit_reached" : allowed ? "allowed" : null;

  return {
    sessionPct: sessionWindow ? usedPercent(sessionWindow) : null,
    weeklyPct: weeklyWindow ? usedPercent(weeklyWindow) : null,
    sessionResetAt: sessionWindow ? windowResetAt(sessionWindow, now) : null,
    weeklyResetAt: weeklyWindow ? windowResetAt(weeklyWindow, now) : null,
    fetchedAt: now,
    // rate_limit reports allowed/limit_reached once for the whole account,
    // not per window, so both statuses carry the same value — there is only
    // one enforcement decision in this payload, not two.
    sessionStatus: status,
    weeklyStatus: status,
    binding: bindingFor(sessionWindow, weeklyWindow),
  };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export const codexProvider: Provider = {
  id: "codex",
  label: "Codex",
  // Codex now ships inside the ChatGPT desktop app; the standalone `codex`
  // CLI is optional and, on this machine, currently broken (see
  // DEVELOPMENT.md). "run codex" would send someone to run a command that
  // fails, so the hint points at the app that's actually known to work.
  signInHint: "open ChatGPT",
  fetchUsage: fetchCodexUsage,
  invalidateCredentialCache,
  // Measured on a ChatGPT Plus account, three independent ways: the usage
  // endpoint returns secondary_window: null (before *and* after real token
  // spend), the responses endpoint sends x-codex-secondary-window-minutes: 0,
  // and the ChatGPT app's own "Usage remaining" menu lists a Weekly row and
  // nothing else. A 5-hour window is not merely unobserved here, it is absent
  // — so the default face shows the window that exists.
  defaultMode: "weekly",
  supportedModes: ["weekly"],
  pollCostsQuota: false,
};
