import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildDeliveryScript,
  buildFrontmostScript,
  classifyApp,
  escapeAppleScript,
} from "../.build/lib/terminal.js";

describe("escapeAppleScript", () => {
  it("escapes backslashes", () => {
    assert.equal(escapeAppleScript("a\\b"), "a\\\\b");
  });

  it("escapes double quotes", () => {
    assert.equal(escapeAppleScript('a"b'), 'a\\"b');
  });

  it("handles a string with both, in the order that does not double-escape", () => {
    // Naive "quotes first" ordering turns `a\"b` into `a\\"b` on the quote
    // pass, then the backslash pass doubles that backslash again, leaving
    // the quote itself unescaped. Backslash-first avoids that.
    assert.equal(escapeAppleScript('a\\"b'), 'a\\\\\\"b');
  });
});

describe("classifyApp", () => {
  it("maps each known terminal bundle id", () => {
    assert.equal(classifyApp("com.apple.Terminal"), "terminal-app");
    assert.equal(classifyApp("com.googlecode.iterm2"), "iterm");
    assert.equal(classifyApp("com.mitchellh.ghostty"), "keystroke");
    assert.equal(classifyApp("com.github.wez.wezterm"), "keystroke");
    assert.equal(classifyApp("net.kovidgoyal.kitty"), "keystroke");
    assert.equal(classifyApp("io.alacritty"), "keystroke");
    assert.equal(classifyApp("dev.warp.Warp-Stable"), "keystroke");
  });

  it("maps editors, opt-in only", () => {
    assert.equal(classifyApp("com.microsoft.VSCode"), "editor");
    assert.equal(classifyApp("com.todesktop.230313mzl4w4u92"), "editor"); // Cursor
  });

  it("treats unknown, empty, and null ids as unsupported", () => {
    assert.equal(classifyApp("com.apple.Safari"), "unsupported");
    assert.equal(classifyApp(""), "unsupported");
    assert.equal(classifyApp(null), "unsupported");
  });

  it("compares case-insensitively and tolerates surrounding whitespace", () => {
    assert.equal(classifyApp("  COM.APPLE.TERMINAL  "), "terminal-app");
    assert.equal(classifyApp("Com.GoogleCode.ITerm2"), "iterm");
    assert.equal(classifyApp("\tcom.microsoft.vscode\n"), "editor");
  });
});

describe("buildFrontmostScript", () => {
  it("asks System Events for the frontmost app's bundle identifier", () => {
    const script = buildFrontmostScript();
    assert.match(script, /System Events/);
    assert.match(script, /bundle identifier/);
    assert.match(script, /frontmost is true/);
  });
});

describe("buildDeliveryScript", () => {
  it("uses Terminal's do script with the command, when pressEnter is true", () => {
    const script = buildDeliveryScript("terminal-app", "echo hi", true);
    assert.match(script, /do script/);
    assert.match(script, /echo hi/);
    assert.match(script, /front window/);
  });

  it("falls back to the keystroke form for Terminal when pressEnter is false", () => {
    const script = buildDeliveryScript("terminal-app", "echo hi", false);
    assert.doesNotMatch(script, /do script/);
    assert.match(script, /keystroke/);
  });

  it("uses iTerm's write text with the command, when pressEnter is true", () => {
    const script = buildDeliveryScript("iterm", "echo hi", true);
    assert.match(script, /write text/);
    assert.match(script, /echo hi/);
  });

  it("falls back to the keystroke form for iTerm when pressEnter is false", () => {
    const script = buildDeliveryScript("iterm", "echo hi", false);
    assert.doesNotMatch(script, /write text/);
    assert.match(script, /keystroke/);
  });

  it("includes key code 36 for the keystroke form when pressEnter is true", () => {
    const script = buildDeliveryScript("keystroke", "echo hi", true);
    assert.match(script, /keystroke/);
    assert.match(script, /key code 36/);
  });

  it("omits key code 36 for the keystroke form when pressEnter is false", () => {
    const script = buildDeliveryScript("keystroke", "echo hi", false);
    assert.match(script, /keystroke/);
    assert.doesNotMatch(script, /key code 36/);
  });

  it("uses the same keystroke form for editors as for keystroke-only terminals", () => {
    const script = buildDeliveryScript("editor", "echo hi", true);
    assert.match(script, /keystroke/);
    assert.match(script, /key code 36/);
  });

  it("embeds a command containing a double quote without breaking the literal", () => {
    const script = buildDeliveryScript("terminal-app", 'echo "hi"', true);
    assert.match(script, /echo \\"hi\\"/);
  });

  it("throws for an unsupported app, as a guard against ever reaching it", () => {
    assert.throws(() => buildDeliveryScript("unsupported", "echo hi", true), /refusing/);
  });

  // AppleScript allows a literal newline inside a string and osascript rejoins
  // its -e fragments, so an embedded newline does not fail — it quietly becomes
  // a second command, and gets typed as Return even when pressEnter is false.
  it("collapses an embedded newline so one command stays one command", () => {
    const script = buildDeliveryScript("terminal-app", "claude --foo\nrm -rf /tmp/x", true);
    assert.doesNotMatch(script.replace(/\n$/, ""), /\n/, "command must not span lines");
    assert.match(script, /claude --foo rm -rf \/tmp\/x/);
  });

  it("keeps pressEnter:false honest when the command contains a newline", () => {
    const script = buildDeliveryScript("keystroke", "echo one\necho two", false);
    // Exactly one statement, no Return keystroke, and no raw newline that
    // System Events would type as one.
    assert.doesNotMatch(script, /\n/);
    assert.doesNotMatch(script, /key code 36/);
    assert.match(script, /echo one echo two/);
  });
});
