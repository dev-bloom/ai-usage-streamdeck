import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { join } from "node:path";

/**
 * Where Claude Code stores its OAuth credentials.
 *
 * On macOS this is a generic keychain item; the JSON blob lives in the
 * password field. Some installations (and every non-macOS one) use a plain
 * file instead, so we support both and prefer whichever the platform makes
 * canonical.
 */
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const CREDENTIALS_FILE = join(homedir(), ".claude", ".credentials.json");

export type Credentials = {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds. Undefined when the stored blob predates this field. */
  expiresAt?: number;
  /** Which backing store the credentials came from — surfaced in diagnostics. */
  source: "keychain" | "file";
};

export class CredentialsError extends Error {
  /** True when the user simply has not logged into Claude Code yet. */
  readonly notLoggedIn: boolean;

  constructor(message: string, notLoggedIn = false) {
    super(message);
    this.name = "CredentialsError";
    this.notLoggedIn = notLoggedIn;
  }
}

/**
 * Read the OAuth credentials Claude Code has already stored on this machine.
 *
 * This plugin is strictly a reader: it never writes to the keychain or the
 * credentials file. Writing would mean racing the Claude Code CLI for
 * ownership of the same record, and a lost race there logs you out of Claude
 * Code itself — a far worse failure than this key showing a stale number.
 * The cost of that choice is documented on `refreshAccessToken`.
 */
export function readCredentials(): Credentials {
  const errors: string[] = [];

  // On macOS the keychain is authoritative; elsewhere it does not exist.
  if (platform() === "darwin") {
    try {
      return parse(readFromKeychain(), "keychain");
    } catch (e) {
      errors.push(`keychain: ${(e as Error).message}`);
    }
  }

  try {
    return parse(readFileSync(CREDENTIALS_FILE, "utf-8"), "file");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    errors.push(`file: ${err.code === "ENOENT" ? "not found" : err.message}`);
  }

  // Every backing store came up empty. The overwhelmingly likely cause is
  // that Claude Code has never been logged into on this machine, so we flag
  // it as such and let the renderer show a "sign in" key rather than a scary
  // error state.
  throw new CredentialsError(
    `no Claude Code credentials found (${errors.join("; ")})`,
    true,
  );
}

/**
 * Pull the credentials blob out of the macOS keychain via `/usr/bin/security`.
 *
 * The lookup is pinned to (service, current user) so a stray duplicate entry
 * — an iCloud keychain leftover, say — cannot be silently preferred.
 *
 * Note on prompts: the first read shows a keychain authorisation dialog.
 * Choosing "Always Allow" adds `/usr/bin/security` to the item's ACL. Because
 * Claude Code rewrites the item when it rotates tokens, that grant can be
 * reset and you may be asked again occasionally. `usage.ts` caches the token
 * in memory for its full lifetime specifically to keep that rare.
 */
function readFromKeychain(): string {
  const result = spawnSync(
    "/usr/bin/security",
    ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", userInfo().username, "-w"],
    { encoding: "utf-8", timeout: 15_000 },
  );

  if (result.error) throw new Error(result.error.message);
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").toString().trim();
    throw new Error(stderr || `security exited ${result.status}`);
  }

  const raw = result.stdout.trim();
  if (!raw) throw new Error("keychain entry is empty");
  return raw;
}

/**
 * Normalise the stored blob into our shape.
 *
 * Two formats are in the wild: a JSON object (current Claude Code, with the
 * interesting fields nested under `claudeAiOauth`) and a bare token string
 * from much older builds. Field names have also appeared in both camelCase
 * and snake_case, so we accept either.
 */
function parse(raw: string, source: Credentials["source"]): Credentials {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) {
    if (!trimmed) throw new Error("empty credentials blob");
    return { accessToken: trimmed, source };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`credentials blob is not valid JSON: ${(e as Error).message}`);
  }

  const oauth = (parsed.claudeAiOauth ?? parsed) as Record<string, unknown>;
  const accessToken = str(oauth.accessToken) ?? str(oauth.access_token);
  if (!accessToken) throw new Error("credentials blob has no accessToken");

  return {
    accessToken,
    refreshToken: str(oauth.refreshToken) ?? str(oauth.refresh_token),
    expiresAt: num(oauth.expiresAt) ?? num(oauth.expires_at),
    source,
  };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
