/**
 * Running-sessions data source, for the key that reports what your other
 * Claude Code sessions are doing right now.
 *
 * Split the way codex.ts is split: parsing, classification, corroboration,
 * and ranking are pure functions taking file *text* / already-collected
 * facts (no fs, no child_process), so the interesting logic is
 * fixture-testable; a thin `readSessions` below does the actual directory
 * listing, file reads, and `ps` call.
 *
 * This module only ever reads ~/.claude/sessions/*.json. It never writes,
 * renames, or deletes anything there — the live `claude` CLI owns that
 * directory and rewrites each file on every status transition, so losing a
 * write race against it would corrupt another session's own bookkeeping.
 * Same rule, same reason, as credentials.ts and codex.ts's auth files.
 */
import { execFile } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export type SessionBucket = "waiting" | "processing" | "idle" | "unknown";

export type SessionRecord = {
  pid: number;
  sessionId?: string;
  name?: string;
  cwd?: string;
  kind?: string;
  /** Raw, unnormalised — whatever the file said. Classify with bucketFromStatus. */
  status?: string;
  waitingFor?: string;
  version?: string;
  statusUpdatedAt?: number;
};

export type RankedSession = {
  /** name → basename(cwd) → `pid ${n}`, in that order — see labelFor. */
  label: string;
  bucket: SessionBucket;
  /** waitingFor for a waiting session; the raw status string for an unknown one. */
  detail?: string;
  /**
   * The live process id, carried so a caller can act on the session rather
   * than only describe it — focusing its terminal window, say. Kept here
   * because the ranking is the only place that knows which session is
   * *first*, and re-deriving that order at the call site would be a second
   * copy of a rule that must not drift from the one the peek face shows.
   *
   * A pid is meaningless once the process exits, so treat it as valid only
   * for the snapshot it arrived in — every entry here was confirmed live by
   * the same read that produced it.
   */
  pid: number;
};

export type SessionsSnapshot = {
  waiting: number;
  processing: number;
  idle: number;
  unknown: number;
  liveTotal: number;
  /** Registry files whose pid is not a live `claude` process — normal, not an error (see readOneFile). */
  staleFiles: number;
  /** waiting → processing → unknown → idle; within a bucket, statusUpdatedAt ascending. */
  ranked: RankedSession[];
  /** Distinct raw status strings that landed in the unknown bucket, for the log and the peek. */
  unknownStatuses: string[];
  /** A version seen among unknown-status records, for the log. */
  version?: string;
};

export type SessionsProblem =
  /** Corroborated: live `claude` processes exist but no usable registry entry matches any of them. */
  | { kind: "no-registry"; message: string }
  /** Parse/permission failure that survived the torn-read hysteresis below. */
  | { kind: "unreadable"; message: string };

export type SessionsState =
  | { status: "loading" }
  | { status: "ok"; snapshot: SessionsSnapshot }
  | { status: "fail"; problem: SessionsProblem };

const SESSIONS_DIR = join(homedir(), ".claude", "sessions");

/** Cap on the `ps` call, so one wedged subprocess cannot stall every later poll behind it. */
const PS_TIMEOUT_MS = 5_000;

/** Measured 24ms over 665 processes — cheap, but no reason to pay it on every 3s poll tick. */
const PS_CACHE_MS = 10_000;

/**
 * `busy`/`shell` → processing, `waiting` → waiting, `idle` → idle, after
 * `trim().toLowerCase()` — mirrors severityFromStatus in format.ts.
 *
 * Everything else — missing, empty, non-string, or a status we've simply
 * never seen (e.g. a future "compacting") — returns "unknown". There is
 * deliberately no `else` branch that lands in a real bucket: an
 * unrecognised future status silently counted as idle would make this key
 * report "nobody is blocked" while a session actually sits on a permission
 * prompt, which is the one thing this feature exists to surface.
 */
export function bucketFromStatus(raw: unknown): SessionBucket {
  if (typeof raw !== "string") return "unknown";
  const s = raw.trim().toLowerCase();
  if (s === "busy" || s === "shell") return "processing";
  if (s === "waiting") return "waiting";
  if (s === "idle") return "idle";
  return "unknown";
}

/**
 * Deliberately asymmetric. `kind` is missing entirely on session files
 * written by a CLI build that predates the field, so "we don't know" is
 * treated as interactive rather than excluded — silently dropping a real
 * conversation from the count is this key's worst sin. Any other value,
 * including one we've never seen before, is excluded: every non-interactive
 * `kind` observed so far ("bg", "daemon", "daemon-worker") is a worker, not
 * a conversation, and a future worker kind is far likelier than a new
 * flavour of interactive session.
 */
export function isInteractiveKind(kind: string | undefined): boolean {
  return kind === undefined || kind === "interactive";
}

/** `<pid>.json`, and specifically not `<pid>.<sha>.key` — those are a different kind of file in the same directory. */
export function isRegistryFileName(name: string): boolean {
  return /^\d+\.json$/.test(name);
}

function registryPidFromFileName(name: string): number {
  return Number(name.slice(0, -".json".length));
}

/**
 * Parse one session file's text into a record. Pure: fixture-testable
 * without touching disk.
 *
 * Only `pid` is required — it's the sole field this whole feature keys
 * liveness off of. Field sets already differ across co-resident Claude Code
 * versions (`nameSince` absent pre-2.1.230, `nameSource` only from 2.1.233,
 * `waitingFor` absent — not null — until a session first enters `waiting`),
 * so a strict schema here would already reject real files today. Unknown
 * extra keys are simply not read.
 */
export function parseSessionRecord(text: string): SessionRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;

  const pid = num(obj.pid);
  if (pid === undefined) return null;

  return {
    pid,
    sessionId: str(obj.sessionId),
    name: str(obj.name),
    cwd: str(obj.cwd),
    kind: str(obj.kind),
    status: str(obj.status),
    waitingFor: str(obj.waitingFor),
    version: str(obj.version),
    statusUpdatedAt: num(obj.statusUpdatedAt),
  };
}

/** name → basename(cwd) → `pid ${n}`. */
export function labelFor(record: SessionRecord): string {
  if (record.name) return record.name;
  if (record.cwd) return basename(record.cwd);
  return `pid ${record.pid}`;
}

/**
 * Parse `ps -axo pid=,lstart=,comm=` output into pid → comm.
 *
 * `lstart` is always exactly 5 whitespace-separated tokens (e.g. "Sat Aug
 * 15 03:50:09 2026"). `comm` is everything after that and may itself
 * contain spaces ("Claude Helper (Renderer)"), so it has to be re-joined
 * from the remaining tokens rather than picked out by a fixed split index.
 */
export function parsePsTable(output: string): Map<number, string> {
  const table = new Map<number, string>();
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const tokens = trimmed.split(/\s+/);
    // pid (1) + lstart (5) + at least one comm token (1) = 7.
    if (tokens.length < 7) continue;
    const pid = Number(tokens[0]);
    if (!Number.isInteger(pid)) continue;
    table.set(pid, tokens.slice(6).join(" "));
  }
  return table;
}

/**
 * Which pids from a `ps` table are a live Claude Code CLI session.
 *
 * Exact, case-sensitive equality against "claude" only. Verified: all live
 * CLI sessions report `comm=claude` exactly, while the desktop app reports
 * full paths ("/Applications/Claude.app/Contents/MacOS/Claude") and helper
 * process names ("Claude Helper (Renderer)") — a case-insensitive or
 * substring match would wrongly pull those in.
 *
 * Deliberately NOT `procStart`. `procStart` in the registry file is
 * UTC-rendered while `ps -o lstart=` prints local time — measured on this
 * machine: `procStart: "Wed Aug 12 23:08:23 2026"` (UTC) against the same
 * process's `ps` line rendering `Sat Aug 15 03:50:09 2026` (local), one
 * calendar day apart. A string compare of the two yields zero live sessions
 * permanently and silently on any machine not set to UTC — the worst
 * failure mode this feature has — which is why liveness is decided purely
 * from `ps`'s own pid/comm columns and `procStart` is never read for this.
 */
export function claudePidsFromTable(table: Map<number, string>): Set<number> {
  const pids = new Set<number>();
  for (const [pid, comm] of table) {
    if (comm === "claude") pids.add(pid);
  }
  return pids;
}

/**
 * How to read a `process.kill(pid, 0)` errno when `ps` itself is
 * unavailable (see readSessions). Pure so it's testable without a real
 * syscall or a real dead pid.
 *
 * EPERM means the process exists but signalling it isn't permitted (e.g.
 * it's owned by another user) — still alive. ESRCH means no such process.
 * Anything else hasn't been observed in practice; treated as "alive" so an
 * unfamiliar errno can never make a live session vanish from the count.
 */
export function isAliveErrorCode(code: string | undefined): boolean {
  return code !== "ESRCH";
}

export type CorroborationVerdict = "ok" | "no-registry";

/**
 * The registry could vanish or be reshaped by a future Claude Code version
 * (e.g. renamed to `<pid>.session.json`), leaving a permanent, silent "0
 * sessions" that's indistinguishable from "nothing is actually running".
 * `ps` is used as an independent witness to catch that.
 *
 * Requires *zero* overlap between registry pids and live `claude` pids, not
 * merely "some registry pid is missing" — a session that started 200ms ago
 * and hasn't written its file yet must not flip this to no-registry.
 */
export function corroborationVerdict(
  registryPids: number[],
  liveClaudePids: Set<number>,
  psAvailable: boolean,
): CorroborationVerdict {
  if (!psAvailable) return "ok"; // no independent witness this read — nothing to corroborate against
  if (liveClaudePids.size === 0) return "ok"; // no live claude processes at all: an honest zero, not a missing registry
  const overlap = registryPids.some((pid) => liveClaudePids.has(pid));
  return overlap ? "ok" : "no-registry";
}

const bucketOrder: Record<SessionBucket, number> = { waiting: 0, processing: 1, unknown: 2, idle: 3 };

/**
 * Assemble the snapshot from already-parsed records and an already-decided
 * live-pid set. Pure: no fs, no child_process, no Date.now().
 */
export function buildSnapshot(
  records: SessionRecord[],
  liveClaudePids: Set<number>,
  staleFiles: number,
): SessionsSnapshot {
  let waiting = 0;
  let processing = 0;
  let idle = 0;
  let unknown = 0;
  const unknownStatuses: string[] = [];
  let version: string | undefined;

  const entries: Array<{ record: SessionRecord; bucket: SessionBucket }> = [];

  for (const record of records) {
    // A registry file lingers after its process exits until the CLI next
    // cleans it up; without this check every past session would count as
    // "idle" forever.
    if (!liveClaudePids.has(record.pid)) continue;
    if (!isInteractiveKind(record.kind)) continue;

    const bucket = bucketFromStatus(record.status);
    if (bucket === "waiting") waiting++;
    else if (bucket === "processing") processing++;
    else if (bucket === "idle") idle++;
    else {
      unknown++;
      if (record.status && !unknownStatuses.includes(record.status)) {
        unknownStatuses.push(record.status);
      }
      if (version === undefined && record.version) version = record.version;
    }

    entries.push({ record, bucket });
  }

  entries.sort((a, b) => {
    const byBucket = bucketOrder[a.bucket] - bucketOrder[b.bucket];
    if (byBucket !== 0) return byBucket;
    // Ascending: the longest-waiting/oldest-updated session in a bucket
    // surfaces first, which is the one most worth noticing. A record with
    // no timestamp at all is the least actionable data point we have about
    // it, so it sorts last rather than jumping the queue.
    const at = a.record.statusUpdatedAt ?? Number.POSITIVE_INFINITY;
    const bt = b.record.statusUpdatedAt ?? Number.POSITIVE_INFINITY;
    return at - bt;
  });

  const ranked: RankedSession[] = entries.map(({ record, bucket }) => ({
    label: labelFor(record),
    bucket,
    detail: bucket === "waiting" ? record.waitingFor : bucket === "unknown" ? record.status : undefined,
    pid: record.pid,
  }));

  return {
    waiting,
    processing,
    idle,
    unknown,
    liveTotal: waiting + processing + idle + unknown,
    staleFiles,
    ranked,
    unknownStatuses,
    version,
  };
}

type TornEntry = { mtimeMs: number; size: number };

/**
 * Which (fileName → last-seen mtime/size) is currently mid-hysteresis.
 * Module-level and persisted across calls to readSessions on purpose: the
 * escalation this drives ("same file, same mtime/size, still unreadable")
 * only means anything if it survives to the *next* poll, a few seconds
 * later, not just a single read.
 */
const tornFiles = new Map<string, TornEntry>();

type FileReadResult =
  | { kind: "ok"; record: SessionRecord }
  | { kind: "skip" }
  | { kind: "escalate" };

/**
 * Read and parse one registry file, with the torn-read hysteresis described
 * on readSessions. Not pure — real fs calls — which is why the parsing
 * itself is factored out into parseSessionRecord above for fixture testing.
 */
function readOneFile(dir: string, name: string): FileReadResult {
  const path = join(dir, name);
  let stat: TornEntry;
  try {
    const s = statSync(path);
    stat = { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    // Gone before we could even stat it — a session exiting mid-poll. Normal.
    return { kind: "skip" };
  }

  const readAndParse = (): SessionRecord | null | "eacces" | "enoent" => {
    let text: string;
    try {
      text = readFileSync(path, "utf-8");
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EACCES") return "eacces";
      if (code === "ENOENT") return "enoent";
      return null; // an unfamiliar error kind: fold it into the same "still failing" path below
    }
    return parseSessionRecord(text);
  };

  let outcome = readAndParse();
  // A torn write (mid-rewrite on a status transition) is expected and gets
  // one immediate retry. EACCES never will resolve in the next few
  // milliseconds, so retrying it is pointless — it skips straight to the
  // "still failing" bookkeeping below.
  if (outcome === null) outcome = readAndParse();

  if (outcome === "enoent") {
    tornFiles.delete(name); // exited cleanly; don't let a stale entry confuse a future pid reusing this filename
    return { kind: "skip" };
  }
  if (outcome !== null && outcome !== "eacces") {
    tornFiles.delete(name); // recovered — a later fresh failure should get a fresh two-strike count
    return { kind: "ok", record: outcome };
  }

  // Still failing after the retry above (or an EACCES that skipped it).
  // Escalate only if this is the exact same file we already flagged on a
  // previous poll — a changed mtime/size means something legitimately
  // rewrote it since, which resets the count rather than compounding it.
  const prev = tornFiles.get(name);
  const matches = prev !== undefined && prev.mtimeMs === stat.mtimeMs && prev.size === stat.size;
  tornFiles.set(name, stat);
  return matches ? { kind: "escalate" } : { kind: "skip" };
}

/**
 * `pid=,lstart=,comm=` with no headers — the format parsePsTable expects.
 * Deliberately `child_process.execFile`, not `exec`: no shell, no quoting
 * to get wrong.
 */
function runPsRaw(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "/bin/ps",
      ["-axo", "pid=,lstart=,comm="],
      { timeout: PS_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

/**
 * Cache keyed on the runPs function's own identity rather than a global
 * flag: production always passes the same `runPsRaw` reference so this
 * behaves as a plain ~10s cache, while tests injecting a fresh function per
 * case never see another test's cached table.
 */
let psCache: { at: number; table: Map<number, string>; runPsRef: () => Promise<string> } | undefined;

async function getPsTable(runPs: () => Promise<string>): Promise<Map<number, string> | null> {
  const now = Date.now();
  if (psCache && psCache.runPsRef === runPs && now - psCache.at < PS_CACHE_MS) {
    return psCache.table;
  }
  try {
    const output = await runPs();
    const table = parsePsTable(output);
    psCache = { at: now, table, runPsRef: runPs };
    return table;
  } catch {
    psCache = undefined;
    return null;
  }
}

export type SessionsReaderOptions = {
  /** Defaults to ~/.claude/sessions; overridable so tests never touch the real directory. */
  sessionsDir?: string;
  /** Defaults to the real `ps` call; overridable so tests control what liveness sees. */
  runPs?: () => Promise<string>;
};

/**
 * Read the whole registry and produce one SessionsState. The thin-IO
 * counterpart to the pure functions above: directory listing, per-file
 * reads with torn-read hysteresis, the `ps` corroboration witness, and
 * process.kill liveness fallback all live here.
 */
export async function readSessions(opts: SessionsReaderOptions = {}): Promise<SessionsState> {
  const dir = opts.sessionsDir ?? SESSIONS_DIR;
  const runPs = opts.runPs ?? runPsRaw;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      // No ~/.claude/sessions directory at all — a completely normal state
      // on a machine that has never run Claude Code, or before the first
      // session ever writes one. corroborationVerdict below still catches
      // the case where this is actually wrong (live claude processes exist
      // despite no directory).
      entries = [];
    } else {
      return {
        status: "fail",
        problem: { kind: "unreadable", message: `reading ${dir}: ${err.message}` },
      };
    }
  }

  const registryNames = entries.filter(isRegistryFileName);
  const registryPids = registryNames.map(registryPidFromFileName);

  const records: SessionRecord[] = [];
  let escalated = false;
  for (const name of registryNames) {
    const result = readOneFile(dir, name);
    if (result.kind === "ok") records.push(result.record);
    else if (result.kind === "escalate") escalated = true;
  }

  if (escalated) {
    return {
      status: "fail",
      problem: {
        kind: "unreadable",
        message: "a session registry file failed to parse across two consecutive polls",
      },
    };
  }

  const psTable = await getPsTable(runPs);
  let live: Set<number>;
  let psAvailable: boolean;
  if (psTable !== null) {
    live = claudePidsFromTable(psTable);
    psAvailable = true;
  } else {
    psAvailable = false;
    live = new Set<number>();
    // No full process listing is available without `ps`, so the fallback
    // can only answer "is this specific pid we already know about alive" —
    // it probes exactly the registry's own pids, nothing more.
    for (const pid of registryPids) {
      if (isProcessAliveByKill(pid)) live.add(pid);
    }
  }

  if (corroborationVerdict(registryPids, live, psAvailable) === "no-registry") {
    return {
      status: "fail",
      problem: {
        kind: "no-registry",
        message:
          "claude sessions are running but none match the session registry — it may have moved or changed shape",
      },
    };
  }

  const staleFiles = registryPids.filter((pid) => !live.has(pid)).length;
  return { status: "ok", snapshot: buildSnapshot(records, live, staleFiles) };
}

function isProcessAliveByKill(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return isAliveErrorCode((e as NodeJS.ErrnoException).code);
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
