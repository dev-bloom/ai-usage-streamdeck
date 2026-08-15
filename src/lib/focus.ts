/**
 * Bring a session's terminal window to the front, given the pid of the
 * `claude` process running in it.
 *
 * Split the way terminal.ts and codex.ts are split: the parsing and
 * matching logic below is pure (no child_process, no fs) so it is
 * unit-testable against fixture strings, and `focusSession` at the bottom is
 * the thin `osascript`/`ps` wrapper around it.
 *
 * This module only ever reads process info and activates/selects windows —
 * it must never write, kill, or signal anything.
 */
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

import { escapeAppleScript } from "./terminal.js";

const execFile = promisify(execFileCb);

// No windowId on "terminal-tab": buildFindAndFocusTabScript finds and
// selects the matching window entirely inside AppleScript now, so
// TypeScript never learns which window id it was — there is nothing left
// here that would use one.
export type FocusTarget =
  | { kind: "terminal-tab"; bundleId: string }
  | { kind: "app"; bundleId: string }
  | { kind: "unknown" };

export type FocusOutcome =
  | { ok: true; precision: "tab" | "app" }
  | { ok: false; reason: "no-tty" | "no-owner" | "no-match" | "failed" };

// Must stay in sync with the "com.apple.terminal" case in terminal.ts's
// classifyApp — this is the one owner that gets tab-level precision instead
// of a bare app activation.
const TERMINAL_BUNDLE_ID = "com.apple.Terminal";

/**
 * `ps -o comm=` value, reduced to its last path component (see `basename`)
 * -> bundle id, for the ancestor process that owns a terminal session.
 *
 * Deliberately `comm` + basename, not `ucomm`. Measured side by side on this
 * machine:
 *
 *   pid    comm=                                                   ucomm=
 *   4477   claude                                                  2.1.229
 *   63004  claude                                                  2.1.233
 *   1885   /Applications/Visual Studio Code.app/Contents/MacOS/Code Code
 *   82641  /System/Applications/Utilities/Terminal.app/.../Terminal Terminal
 *   2093   .../Code Helper.app/Contents/MacOS/Code Helper            Code Helper
 *
 * `comm` is argv[0]: bare for a CLI whose shim sets it (`claude`), a full
 * bundle-relative path for a GUI app. `ucomm` is the kernel's `p_comm`, the
 * executable's basename — which is why the CLI reports its *version*
 * instead of its name (the binary lives at
 * `~/.local/share/claude/versions/<version>`). Basenaming `comm` recovers
 * the same short form ucomm gives for GUI apps ("Code", "Terminal", "Code
 * Helper") without ucomm's hazard: `p_comm` is truncated to 16 characters —
 * measured, a real "Claude Helper (Renderer)" process reports ucomm exactly
 * `"Claude Helper (R"`, cut mid-word — so any owner whose basename reaches
 * 16 characters would never match via ucomm and would fail as "no-owner",
 * indistinguishable from "this isn't a terminal I know". basename(comm) has
 * no such limit.
 *
 * Only "Terminal" and "Code" are measured on this machine — see the three
 * ancestry chains in this repo's task brief:
 *
 *   pid 32893  zsh <- Code Helper <- Code     (VS Code integrated terminal)
 *   pid 4477   zsh <- Code Helper <- Code     (VS Code integrated terminal)
 *   pid 63004  -zsh <- login <- Terminal      (Terminal.app)
 *
 * Every other entry below is an UNVERIFIED GUESS at what that app's
 * executable basename is — iTerm2 is not installed on this machine, so
 * there was nothing to measure it against, and none of the other terminals
 * were checked either. A wrong guess here fails safe: the ancestry walk
 * simply never matches that entry, `parseAncestry` returns null, and
 * `focusSession` reports "no-owner" instead of activating the wrong app —
 * it never activates on a guess it can't back up.
 */
const OWNER_APP_NAMES: Record<string, string> = {
  // --- verified on this machine ---
  Terminal: "com.apple.Terminal",
  Code: "com.microsoft.VSCode",

  // --- unverified guesses at the executable basename; bundle ids either
  // reused from terminal.ts's classifyApp bundle-id switch (Cursor's id is
  // copied verbatim from its "com.todesktop.230313mzl4w4u92" case there,
  // not retyped, so there is exactly one spelling of that fact in this
  // repo) or the same terminal-app bundle ids classifyApp already knows ---
  iTerm2: "com.googlecode.iterm2",
  ghostty: "com.mitchellh.ghostty",
  "wezterm-gui": "com.github.wez.wezterm",
  kitty: "net.kovidgoyal.kitty",
  alacritty: "io.alacritty",
  Warp: "dev.warp.warp-stable",
  Cursor: "com.todesktop.230313mzl4w4u92", // bundle id verified via terminal.ts; only this basename guess is not
};

/**
 * `ttys000`, `/dev/ttys000`, and either with trailing whitespace all
 * collapse to one canonical form. This is the fix for the mismatch measured
 * on this machine: `ps -o tty=` returns `ttys000` while Terminal.app's own
 * AppleScript `tty of t` returns `/dev/ttys000` — comparing those two
 * strings directly would never match, silently.
 */
export function normaliseTty(raw: string): string {
  return raw.trim().replace(/^\/dev\//, "");
}

/**
 * The inverse of normaliseTty: turn a canonical tty (`ttys000`) into the
 * `/dev/`-prefixed form Terminal.app's own `tty of t` property speaks. `ps`
 * and Terminal speak two different spellings of the same tty: normaliseTty
 * canonicalises values coming in from either side so they can be compared;
 * a value crossing back out into an AppleScript `whose tty is ...` clause
 * must be re-expressed in Terminal's own form, or the clause silently
 * matches zero tabs — "no such tab", not an error — instead of failing
 * loudly. Measured against the real app: `whose tty is "ttys000"` matches
 * nothing; `whose tty is "/dev/ttys000"` matches the window.
 */
export function toDeviceTty(raw: string): string {
  return `/dev/${normaliseTty(raw)}`;
}

/**
 * Last path component of a `ps -o comm=` value. `comm` is argv[0]: bare
 * (e.g. "claude", "zsh") for a CLI shim or shell, a full bundle-relative
 * executable path (e.g.
 * "/Applications/Visual Studio Code.app/Contents/MacOS/Code") for a GUI
 * app. Slicing to the final segment turns both into the same short form
 * with no length limit — see the block comment on OWNER_APP_NAMES for why
 * that matters (ucomm's 16-character truncation is the hazard this avoids).
 * A value with no "/" (already bare) is returned unchanged.
 */
function basename(comm: string): string {
  const idx = comm.lastIndexOf("/");
  return idx === -1 ? comm : comm.slice(idx + 1);
}

type PsRow = { pid: number; ppid: number; comm: string };

/** `pid=,ppid=,comm=` has no headers and comm can contain spaces and slashes, so only the first two fields are fixed-width. */
function parsePsRows(psOutput: string): Map<number, PsRow> {
  const rows = new Map<number, PsRow>();
  for (const line of psOutput.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue; // blank or malformed line: skip rather than throw
    const [, pidStr, ppidStr, comm] = match;
    const pid = Number(pidStr);
    const ppid = Number(ppidStr);
    rows.set(pid, { pid, ppid, comm: comm ?? "" });
  }
  return rows;
}

/**
 * Walk from `startPid` up the ppid chain, stopping at the first ancestor
 * whose `comm` — reduced to its last path component, see `basename` —
 * names a known owning GUI app (`ownerNames`, defaulting to the real
 * OWNER_APP_NAMES table). This is why "Code Helper" — the electron helper
 * process that actually parents the shell — is not itself a match: it
 * isn't in the table, so the walk keeps climbing past it to "Code", the
 * real app to activate.
 *
 * `ownerNames` is overridable only so tests can prove properties of the
 * matching algorithm (e.g. no length limit on the matched name) against a
 * fixture table, without depending on what's actually shipped in
 * OWNER_APP_NAMES.
 *
 * Returns null when `startPid` isn't in the table, no ancestor matches
 * before the chain runs out (reaches launchd or a missing ppid), or a ppid
 * cycle is detected — never throws.
 */
export function parseAncestry(
  psOutput: string,
  startPid: number,
  ownerNames: Record<string, string> = OWNER_APP_NAMES,
): { pid: number; comm: string; bundleId: string } | null {
  const rows = parsePsRows(psOutput);
  const visited = new Set<number>();

  let pid = startPid;
  while (!visited.has(pid)) {
    visited.add(pid);
    const row = rows.get(pid);
    if (!row) return null;

    const bundleId = ownerNames[basename(row.comm)];
    if (bundleId) return { pid: row.pid, comm: row.comm, bundleId };

    if (row.ppid === pid) return null; // pid 1 (launchd) is its own edge case guard
    pid = row.ppid;
  }
  return null; // cycle in the ppid chain — malformed input, not a real process tree
}

/**
 * AppleScript that finds the Terminal.app tab whose tty is `tty`, selects
 * it, brings its window forward, and activates Terminal — all in one
 * `osascript` invocation. This replaces the former two-script flow (list
 * every tab's tty via a first `osascript` call, match in TypeScript, select
 * via a second `osascript` call): each `osascript` spawn measured ~80-90 ms
 * on this machine while the AppleScript work itself was negligible, so the
 * two-call version cost ~100 ms more than doing the match inside the script
 * and paying the spawn cost once. Measured at 91 ms end to end, verified
 * live returning "ok".
 *
 * `parseTerminalTabs` and `matchWindow` — the TypeScript-side list/match
 * pair the old flow used — are gone along with the script that fed them
 * (`buildTerminalTabsScript`): nothing outside this file imported them, and
 * once the match moves into AppleScript they have no caller left in this
 * file either. Keeping them would mean exported, untested-by-use code with
 * no consumer — worse than deleting them, so they're deleted along with
 * their tests rather than kept "for diagnostics" with no diagnostic that
 * actually calls them.
 *
 * The `try` around the `first tab ... whose tty is ...` lookup is
 * load-bearing, not defensive dressing: that expression raises when a
 * window has no matching tab, so without the `try`, the first window that
 * doesn't own the session would abort the whole `repeat` before later
 * windows are checked. Returning the sentinel strings "ok"/"nomatch" rather
 * than relying on an exit code is what lets a genuine "no such tty" be told
 * apart from a script/runtime error — the caller in `focusSession` maps
 * "ok" and anything else (including a thrown/timed-out `osascript` call)
 * differently.
 */
export function buildFindAndFocusTabScript(tty: string): string {
  // `tty` arrives in canonical form (every caller in this file passes the
  // same canonical string it used elsewhere) — convert to Terminal's own
  // /dev/-prefixed spelling here, at the one point it crosses into
  // AppleScript, so this is the only place that asymmetry has to be
  // remembered. Interpolating the canonical form instead matched zero tabs
  // on this machine — silent no-match, not an error — see toDeviceTty's doc
  // comment.
  const escapedTty = escapeAppleScript(toDeviceTty(tty));
  return [
    'tell application "Terminal"',
    "  repeat with w in windows",
    "    try",
    `      set t to (first tab of w whose tty is "${escapedTty}")`,
    "      set selected of t to true",
    "      set index of w to 1",
    "      activate",
    '      return "ok"',
    "    end try",
    "  end repeat",
    '  return "nomatch"',
    "end tell",
  ].join("\n");
}

/**
 * AppleScript that activates the app with the given bundle id. This is the
 * ceiling for anything other than Terminal.app: macOS exposes no way to
 * select a specific pane within another app's window — the same limitation
 * terminal.ts already documents for typing into VS Code's integrated
 * terminal (see classifyApp's "editor" case) applies equally here, so app
 * activation is genuinely the best this module can do for VS Code, Cursor,
 * Ghostty, WezTerm, kitty, Alacritty, Warp, or anything else that isn't
 * Terminal.app.
 */
export function buildActivateScript(bundleId: string): string {
  const escaped = escapeAppleScript(bundleId);
  return `tell application id "${escaped}" to activate`;
}

const PS = "/bin/ps";
const OSASCRIPT = "/usr/bin/osascript";
// Both ps and osascript can hang — ps on a wedged process table, osascript
// waiting on an unanswered Automation permission dialog exactly as launch.ts
// documents for its own osascript calls — and a stuck focus press must not
// wedge the key that triggered it.
const PS_TIMEOUT_MS = 5_000;
const OSASCRIPT_TIMEOUT_MS = 8_000;

/**
 * Focus the terminal window running the `claude` process at `pid`.
 *
 * 1. Read the session's tty and walk its ancestry to the owning app.
 * 2. Terminal.app: match a live tab by tty, select it, bring its window
 *    forward, activate. Precision "tab".
 * 3. Anything else (VS Code, Cursor, Ghostty, WezTerm, kitty, Alacritty,
 *    Warp, ...): activate the app by bundle id. Precision "app" — see
 *    buildActivateScript's doc comment for why that's the ceiling.
 * 4. No owner or no tty: the matching `ok: false` reason, never a throw.
 */
export async function focusSession(pid: number): Promise<FocusOutcome> {
  let ttyRaw: string;
  try {
    const { stdout } = await execFile(PS, ["-o", "tty=", "-p", String(pid)], {
      timeout: PS_TIMEOUT_MS,
    });
    ttyRaw = stdout.trim();
  } catch {
    return { ok: false, reason: "failed" };
  }
  // "??" is ps's own spelling for "no controlling terminal" — a real value,
  // not a parse failure, so it gets its own reason rather than "failed".
  if (!ttyRaw || ttyRaw === "??") return { ok: false, reason: "no-tty" };
  const tty = normaliseTty(ttyRaw);

  let psTable: string;
  try {
    const { stdout } = await execFile(PS, ["-axo", "pid=,ppid=,comm="], {
      timeout: PS_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    psTable = stdout;
  } catch {
    return { ok: false, reason: "failed" };
  }

  const owner = parseAncestry(psTable, pid);
  if (!owner) return { ok: false, reason: "no-owner" };

  if (owner.bundleId === TERMINAL_BUNDLE_ID) {
    let result: string;
    try {
      const { stdout } = await execFile(OSASCRIPT, ["-e", buildFindAndFocusTabScript(tty)], {
        timeout: OSASCRIPT_TIMEOUT_MS,
      });
      result = stdout.trim();
    } catch {
      return { ok: false, reason: "failed" };
    }
    // "nomatch" is the script's own sentinel for "ran fine, no tab has this
    // tty" — the same outcome the old two-osascript-call flow reported when
    // matchWindow found nothing. A thrown/timed-out osascript call is
    // caught above and mapped to "failed" instead, never reaching here.
    if (result !== "ok") return { ok: false, reason: "no-match" };
    return { ok: true, precision: "tab" };
  }

  const target: FocusTarget = { kind: "app", bundleId: owner.bundleId };
  try {
    await execFile(OSASCRIPT, ["-e", buildActivateScript(target.bundleId)], {
      timeout: OSASCRIPT_TIMEOUT_MS,
    });
  } catch {
    return { ok: false, reason: "failed" };
  }
  return { ok: true, precision: "app" };
}
