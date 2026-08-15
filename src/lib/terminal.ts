/**
 * Pure logic for the "type into the frontmost terminal" action: no
 * child_process, no Stream Deck imports. Kept free of both so it can be
 * unit-tested directly, exactly like view.ts — the part of this feature most
 * worth testing in isolation is the escaping and the app classification, not
 * the osascript plumbing around them.
 */

/** Bundle id -> how we can safely deliver text to that app, if at all. */
export type TerminalKind = "terminal-app" | "iterm" | "keystroke" | "editor" | "unsupported";

/**
 * The command a fresh key ships with: a Claude Code session with permission
 * checks disabled. Verified against the installed binary — the flag is
 * hyphenated (`--dangerously-skip-permissions`), not
 * `--allow-dangerously-skip-permissions`, which is a different flag that only
 * enables the bypass rather than turning it on.
 */
export const DEFAULT_COMMAND = "claude --dangerously-skip-permissions";

/**
 * The command a fresh Codex launch key ships with: plain `codex`, no flags.
 *
 * Codex's permission-bypass flag is now verified — `--dangerously-bypass-
 * approvals-and-sandbox` ("Skip all confirmation prompts and execute
 * commands without sandboxing. EXTREMELY DANGEROUS."), read from `--help` on
 * the Codex CLI bundled inside ChatGPT.app (`codex-cli 0.147.0-alpha.6.5`;
 * see `ui/codex-launch.html` for where to find that binary). There is no
 * `--yolo` alias in this build — checked, not assumed. The standalone
 * `@openai/codex` npm install remains broken on this machine for unrelated
 * reasons (see DEVELOPMENT.md), which is why that binary, not this one, was
 * used to check the flag.
 *
 * The default here stays the bare command regardless: shipping a
 * permission-bypass flag as a *default* risks silently disabling sandboxing
 * for every user who never opens the property inspector, verified flag name
 * or not. Users who want it can add it themselves in settings.
 */
export const CODEX_DEFAULT_COMMAND = "codex";

/**
 * Escape a string for use inside an AppleScript double-quoted string
 * literal. Order matters: escape backslashes first, then double quotes.
 * Escaping quotes first would turn a literal backslash that precedes a quote
 * into `\\"` after the quote pass, and then the backslash pass would double
 * that backslash again, leaving the quote unescaped in the resulting script.
 * Backslash-first avoids ever re-touching a slash the quote pass introduced.
 */
export function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Map a frontmost app's bundle identifier to how (or whether) we can type
 * into it. Comparison is case-insensitive and tolerant of surrounding
 * whitespace, since both come free from how the id is read off the wire.
 */
export function classifyApp(bundleId: string | null): TerminalKind {
  if (!bundleId) return "unsupported";
  const id = bundleId.trim().toLowerCase();

  switch (id) {
    case "com.apple.terminal":
      return "terminal-app";
    case "com.googlecode.iterm2":
      return "iterm";
    case "com.mitchellh.ghostty":
    case "com.github.wez.wezterm":
    case "net.kovidgoyal.kitty":
    case "io.alacritty":
    case "dev.warp.warp-stable":
      return "keystroke";
    case "com.microsoft.vscode":
    case "com.todesktop.230313mzl4w4u92": // Cursor
      return "editor";
    default:
      return "unsupported";
  }
}

/** AppleScript that prints the frontmost app's bundle identifier. */
export function buildFrontmostScript(): string {
  return 'tell application "System Events" to get bundle identifier of first application process whose frontmost is true';
}

/**
 * Build the AppleScript that actually delivers `command` to the frontmost
 * app, given its classification.
 */
/**
 * Flatten a command to a single line.
 *
 * AppleScript permits a literal newline inside a string, and osascript
 * rejoins its `-e` fragments, so an embedded newline does not break the
 * script — it silently becomes a second command. That matters most for
 * `pressEnter: false`, where a newline in the text is typed as Return and
 * submits the line anyway, which is precisely what that setting promises not
 * to do. A command typed at a prompt is one line; collapse it and keep the
 * setting honest.
 */
function toSingleLine(command: string): string {
  return command.replace(/[\r\n]+/g, " ").trim();
}

export function buildDeliveryScript(kind: TerminalKind, command: string, pressEnter: boolean): string {
  const escaped = escapeAppleScript(toSingleLine(command));

  switch (kind) {
    case "terminal-app":
      // Terminal's own scripting API targets the focused window exactly and
      // needs only Automation permission, not Accessibility — prefer it over
      // synthetic keystrokes. But `do script` always runs the command it is
      // given, so it is the wrong tool when the user wants it merely typed
      // (pressEnter=false); fall back to the keystroke form in that case.
      if (!pressEnter) return buildDeliveryScript("keystroke", command, pressEnter);
      return `tell application "Terminal" to do script "${escaped}" in front window`;

    case "iterm":
      // Same caveat as Terminal's `do script`: `write text` always submits
      // the line, so a no-Enter request needs the keystroke form instead.
      if (!pressEnter) return buildDeliveryScript("keystroke", command, pressEnter);
      return `tell application "iTerm" to tell current session of current window to write text "${escaped}"`;

    case "keystroke":
    case "editor": {
      const type = `tell application "System Events" to keystroke "${escaped}"`;
      if (!pressEnter) return type;
      // key code 36 is Return. A second, separate `tell` block rather than a
      // compound statement, matched by the two "-e" arguments callers pass
      // to osascript.
      return `${type}\ntell application "System Events" to key code 36`;
    }

    case "unsupported":
      // Callers must classify and refuse before ever reaching here; this is
      // a guard against a future edit dropping that check, not a path any
      // caller is meant to hit.
      throw new Error("refusing to type into a non-terminal app");
  }
}
