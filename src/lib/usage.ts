import { readCredentials, CredentialsError, type Credentials } from "./credentials.js";
import { clamp, parseRepresentativeClaim, type BindingWindow } from "./format.js";

export type UsageSnapshot = {
  /** 0..100 utilisation of the rolling 5-hour session window. */
  sessionPct: number;
  /** 0..100 utilisation of the 7-day cap. */
  weeklyPct: number;
  sessionResetAt: Date | null;
  weeklyResetAt: Date | null;
  fetchedAt: Date;
  /** Anthropic's own view of the 5-hour window, e.g. "allowed" / "allowed_warning". */
  sessionStatus?: string | null;
  /** Anthropic's own view of the 7-day window. */
  weeklyStatus?: string | null;
  /** Which window Anthropic considers binding right now. */
  binding?: BindingWindow;
};

export type UsageFailure =
  /** Claude Code has never been logged into on this machine. */
  | { kind: "signed-out"; message: string }
  /** Credentials exist but the access token has expired; running `claude` fixes it. */
  | { kind: "stale"; message: string }
  /** Network, API, or parsing problem. */
  | { kind: "error"; message: string };

export class UsageError extends Error {
  readonly failure: UsageFailure;
  constructor(failure: UsageFailure) {
    super(failure.message);
    this.name = "UsageError";
    this.failure = failure;
  }
}

const API_URL = "https://api.anthropic.com/v1/messages";
const REFRESH_URL = "https://platform.claude.com/v1/oauth/token";

/**
 * Claude Code's public OAuth client id. Only used on the opt-in refresh path.
 */
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

/**
 * Treat a token as expired slightly early so a probe never races the boundary.
 */
const EXPIRY_LEEWAY_MS = 120_000;

/**
 * Models to probe with, tried in order.
 *
 * The completion is thrown away — we only want the response headers, which
 * Anthropic returns for any valid model. The list cascades to older Haiku
 * releases so the plugin survives a model deprecation without a code change.
 */
const PROBE_MODELS = ["claude-haiku-4-5", "claude-haiku-4-0", "claude-3-5-haiku-latest"];
let probeModelIndex = 0;

/**
 * In-memory credential cache.
 *
 * Reading the macOS keychain can pop an authorisation dialog, so we hold the
 * token for its full advertised lifetime rather than re-reading on every poll.
 * Cleared whenever the API rejects it, which forces a fresh read on the next
 * attempt (Claude Code may have rotated it in the meantime).
 */
let cached: Credentials | undefined;

function isExpired(creds: Credentials): boolean {
  // No expiry recorded means an older credential format; assume it is usable
  // and let a 401 tell us otherwise.
  if (creds.expiresAt === undefined) return false;
  return creds.expiresAt - EXPIRY_LEEWAY_MS <= Date.now();
}

/** Drop the cached token. Called after any 401 so the next poll re-reads. */
export function invalidateCredentialCache(): void {
  cached = undefined;
}

/**
 * Exchange the stored refresh token for a fresh access token, in memory only.
 *
 * This is deliberately opt-in (`allowRefresh`, default false). The plugin
 * never writes credentials back, so if Anthropic rotates the refresh token on
 * use, the copy Claude Code has on disk becomes stale and the CLI would need
 * a re-login. Leaving refresh off means the worst case is a key that reads
 * "run claude" for a moment instead of a CLI that has been logged out from
 * under you. Users who would rather have the key always live can turn it on.
 */
async function refreshInMemory(creds: Credentials): Promise<Credentials> {
  if (!creds.refreshToken) {
    throw new UsageError({
      kind: "stale",
      message: "access token expired and no refresh token is stored",
    });
  }

  const res = await fetch(REFRESH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: creds.refreshToken,
      client_id: CLIENT_ID,
    }),
  });

  const body = await res.text().catch(() => "");
  if (!res.ok) {
    throw new UsageError({
      kind: "stale",
      message: `token refresh failed (${res.status}): ${redact(body).slice(0, 160)}`,
    });
  }

  let parsed: { access_token?: string; refresh_token?: string; expires_in?: number };
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new UsageError({ kind: "error", message: "refresh response was not JSON" });
  }
  if (!parsed.access_token) {
    throw new UsageError({ kind: "error", message: "refresh response had no access_token" });
  }

  return {
    ...creds,
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token || creds.refreshToken,
    // Floor the lifetime so a server returning 0 cannot put us in a refresh loop.
    expiresAt:
      typeof parsed.expires_in === "number"
        ? Date.now() + Math.max(parsed.expires_in, 60) * 1000
        : undefined,
  };
}

/**
 * Produce a usable access token, reading from the credential store as needed.
 */
async function getToken(allowRefresh: boolean, forceReread: boolean): Promise<string> {
  if (forceReread) cached = undefined;

  if (cached === undefined || isExpired(cached)) {
    let fresh: Credentials;
    try {
      fresh = readCredentials();
    } catch (e) {
      if (e instanceof CredentialsError && e.notLoggedIn) {
        throw new UsageError({ kind: "signed-out", message: e.message });
      }
      throw new UsageError({ kind: "error", message: (e as Error).message });
    }

    // Claude Code refreshes its own token every time it runs, so a re-read is
    // usually all it takes to recover from expiry.
    if (isExpired(fresh)) {
      if (!allowRefresh) {
        throw new UsageError({
          kind: "stale",
          message: "stored access token has expired — run `claude` once to refresh it",
        });
      }
      fresh = await refreshInMemory(fresh);
    }
    cached = fresh;
  }

  return cached.accessToken;
}

/**
 * Fetch current usage by probing the Messages API and reading its rate-limit
 * headers.
 *
 * There is no dedicated usage endpoint for subscription limits, but every
 * `/v1/messages` response carries the unified 5-hour and 7-day utilisation
 * figures. So we send the smallest legal request (one character in, one token
 * out), throw the completion away, and keep the headers.
 *
 * The probe does consume a negligible slice of quota, and — worth knowing —
 * it counts as activity, so polling around the clock will keep a 5-hour
 * window nominally open. Polling only happens while a key is actually on
 * screen, and the interval is configurable, to keep that in the user's hands.
 */
export async function fetchUsage(allowRefresh = false): Promise<UsageSnapshot> {
  let token = await getToken(allowRefresh, false);
  let res = await probe(token);

  // A 401 means the token died before its stated expiry — most often because
  // Claude Code rotated it. Re-read the store and try exactly once more.
  if (res.status === 401) {
    invalidateCredentialCache();
    token = await getToken(allowRefresh, true);
    res = await probe(token);
    if (res.status === 401) {
      throw new UsageError({
        kind: "stale",
        message: "credentials rejected — run `claude` to sign in again",
      });
    }
  }

  // A model that no longer exists returns 4xx *without* rate-limit headers.
  // Walk the fallback list, but only when the headers really are missing —
  // Anthropic includes them on most 4xx responses, in which case the current
  // model is fine and the error is about something else.
  if ((res.status === 400 || res.status === 404) && !hasUsageHeaders(res)) {
    const startedAt = probeModelIndex;
    while (probeModelIndex + 1 < PROBE_MODELS.length) {
      probeModelIndex++;
      res = await probe(token);
      if (hasUsageHeaders(res)) break;
    }
    // Nothing in the list worked, so the 4xx was unrelated. Don't pin a
    // fallback model for the rest of the process lifetime over a blip.
    if (!hasUsageHeaders(res)) probeModelIndex = startedAt;
  }

  if (!hasUsageHeaders(res)) {
    throw new UsageError({
      kind: "error",
      message: `no rate-limit headers in response (HTTP ${res.status})`,
    });
  }

  return {
    sessionPct: parsePct(res.headers.get("anthropic-ratelimit-unified-5h-utilization")),
    weeklyPct: parsePct(res.headers.get("anthropic-ratelimit-unified-7d-utilization")),
    sessionResetAt: parseReset(res.headers.get("anthropic-ratelimit-unified-5h-reset")),
    weeklyResetAt: parseReset(res.headers.get("anthropic-ratelimit-unified-7d-reset")),
    fetchedAt: new Date(),
    // Stored raw, not mapped to a Severity here: the mapping lives in
    // format.ts so it stays unit-testable and so a future face could show
    // the raw string Anthropic sent.
    sessionStatus: res.headers.get("anthropic-ratelimit-unified-5h-status"),
    weeklyStatus: res.headers.get("anthropic-ratelimit-unified-7d-status"),
    binding: parseRepresentativeClaim(
      res.headers.get("anthropic-ratelimit-unified-representative-claim"),
    ),
  };
}

async function probe(accessToken: string): Promise<Response> {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      "anthropic-version": "2023-06-01",
      // Required for OAuth (as opposed to API-key) authentication.
      "anthropic-beta": "oauth-2025-04-20",
    },
    body: JSON.stringify({
      model: PROBE_MODELS[probeModelIndex],
      max_tokens: 1,
      messages: [{ role: "user", content: "." }],
    }),
  });
  // Drain the body so the connection can be reused; we only want headers.
  await res.text().catch(() => undefined);
  return res;
}

export function hasUsageHeaders(res: { headers: Headers }): boolean {
  return (
    res.headers.get("anthropic-ratelimit-unified-5h-utilization") !== null ||
    res.headers.get("anthropic-ratelimit-unified-7d-utilization") !== null
  );
}

/**
 * Parse a utilisation header into a 0..100 percentage.
 *
 * Anthropic documents these as a 0..1 fraction, but a value greater than 1 has
 * been observed, so anything above 1 is treated as an already-scaled
 * percentage rather than being multiplied into nonsense.
 */
export function parsePct(raw: string | null): number {
  if (raw === null) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return n > 1 ? clamp(n, 0, 100) : clamp(n * 100, 0, 100);
}

/** Parse a reset header, accepting ISO-8601 or Unix seconds. */
export function parseReset(raw: string | null): Date | null {
  if (!raw) return null;
  const asDate = new Date(raw);
  if (!Number.isNaN(asDate.getTime())) return asDate;
  const asSeconds = Number(raw);
  return Number.isFinite(asSeconds) ? new Date(asSeconds * 1000) : null;
}

/**
 * Strip anything token-shaped out of text bound for a log file.
 * Anthropic's errors do not echo credentials today; this is cheap insurance.
 */
function redact(s: string): string {
  return s.replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-***");
}
