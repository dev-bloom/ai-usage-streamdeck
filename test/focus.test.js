import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildFindAndFocusTabScript,
  normaliseTty,
  parseAncestry,
  toDeviceTty,
} from "../.build/lib/focus.js";

describe("normaliseTty", () => {
  it("collapses the measured mismatch: ps's bare form and Terminal's /dev/-prefixed form", () => {
    // ps -o tty= returns "ttys000"; Terminal.app's AppleScript `tty of t`
    // returns "/dev/ttys000" for the exact same session — measured on this
    // machine. Comparing those two strings directly would never match.
    assert.equal(normaliseTty("ttys000"), "ttys000");
    assert.equal(normaliseTty("/dev/ttys000"), "ttys000");
  });

  it("trims surrounding whitespace, since ps and osascript output both carry it", () => {
    assert.equal(normaliseTty("  ttys000\n"), "ttys000");
    assert.equal(normaliseTty(" /dev/ttys000 "), "ttys000");
  });
});

describe("toDeviceTty", () => {
  // ps speaks "ttys000"; Terminal speaks "/dev/ttys000". normaliseTty
  // canonicalises inbound values to the bare form; toDeviceTty goes the
  // other way for anything crossing back out into an AppleScript `whose
  // tty is ...` clause. Getting this backwards is silent — the clause just
  // matches zero tabs, not an error — which is why both directions are
  // pinned here against the same three inputs normaliseTty is tested with.
  it("round-trips normaliseTty's canonical form back to Terminal's /dev/-prefixed form", () => {
    assert.equal(toDeviceTty("ttys000"), "/dev/ttys000");
    assert.equal(toDeviceTty("/dev/ttys000"), "/dev/ttys000");
    assert.equal(toDeviceTty("  ttys000\n"), "/dev/ttys000");
    assert.equal(toDeviceTty(" /dev/ttys000 "), "/dev/ttys000");
  });
});

describe("parseAncestry", () => {
  // Fixtures shaped like the three real chains measured on this machine
  // (see focus.ts's OWNER_APP_NAMES doc comment), using `ps -o comm=`'s real
  // shape: a bare name for a CLI/shell (`zsh`, `-zsh`, `login`) and a full
  // bundle-relative executable path for a GUI app — measured live,
  // `comm=` prints "/Applications/Visual Studio Code.app/Contents/MacOS/Code",
  // not the bare "Code" the task brief described (that bare form is what
  // `ucomm=` prints instead, which has its own hazard — see the "16
  // characters" test below).
  //   pid 32893  zsh <- Code Helper <- Code     (VS Code integrated terminal)
  //   pid 4477   zsh <- Code Helper <- Code     (VS Code integrated terminal)
  //   pid 63004  -zsh <- login <- Terminal      (Terminal.app)
  const CODE_PATH = "/Applications/Visual Studio Code.app/Contents/MacOS/Code";
  const CODE_HELPER_PATH =
    "/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper";
  const TERMINAL_PATH = "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal";

  const vscodeTable = (sessionPid, shellComm) => `
    1     0 /sbin/launchd
32700     1 ${CODE_PATH}
32800 32700 ${CODE_HELPER_PATH}
${sessionPid} 32800 ${shellComm}
`;

  const terminalTable = `
    1     0 /sbin/launchd
62980     1 ${TERMINAL_PATH}
62990 62980 login
63004 62990 -zsh
`;

  it("resolves a VS Code integrated-terminal session (pid 32893) to com.microsoft.VSCode", () => {
    const owner = parseAncestry(vscodeTable(32893, "zsh"), 32893);
    assert.equal(owner?.bundleId, "com.microsoft.VSCode");
    assert.equal(owner?.comm, CODE_PATH);
  });

  it("resolves a second VS Code integrated-terminal session (pid 4477) to com.microsoft.VSCode", () => {
    const owner = parseAncestry(vscodeTable(4477, "zsh"), 4477);
    assert.equal(owner?.bundleId, "com.microsoft.VSCode");
  });

  it("resolves a Terminal.app login-shell session (pid 63004, comm '-zsh') to com.apple.Terminal", () => {
    const owner = parseAncestry(terminalTable, 63004);
    assert.equal(owner?.bundleId, "com.apple.Terminal");
    assert.equal(owner?.comm, TERMINAL_PATH);
  });

  it("returns null when the starting pid is not in the table", () => {
    assert.equal(parseAncestry(terminalTable, 99999), null);
  });

  it("returns null when the chain runs out without hitting a known owner", () => {
    const table = `
    1     0 /sbin/launchd
   50     1 someDaemon
  100    50 zsh
`;
    assert.equal(parseAncestry(table, 100), null);
  });

  it("does not throw on a ppid cycle and returns null", () => {
    const table = `
  200   300 a
  300   200 b
`;
    assert.doesNotThrow(() => {
      assert.equal(parseAncestry(table, 200), null);
    });
  });

  it("matches an owner whose executable basename is 16+ characters, where ucomm would have silently truncated it", () => {
    // `ps -o ucomm=` is the kernel's p_comm and is truncated to 16 characters
    // — measured on this machine, a real "Claude Helper (Renderer)" process
    // reports ucomm exactly "Claude Helper (R", cut mid-word. That is why
    // focus.ts matches on basename(comm) instead of ucomm: comm has no such
    // limit. `ownerNames` is overridden here (rather than relying on
    // anything actually in the shipped OWNER_APP_NAMES table, none of which
    // happens to be this long) so this test proves the algorithm itself has
    // no length limit, independent of what's currently shipped.
    const longName = "SuperLongTerminalName"; // 22 characters, well past ucomm's 16-character cutoff
    assert.ok(longName.length >= 16);
    const table = `
    1     0 /sbin/launchd
   77     1 /Applications/${longName}.app/Contents/MacOS/${longName}
   99    77 zsh
`;
    const owner = parseAncestry(table, 99, { [longName]: "com.example.superlong" });
    assert.equal(owner?.bundleId, "com.example.superlong");
  });
});

describe("buildFindAndFocusTabScript", () => {
  // The one test in this file that would have caught the live bug: every
  // other test here runs against fixtures and never talks to Terminal.app,
  // so a tty interpolated in the wrong form (bare "ttys000" instead of
  // Terminal's own "/dev/ttys000") compiled and ran fine in every fixture
  // test while silently matching zero tabs against the real app — "no such
  // tab", not a thrown error. Asserting the emitted script actually contains
  // the /dev/-prefixed form is what pins the fix. Carried over from the old
  // two-script builder (buildFocusTabScript) onto this single-script one —
  // the hazard it guards against is identical.
  it("emits the tty in Terminal's /dev/-prefixed form, even when given the bare canonical form", () => {
    const script = buildFindAndFocusTabScript("ttys000");
    assert.match(script, /tty is "\/dev\/ttys000"/);
    assert.doesNotMatch(script, /tty is "ttys000"/);
  });

  it("is idempotent when already given the /dev/-prefixed form", () => {
    const script = buildFindAndFocusTabScript("/dev/ttys000");
    assert.match(script, /tty is "\/dev\/ttys000"/);
  });

  it("searches every window, selects the matched tab, and activates", () => {
    const script = buildFindAndFocusTabScript("ttys000");
    assert.match(script, /repeat with w in windows/);
    assert.match(script, /set selected of t to true/);
    assert.match(script, /activate/);
  });

  it("wraps the tab lookup in a try so a non-matching window doesn't abort the whole search", () => {
    // Without this try, "first tab of w whose tty is ..." raises on the
    // first window that lacks a matching tab, aborting the repeat before
    // any later window — possibly the one that does match — is checked.
    const script = buildFindAndFocusTabScript("ttys000");
    assert.match(script, /try[\s\S]*first tab of w whose tty is[\s\S]*end try/);
  });

  it("returns the ok/nomatch sentinel strings rather than relying on an exit code", () => {
    const script = buildFindAndFocusTabScript("ttys000");
    assert.match(script, /return "ok"/);
    assert.match(script, /return "nomatch"/);
  });
});
