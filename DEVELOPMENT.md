# Working on this plugin

The development loop is: save a file → rollup rebuilds → the Stream Deck app restarts
the plugin → the key repaints. No re-installing, no dragging the action back onto a key.

## One-time setup

```bash
cd ~/Documents/streamdeck/plugins/ai-usage-streamdeck
./scripts/dev-setup.sh
```

The script checks your Node version, installs dependencies and the Elgato CLI if needed,
and links this folder into Stream Deck as a development plugin. It prints what it is about
to do at each step.

If you would rather do it by hand:

```bash
node --version                          # needs v24 or newer for the Elgato CLI
npm install
npm install -g @elgato/cli
npm run build
streamdeck link com.devbloom.ai-usage.sdPlugin
```

### Remove the packaged copy first

If you already installed `com.devbloom.ai-usage.streamDeckPlugin` by double-clicking it,
uninstall that before linking. Two copies with the same UUID will fight over which one
Stream Deck loads, and the symptom — edits that appear to do nothing — is confusing.

Right-click the plugin in the Stream Deck actions list and choose **Uninstall**, or run:

```bash
rm -rf ~/Library/Application\ Support/com.elgato.StreamDeck/Plugins/com.devbloom.ai-usage.sdPlugin
```

`streamdeck link` then puts a symlink back in that same folder pointing here, which is what
makes live reload work: Stream Deck is reading the build output directly out of this
project.

## The loop

```bash
npm run watch
```

Leave that running. Every save to `src/` rebuilds the bundle and restarts the plugin.
Give it a second or two — the restart is not instant.

To watch what the plugin is actually doing:

```bash
tail -f com.devbloom.ai-usage.sdPlugin/logs/*.log
```

`streamDeck.logger` writes there. Bump the level in `src/plugin.ts` from `INFO` to `TRACE`
to see the full websocket conversation with the Stream Deck app, which is the fastest way
to diagnose a key that will not paint.

## Iterating without touching hardware

Two things are much faster to check off-device than on:

**Key faces.** `npm run preview` renders every state — both-windows, each gauge, the error
cards — to `/tmp/preview` as SVG. Add a case to `scripts/preview.mjs` to cover a new one.
Nothing about `src/lib/render.ts` needs a Stream Deck to verify.

**The settings panel.** `node scripts/shoot-pi.mjs /tmp/pi.png` screenshots the property
inspector in headless Chromium with mocked settings, and `npm run test:ui` drives the real
sliders and asserts the readouts follow. The panel is a web page, so the browser is a
truthful preview of it.

**Icons.** `scripts/icons.py` needs `cairosvg`, which was never installed here, so it
cannot run — treat it as dead; it's still in the repo but produces nothing. The Codex icons
were never generated with it: `npm run icons:codex` runs `scripts/gen-codex-icons.mjs`,
which screenshots SVG in headless Chromium via Playwright instead, reusing the Playwright
dependency `shoot-pi.mjs` already pulled in. Its colours, ring-gauge geometry, and corner
radius are copied by hand from `icons.py` so the Codex assets stay in the same visual
family as the Claude ones already on disk.

## Tests

```bash
npm test          # parsing, thresholds, countdown formatting, SVG rendering, Codex mapping, transport guard, sessions
npm run test:ui   # the settings panel, in a browser — Claude meter panel only, see below
```

310 unit tests, 6 UI tests, all passing (`node --test test/*.test.js` reports `tests 310`,
`test/pi.test.mjs` reports `tests 6`) — re-measured for this pass, not carried over from an
earlier count. That count has moved three times in one day (297 → 307 for the adjustable
long-press threshold → 302 once `parseTerminalTabs`/`matchWindow` and their tests were
deleted → 310 for the whole-key fill flash), which is exactly why it's worth re-running
`npm test` yourself rather than trusting a number in this file. `npm test` compiles to
`.build/` first, so it always runs against current source.

`test:ui` predates Codex and still only drives `ui/meter.html`'s sliders. The two Codex
property inspectors (`ui/codex-meter.html`, `ui/codex-launch.html`), Launch Claude's own
panel, and now `ui/sessions.html` (the Claude Sessions bucket filter, added after this key
shipped with no settings at all) are none of them covered by it — a gap, not a decision, if
you're picking this back up. Claude Sessions did briefly have no property inspector and
nothing to leave uncovered; that stopped being true the moment it gained the Show setting,
so it now belongs to the same gap as the other three rather than being exempt from it.

### The Codex transport guard is not a normal test

`test/codex-transport.test.js` reads `src/lib/providers/codex.ts` as text and asserts it
never calls bare `fetch(`. That is unusual, and it exists because every other test in the
suite would stay green even if that rule were broken — see "Node's `fetch` cannot talk to
the Codex endpoint" below. It was mutation-tested by hand: temporarily reintroducing a
`fetch(` call into `codex.ts` makes the guard fail, confirming it actually catches the
regression it's there for.

**Do not "modernise" this guard away**, and do not replace `codex.ts`'s `node:https` call
with `fetch` even if it looks like unnecessary friction. Both would silently reopen the
403 this file exists to prevent, with every other test still passing.

## Shipping a build

```bash
npm run pack
```

Produces `com.devbloom.ai-usage.streamDeckPlugin`. Bump `Version` in
`com.devbloom.ai-usage.sdPlugin/manifest.json` first — Stream Deck uses it to decide
whether an install is an upgrade.

Note that packing while `streamdeck link` is active is fine; the linked copy and the
packaged file are independent.

## Gotchas worth knowing

**A key that says "see logs" is a promise, and until now nothing was writing them.** A user
hit an `ERROR` card, checked the logs as told, and found them empty. The cause: `store.ts`
recorded every failure in its own `state` but never wrote to disk — the only `logger` call
in the entire plugin was a paint failure in `meter.ts`, which has nothing to do with why a
key is showing `ERROR` in the first place. `store.ts` deliberately imports nothing from the
Stream Deck SDK so it stays unit-testable without one (see the class comment on
`UsageStore`), which is exactly why the actual logging couldn't just be added there
directly. The fix is `UsageStore.onFailure`, an injectable callback wired up in
`meter.ts` — which already imports `streamDeck.logger` for the paint-failure case — rather
than a Stream Deck import added to `store.ts` itself. It fires from inside `doFetch`, so one
shared store logs a failure once no matter how many keys of that provider are on screen, and
`lastLoggedFailureMessage` dedupes a failure that repeats every 60-second poll down to one
line, re-arming only when the message actually changes or a fetch recovers. If you're
extending the failure taxonomy again, check `test/store.test.js` first — it's what pins this
behaviour down.

**Node versions differ by layer.** The Elgato CLI needs Node 24+, but the plugin itself
runs under the Node runtime Stream Deck ships (declared as `"Version": "20"` in the
manifest). Do not use APIs newer than Node 20 in `src/`.

**The keychain prompt.** Every restart of the plugin process re-reads credentials on its
first poll. If macOS starts prompting on each reload, click **Always Allow**; the token is
then cached in memory for its full lifetime, so a normal session prompts at most once.

**`streamdeck restart` does not actually restart the plugin.** On Stream Deck 7.4.2 it
prints `✔ Restarted` and returns success while the plugin process keeps running with the
old code — verified by watching the PID, which does not change. The symptom is the
confusing one: rollup rebuilds, nothing on the key changes.

Killing the process works, and Stream Deck respawns it within a few seconds. Use the
script — `npm run watch` uses it as its rebuild hook for this reason:

```bash
./scripts/reload.sh
```

Do not reach for a bare `pkill -f <plugin path>`. That matches any process whose full
command line merely *contains* the path — an editor, a grep, another shell — so a rebuild
firing at the wrong moment kills unrelated commands. `reload.sh` additionally checks the
executable is Node before signalling anything.

If you ever restart by hand, check the PID really changed:

```bash
pgrep -f com.devbloom.ai-usage.sdPlugin/bin/plugin.js
```

**Changing the manifest requires a real restart.** Restarting the plugin process is not
enough — Stream Deck only re-reads `manifest.json` when the plugin is loaded fresh. After
editing actions, icons, or `Controllers`, quit and reopen Stream Deck. This applies just the
same to adding a whole new action, as when Launch Claude was added, and again when Codex
Usage and Launch Codex were added — a rebuilt bundle alone does not make a new action show
up in the actions list. The two Codex actions will not appear on a deck until Stream Deck
itself is quit and reopened, not just reloaded.

**The probe counts as activity — for Claude only.** A tight watch loop that keeps
restarting the plugin will keep firing Claude usage probes. Harmless, but if you are
testing for a while, set the refresh interval to 15 minutes in the Claude meter's settings
so you are not nudging your own 5-hour window. Codex has no equivalent concern: its usage
endpoint is free to poll (see `pollCostsQuota` on `Provider`), so a tight interval there
costs nothing but noise in the logs.

**Node's `fetch` cannot talk to the Codex usage endpoint — the expensive one.** Cloudflare
sits in front of `https://chatgpt.com/backend-api/codex/usage` and rejects Node's `fetch`
(undici) with a 403 regardless of token validity. Measured back to back on this machine,
same credentials, same headers: `fetch` 0/6 successful, `node:https` 6/6. Python's
`urllib` also succeeds against the same endpoint, so it isn't the endpoint that's broken —
undici specifically gets fingerprinted. Two things compound this into a real time sink:

- An explicit, non-default `User-Agent` is *also* required on its own — a request missing
  one 403s even over `node:https`. Getting a 200 needs both fixes together, not either one.
- Adding an `accept-language` header looks like it fixes the `fetch` case and doesn't —
  that combination measured 403/200/403 back to back, i.e. noise that would read as
  a fix if you stopped after the one success.

The reason this is worth its own heading: **every unit test in this repo feeds
`mapUsagePayload` a fixture and never opens a socket**, so this failure is invisible to a
fully green test suite. Without `test/codex-transport.test.js`, reverting `codex.ts` to
`fetch` would ship a plugin that fails 100% of the time on a real machine behind the rest
of the suite — 164 tests as of this writing — passing. `codex.ts` uses `node:https` for
this reason, and that one file's tests are what closes the gap — see "The Codex transport
guard is not a normal test" above. The general lesson, worth carrying into anything else
this repo talks to: **a green test suite that never opens a socket is not evidence that a
network client works.**

**A 403 from this endpoint gets its own `UsageFailure` kind (`blocked`), not `error`, for
the same "invisible to a green suite" reason as the transport guard above.** Getting a live
403 out of Cloudflare on demand isn't something a unit test can arrange either, so
`test/codex-transport.test.js` asserts on the source text of the 403 branch rather than
triggering one — the same style of guard as the `fetch`-vs-`node:https` check just above it,
for the same reason. `classifyProbeError` (also in `codex.ts`), which maps `probe`'s
`req.on("error", ...)` rejections and its request-timeout `Error` to the new `offline` kind,
*is* directly unit-testable against synthetic errors instead — see `classifyProbeError` in
`test/codex.test.js` — because those don't require a live socket to construct, only a
plausible `NodeJS.ErrnoException`.

**`primary_window` is not always the 5-hour window.** Codex's usage endpoint returns
`primary_window` / `secondary_window`, and on the account this was tested against,
`primary_window` was observed to be the **weekly** window (`limit_window_seconds: 604800`),
confirmed independently by the `x-codex-primary-window-minutes: 10080` header on a
different endpoint. `codex.ts` therefore classifies each window by its
`limit_window_seconds` duration (≤6h session, ≥24h weekly) and never by which JSON slot it
arrived in — trusting the slot name would silently swap the two numbers on the key, a
wrong-but-plausible result that is worse than an obvious failure because nothing about it
looks wrong.

**Codex's `used_percent` is already 0–100; Claude's header is a 0–1 fraction.** Same
concept, different scale. `usage.ts`'s `parsePct` is deliberately not reused for Codex's
payload — reusing it would double-scale every reading.

**`secondary_window` can be, and during testing always was, `null`.** Observed null on a
ChatGPT Plus account throughout testing, including immediately after a request. That means
"not reported," not "0% used," which is why `UsageSnapshot.sessionPct` / `weeklyPct` are
typed `number | null` rather than defaulting a missing reading to zero — a null renders as
an em dash (`—`) with no bar, verified live as `5H — / 7D 0%` on a real snapshot.

Whether the 5-hour window ever populates on this plan was flagged **unverified** for a
while, correctly, under this repo's own rule that a negative measurement is not evidence —
every one of those `null` readings was taken at 0% usage, exactly the condition under which
a dormant window and a nonexistent one produce the same null. It's resolved now, and *how*
it got resolved is worth keeping as the general case, because it runs against that rule
rather than just restating it:

1. **Force the condition that would falsify it.** A `codex exec` run was made that actually
   spent tokens (4,069 of them), instead of polling at 0% again, and the endpoint was
   re-read immediately after. `secondary_window` was still `null`; `primary_window` was
   still the 7-day one. If a dormant 5-hour window existed, real spend is exactly what
   should have woken it — nothing did.
2. **Corroborate from outside your own code.** The responses endpoint's
   `x-codex-secondary-window-minutes: 0` header (measured earlier, alongside
   `x-codex-primary-window-minutes: 10080`) agreed. So did the ChatGPT app's own "Usage
   remaining" menu — a single `Weekly 100% Aug 21` row, no 5-hour row — which is OpenAI's
   own UI, shares none of this plugin's parsing code, and agreed down to the reset date.

Three independent readings converging is what turned a null nobody trusted into a finding:
**Codex on a ChatGPT Plus plan has no 5-hour window at all; it limits weekly only.** The
general lesson, and the reason it's worth writing down here rather than just fixing the
copy: **a negative measurement becomes evidence once you've forced the condition that would
have falsified it *and* corroborated the result from outside your own code — not before.**
Absent either half, a `null` is still just a gap, and treating it as anything more is the
same mistake the Rectangle Pro sweep made in its false "this action does nothing" results
(see the parent `README.md`'s "Verifying against a real app" section) — trusting a negative
that was never forced or independently checked.

This is measured on one ChatGPT Plus account, not claimed for every plan or promised to
hold in the future — `codex.ts` still classifies windows by duration rather than by which
slot they arrive in, and a window that's genuinely absent still renders as `—` rather than
a false zero, so a 5-hour window appearing later needs no code change, only a real reading.
It's also why `Provider` gained `defaultMode` (`"both"` for Claude, `"weekly"` for Codex)
and `supportedModes` (all three for Claude, `["weekly"]` for Codex). `ui/codex-meter.html`
has no window selector at all: on a provider reporting one window, the other two faces
could only ever draw an em dash where a number belongs.

**`supportedModes` is enforced in `meter.ts` too, not just by removing the control**, and
that redundancy is the point. Stream Deck persists per-key settings, so a Codex key that
saved `mode: "both"` before any of this was understood would go on rendering a dead row
forever — deleting the dropdown removes the way to *create* that state but does nothing
about keys already in it, and nothing else would ever clear it. Tests in `test/view.test.js`
cover the per-provider default, the supported-mode lists, that every provider's default is
one it can actually draw, and that no `setting="mode"` control reappears in the Codex panel.

**No token refresh for Codex, and that's deliberate, not unfinished.** Claude's opt-in
refresh works because Claude Code's OAuth client id is public knowledge; no equivalent
Codex CLI client id could be verified, and shipping a guessed one — and minting tokens
against it — is a worse failure mode than the one it would prevent. `fetchCodexUsage`
accepts the shared `allowRefresh` option and ignores it. This is low-cost in practice: a
Codex access token lasts roughly **10 days** — measured directly from a real token's
`iat`/`exp` claims (`iat 2026-08-06 14:39:33`, `exp 2026-08-16 14:39:33`), not the ~40-hour
figure an earlier draft of this doc guessed from "however much time was left when I looked
at it" — and the standalone Codex CLI is known to refresh its own token on every launch, so
a `stale` (now `EXPIRED`) key clears with one `codex` invocation if that CLI is installed.
Credentials come from plaintext `~/.codex/auth.json`, read-only, for the same reason the
keychain read is read-only: Codex owns that file, and losing a write race would sign the
user out of Codex itself, not just this key. There is no expiry field in the file itself,
so expiry is read from the JWT `exp` claim in the access token.

Codex now ships inside the ChatGPT desktop app, and that app is what owns
`~/.codex/auth.json` day to day on a machine with no standalone CLI installed — so the
property inspector points a `SIGN IN`/`EXPIRED` key at "open ChatGPT" first, `codex` second.
**Whether opening the ChatGPT app alone refreshes the stored token is unverified.** On this
machine, `~/.codex/auth.json`'s mtime and its own `last_refresh` field were both still
2026-08-06 — unchanged since the token was issued — despite the app being open. Until that's
actually confirmed, do not claim in any copy that opening ChatGPT refreshes the token; say
it's the thing to try, because it owns the file, not that it works.

**Launch Codex ships the bare `codex` command, not a permission-bypass flag — even though
the flag is now verified.** It's `--dangerously-bypass-approvals-and-sandbox` ("Skip all
confirmation prompts and execute commands without sandboxing. EXTREMELY DANGEROUS."), read
from `--help` on `codex-cli 0.147.0-alpha.6.5`, the Codex CLI bundled inside the ChatGPT
desktop app. There is no `--yolo` alias in that build — checked, not assumed, the same way
this repo avoided guessing it earlier. `CODEX_DEFAULT_COMMAND` in `src/lib/terminal.ts`
stays the bare command anyway: shipping a permission-bypass flag as a *default* risks
silently disabling sandboxing for anyone who never opens the property inspector, verified
flag name or not. That's a design choice, not a gap — add the flag yourself in the key's
settings if you want it.

**Getting bare `codex` onto `PATH` took three independent fixes, and each one masked the
next.** This matters because Launch Codex's default command is bare `codex`, so all three
had to be true before that key could work at all:

1. nvm's default pointed at an uninstalled version (`default -> lts/jod (-> N/A)`), so no
   `node` existed in a plain shell and the CLI's `#!/usr/bin/env node` shim died with
   `env: node: No such file or directory`.
2. `~/.bun/bin` precedes the nvm bin directory on `PATH`, and bun's global
   `@openai/codex` 0.77.0 had an empty vendored binary directory. This is the nasty one:
   `npm i -g @openai/codex` reported success and changed nothing observable, because the
   broken bun shim kept winning the `PATH` race. `bun remove -g @openai/codex` fixed it.
   The npm build that then took over (`codex-cli 0.147.0`) has no `vendor/` directory at
   all, so the original "empty vendor dir" diagnosis was specific to the older 0.77.0
   layout and does not generalise.
3. A corrupt `~/.codex/config.toml` stopped every binary from starting — see the next
   gotcha.

The general lesson, which cost the most time here: **when a reinstall changes nothing,
check `which` before you check the package.** Two installs of the same tool on one `PATH`
means the one you fixed may not be the one you're running.

A working Codex binary also ships inside the app bundle regardless of any of this, at
`/Applications/ChatGPT.app/Contents/Resources/codex`, which is what was actually used to
read the `--help` output above. `ui/codex-launch.html` documents pointing the key's Command
field at that full path as the fallback when `codex` isn't on `PATH`; the shipped *default*
stays plain `codex` regardless, since that's the right answer for anyone with a normal
install and the app-bundle path is one `ChatGPT.app` update away from moving.

**A working `codex` binary can still refuse to start over a user's own config, which looks
like this plugin's bug and isn't.** The ChatGPT-bundled `codex` failed here with
`Error loading configuration: ~/.codex/config.toml:26:30: unexpected key or value` — two
settings concatenated onto one line in that file. Nothing in this plugin reads or writes
`config.toml`; if Launch Codex or a manual `codex` invocation fails this way, the fix is in
that file, not here.

## Claude Sessions gotchas

**THE EXPENSIVE ONE — `procStart` in the session registry is UTC-rendered; `ps -o lstart=`
prints local time.** Verified live, on all three sessions running on this machine at the
time: comparing the registry's `procStart` string against `ps`'s own `lstart` rendering for
the same pid gave `false` at local time and `true` under `TZ=UTC`; for one session the local
rendering was even a different calendar day (`Fri Aug 14` vs `Sat Aug 15`). The obvious
implementation of the documented PID-reuse guard — compare the two timestamp strings to
confirm a registry file's pid hasn't since been recycled by an unrelated process — yields
**zero live sessions, permanently and silently, on any machine not set to UTC.** Not a
crash, not a log line: a key that plausibly just reads 0/0/0 forever. The fix was not a
timezone conversion but dropping the timestamp guard entirely, in favour of
`comm === "claude"` read straight from `ps` (`claudePidsFromTable` in `src/lib/sessions.ts`).
The asymmetry is the reason the fix went that direction rather than "just convert to UTC
first": a start-time guard fails **toward marking live sessions dead** — a permanent silent
zero, this feature's worst possible failure — while a name-only guard fails **toward briefly
counting a session that already exited** — self-corrected by the next 3-second poll. One
failure mode is unrecoverable without someone noticing something is wrong; the other heals
itself in three seconds. The measured pair (`Wed Aug 12 23:08:23 2026` UTC vs
`Sat Aug 15 03:50:09 2026` local, same process) lives both in a code comment on
`claudePidsFromTable` and in a test fixture in `test/sessions.test.js`, specifically so
nobody "cleans up" the guard back into a string comparison later.

**`ps -axo comm=` prints full paths for most processes but a bare `claude` for the CLI.**
Verified: all three live CLI sessions on this machine reported `comm` exactly `"claude"`;
the Claude desktop app reported full paths instead —
`/Applications/Claude.app/Contents/MacOS/Claude` and several
`…/Claude Helper (Renderer)` entries. Exact, case-sensitive equality against `"claude"` is
therefore both necessary and sufficient: it includes what this key wants and excludes eight
Electron helper processes that a case-insensitive or substring match (`grep -i claude`)
would wrongly sweep in. `ucomm` looks like the more "correct" `ps` field to reach for here
and isn't — it returns the CLI's *version string* (`2.1.233`), because the binary actually
lives at `~/.local/share/claude/versions/<version>`.

**Do not read the `.jsonl` transcripts to infer session state — measured as actively
misleading, not just unnecessary.** A blocked permission prompt writes *nothing* to the
transcript, so a transcript-based version would report a session stuck waiting on you as
idle — the one case this key most needs to get right. Separately, a `system/turn_duration`
entry can appear even when a queued prompt continues straight into its next turn, so the
same approach would report a session that's still working as finished. `test/sessions-guard.test.js`
asserts the source of `sessions.ts` never references `.jsonl`, specifically because this is
a plausible-looking "improvement" that no behavioural test in this repo would object to —
the transcript is real conversation data and looks like it should be more informative than a
one-word status field. That guard file has three assertions in total (never writes,
unlinks, renames, or opens a write stream against the registry it only reads; the `ps` call
carries an explicit `execFile` timeout; no `.jsonl` reference anywhere in the source) and
each was hand-mutation-tested by temporarily reintroducing the thing it forbids and
confirming the guard fails. Same framing as `codex-transport.test.js`: **do not "modernise"
this file away.**

**Subagents do not register in the session registry.** With three subagents running under
one terminal, the registry held exactly one entry — one per top-level terminal session, not
one per agent. Subagent rollup into the parent is free: no code was needed to collapse them,
because there was never anything separate to collapse.

**`pgrep -x claude` undercounts.** It reported 2 while `ps -axo comm=` correctly reported 3
live sessions at the same moment. Worth knowing if you're tempted to reach for the simpler
command while poking at this feature by hand.

**Field sets already differ across co-resident CLI versions.** Three Claude Code versions
were observed running simultaneously on this machine (2.1.229 / 2.1.232 / 2.1.233):
`nameSince` is absent from files written by 2.1.229, `nameSource` appears only from 2.1.233
onward, and `waitingFor` is *absent* — not `null` — until a session first enters `waiting`.
A strict schema validator over these files would already be rejecting real, currently-running
sessions. `parseSessionRecord` in `sessions.ts` requires only `pid`; every other field is
read defensively as optional, and unknown keys are simply ignored — see the function's own
comment.

**The `sessionsDir` test seam is easy to defeat with a typo, and the failure is silent.**
`readSessions({ sessionsDir, runPs })` in `src/lib/sessions.ts` is how tests exercise a
degraded registry (missing directory, unreadable files, no live pids) without ever touching
the real `~/.claude/sessions`. Pass the *wrong* option name — `sessionDir`, `dir`, anything
but `sessionsDir` exactly — and `opts.sessionsDir` is simply `undefined`, so
`dir = opts.sessionsDir ?? SESSIONS_DIR` quietly falls back to the real directory. A
misspelled seam looks exactly like no seam existing at all: the test still runs and still
passes or fails on *something*, just not the fixture you meant to point it at. Worth
double-checking the option name first if a new sessions test ever behaves oddly against real
local state.

**Hooks were considered for this feature and rejected.** Claude Code exposes 29 hook
events, and `PermissionRequest` fires the instant a permission dialog appears — which sounds
like a strictly better signal than polling a file every 3 seconds. Rejected because the
registry already carries `status` and `waitingFor` natively, with zero configuration, zero
added latency on any tool call, and no edits to the user's own `settings.json`. The one real
argument for hooks is that they're Claude Code's public, documented contract, while the
sessions registry is undocumented and could change shape without notice — which is exactly
what the `ps` corroboration described in this plugin's own README.md (the "Claude Sessions"
section, "Where the numbers come from") exists to catch. Worth revisiting only if the
registry format actually breaks, not before — recorded here so the option isn't
rediscovered from scratch next time someone looks at this feature.

**The bucket filter (`ui/sessions.html`'s Show dropdown) must never be able to hide a
problem face, and that's enforced by ordering, not by a special case.**
`sessionsViewFor` in `src/lib/view.ts` reads `mode` only inside the branches that build a
"counts" or "focus" face; every `sessionsProblemView` call is reached and returned before
`mode` is even looked at. Verified directly across all three problem states
(`UNKNOWN STATUS`, `NO REGISTRY`, `UNREADABLE`) crossed with all four modes (all/waiting/
processing/idle): a key pinned to "Idle only" still shows the full problem face in every
case. The rule worth keeping in mind if this function is ever restructured: a mode filter
is a display preference over data the key already trusts, and it must never get a chance to
decide whether untrustworthy data gets shown at all.

**The peek follows the bucket filter — except on the unknown-status face, where it
deliberately ignores it.** A key pinned to "Waiting only" peeks only waiting sessions
(`sessionsFocusedPeek` in `view.ts`) and, if there are none, says "no waiting sessions"
rather than silently showing nothing. The one exception is on purpose:
`bucketFromStatus` never sorts anything into waiting/processing/idle as "unknown" — by
definition an unrecognised status has no bucket a filter could match — so filtering the
unknown-status peek would just empty a list that exists specifically to show those raw
strings. Applying the mode filter there anyway would look like a bug fix and would actually
be the bug: it would take the one face that surfaces an unrecognised status and make it
show nothing whenever the key wasn't set to "All three."

**An unset or unrecognised `mode` in settings falls back to `"all"`.** Same defensive
posture as `thresholdsFrom`'s handling of a nonsense slider value: a key that predates the
Show setting, or a hand-edited settings blob carrying a value that isn't one of the four
known modes, must not be trusted to pin the key to a bucket that doesn't exist and leave
`sessionsViewFor` with no sane branch to take. `sessionsModeFrom` in `view.ts` is the single
place this is decided.

## Hold-to-focus gotchas

**THE ONE THAT SHIPPED BROKEN — `ps` says `ttys000`, Terminal says `/dev/ttys000`, and the
code interpolated the wrong one into the AppleScript clause.** `focus.ts` canonicalises
inbound tty values correctly (`normaliseTty` strips a `/dev/` prefix so `ps`'s bare form and
Terminal's prefixed form compare equal), then the first version interpolated that same
*canonical* form straight into the `whose tty is …` clause of `buildFocusTabScript` — the
one place a tty value crosses back out into Terminal's own AppleScript namespace, where only
the `/dev/`-prefixed spelling is recognised. Measured against the real app, side by side:

```
tabs whose tty is "ttys000"      → 0 matches
tabs whose tty is "/dev/ttys000" → 1 match
```

It failed as a silent no-match — `focusSession` returned `{ ok: false, reason: "no-match" }`,
not a thrown error, indistinguishable from "the session's tab already closed." Two things
worth generalising past this one bug. First, **a read-only verification passed and gave
false confidence**: reading `tty of t` back out of Terminal and *matching against* it are
different operations, and the fixture tests that read tabs back all passed while the live
match still failed. Second, **no fixture-based test could have caught it**, because fixtures
never talk to Terminal.app — every test in `test/focus.test.js` up to that point ran against
strings, not the real app. The fix is `toDeviceTty`, the literal inverse of `normaliseTty`,
called at the one point `buildFocusTabScript` emits the clause — plus, the part that
actually matters, a test that asserts the *emitted script text* contains `/dev/ttys000` and
not bare `ttys000` (`buildFocusTabScript`'s tests in `test/focus.test.js`). That guard was
mutation-tested by hand: reintroducing the bug (interpolating the canonical form instead of
`toDeviceTty`'s output) makes it fail; restoring the fix makes it pass again. The general
lesson, worth carrying into anything else that crosses into another program's namespace
(AppleScript, a shell, another process's config format): **canonicalising a value on the way
in is only half the job — the outbound spelling, at the point it crosses back out, needs its
own test, because a read-only check of the same value proves nothing about how it matches.**

**The Terminal.app focus path used to be two `osascript` calls; it's one now.** The first
version listed every window's tabs and their ttys with one `osascript` call, matched the
tty in TypeScript, then ran a second `osascript` call to select the winning tab.
`buildFindAndFocusTabScript` collapses that into a single script: it iterates `windows`
itself, wraps the `first tab of w whose tty is …` lookup in a `try` per window (that
expression raises when a window has no matching tab, so without the `try` the first
non-owning window would abort the whole `repeat` before later windows got checked), and
returns an `"ok"`/`"nomatch"` sentinel string rather than relying on an exit code — which is
what lets a genuine "no such tty" be told apart from a thrown or timed-out `osascript` call
in `focusSession`. Measured medians on this machine, 4–5 runs each:

| path | before (two calls) | after (one call) |
| --- | --- | --- |
| Terminal.app | 183 ms | **117 ms** |
| VS Code | 81 ms | 79 ms (unchanged, as expected — VS Code never took the Terminal-specific path) |

Worth stating honestly rather than rounding up: a bare single-script benchmark run in
isolation suggested ~91 ms, but the real path measures ~117 ms, because it iterates however
many Terminal windows happen to be open at the time — a real 68 ms win, not the ~90 ms a
one-off timing would have predicted. `parseTerminalTabs` and `matchWindow` — the
TypeScript-side list/match pair the old two-call flow used — were deleted along with their
tests once the match moved into AppleScript: nothing outside `focus.ts` imported them, and
once the match lives in the script they had no caller left in the file either. Worth keeping
as a general principle: **code kept alive only because it still has tests is worse than code
deleted** — exported, fixture-tested, and called by nothing is not a safety net, it's a trap
for the next person who assumes a tested function must still be load-bearing.

**`comm` and `ucomm` are both correct — for different processes — and using the wrong one
for a given lookup fails silently.** Measured side by side on this machine:

```
pid    comm=                                               ucomm=
4477   claude                                              2.1.229
63004  claude                                              2.1.233
1885   /Applications/Visual Studio Code.app/…/Code         Code
82641  /System/Applications/Utilities/Terminal.app/…       Terminal
```

`comm` is argv[0]: bare for the `claude` CLI shim, a full bundle-relative path for a GUI
app. `ucomm` is the kernel's `p_comm`, the executable's own basename — which is why the CLI
reports its *version* under `ucomm` rather than its name: the binary actually lives at
`~/.local/share/claude/versions/<version>`, and `p_comm` reports that version-numbered
directory entry's name. Consequence: `sessions.ts`'s liveness check correctly matches
`comm === "claude"` (see the Claude Sessions gotchas above), while `focus.ts`'s ancestry walk
matches the **basename of `comm`**, not `ucomm`. Neither rule generalises to the other. This
is worth stating explicitly, not just fixing quietly, because two modules in the same repo
keying off different `ps` fields looks like an inconsistency — a bug someone "fixes" by
making them match — right up until you know why they can't.

**`ucomm` is truncated to 16 characters — measured, not assumed from a man page.** A real
`Claude Helper (Renderer)` process on this machine reports `ucomm` exactly
`"Claude Helper (R"`, cut mid-word. That's why `parseAncestry` in `focus.ts` matches on
`basename(comm)` instead of `ucomm`: `comm` has no length limit. An owner app whose
executable basename happened to reach 16 characters would, under a `ucomm` match, silently
never match and the key would report `no-owner` — indistinguishable from "this isn't a
terminal I recognise." `test/focus.test.js` pins this down with a synthetic 22-character
owner name and an overridable `ownerNames` table, so the test proves the *algorithm* has no
length limit independent of what's actually in the shipped `OWNER_APP_NAMES`.

**Verified live, both host types, after the tty fix:**

```
Terminal.app  pid 63004 -> {"ok":true,"precision":"tab"}
VS Code       pid 32893 -> {"ok":true,"precision":"app"}
```

Terminal can be steered to the exact tab because it exposes `tty` per tab in its own
AppleScript object model. VS Code and Cursor cannot: macOS exposes no way to select a
specific pane within another app's window, the same ceiling `terminal.ts` already documents
for typing into an editor's integrated terminal rather than a real one. `sessions.ts`
reports `RAISED / app only` for that case rather than `FOCUSED`, deliberately not claiming a
precision the press didn't achieve. Two of the three live sessions used to verify this ran
inside VS Code's integrated terminal and one in Terminal.app, which is why both code paths
needed to exist rather than just the tab-precise one.

**Unverified: iTerm2, Ghostty, WezTerm, kitty, Alacritty, Warp.** None of these terminals
are installed on this machine, so their entries in `OWNER_APP_NAMES` are guesses at the
executable's `comm` basename, not measurements — flagged as such in the doc comment on that
table in `focus.ts`. A wrong guess fails safe: the ancestry walk simply never matches that
entry, `parseAncestry` returns `null`, and the key reports `no-owner` rather than activating
the wrong app. Worth confirming on one of those terminals before trusting the face for it.

**The SDK gesture surface, so this doesn't get re-researched.** Stream Deck keys only ever
deliver `keyDown` and `keyUp` — checked directly against the installed `@elgato/streamdeck`
1.4.1 type definitions, which carry no `duration`, `elapsed`, or `timestamp` field on either
event. A hold has to be timed in the plugin process itself; there's no signal from the SDK
to read it off of. Richer gestures exist only on Stream Deck + hardware (the `Encoder`
controller type): `onDialRotate` carries `ticks`, and `onTouchTap` carries a native `hold`
boolean — the one place Elgato hands you a hold for free, and only on a device with dials.
Neither of this machine's two devices is a Stream Deck +, so `press.ts`'s `PressTracker`
exists because there's no cheaper option, not because a built-in one was overlooked.

**`PressTracker` takes an injected timer, specifically so its tests never sleep.**
`setTimer`/`clearTimer` default to real `setTimeout`/`clearTimeout` but are overridable
constructor options; `test/press.test.js` passes a fake scheduler that records
`(fn, ms)` pairs and only invokes `fn` when the test calls `fire(handle)` itself, so a test
asserting "the hold fires at the threshold" runs in under a millisecond instead of racing a
real 300ms timer. The same shape `UsageStore` and the peek/flash timers elsewhere in this
repo could use if their own tests ever start feeling slow.

**The hold threshold is resolved per press, not once at construction, specifically so a
settings change can't corrupt a hold already in flight.** `PressTracker.down(id,
thresholdMs?)` takes an optional per-call override; `resolveThreshold` clamps it to
`[200, 2000]` and falls back to the 300ms default on anything non-finite (`NaN`, `Infinity`,
a missing or corrupted setting) — the same defensive posture `thresholdsFrom` in `view.ts`
already takes toward a bad slider value. `SessionsKey` reads each key's own `longPressMs`
setting and threads it through `down()` on every press rather than rebuilding the tracker
(and losing any hold in progress) when a setting changes; a construction-time-only threshold
would have forced that rebuild, which is why the old design was a single hard-coded value
shared by every key. Resolving fresh on each `down()` means a timer already scheduled keeps
the delay it was given — only the *next* press sees a changed setting.

The 200ms floor is not an arbitrary round number: it encodes an asymmetry between the two
ways this gesture can fail. A hold misread as a tap only shows the peek — a false negative
that costs nothing. A tap misread as a hold yanks a terminal window to the front of whatever
the user was doing — a false positive with a real cost. That asymmetry is why the range
floors at 200ms rather than letting the property inspector go lower: below roughly 150ms
ordinary taps start clearing the threshold themselves.

**Double tap was considered for this gesture and rejected.** Detecting a double tap means
waiting out the double-tap window on *every* press before deciding it wasn't one, which
would add a delay (on the order of 300ms) to the common case — a single short press — on a
key whose entire job is showing you something instantly. A hold costs the short press
nothing: `onLong` only ever fires from a timer that a normal tap's `keyUp` cancels well
before it would elapse, so a quick press pays no penalty for the gesture existing.

**`onLong` fires at the threshold while the key is still held, not on release.** Firing only
once the user lets go would make a hold feel broken — nothing happens until you release,
which defeats the point of acting on a hold rather than waiting for it to end. This is also
why the short-press action lives in `onKeyUp`, gated on `press.up(id) !== "long"`: by the
time `keyUp` fires for a press that already went long, `handleLongPress` has already taken
the key's face for its own flash, and running the peek too would either fight it for the
screen or make the release look like a second, unrelated press once the flash reverts.

**A long-press timer must be cancelled on `onWillDisappear`, same hazard the existing peek
and flash timers in `sessions.ts` already document.** A timer that fires after the key is
gone would call `handleLongPress` on an action that's no longer there. `SessionsKey.
onWillDisappear` calls `this.press.cancel(id)` alongside clearing the peek and flash timers
for the same reason.

**The four long-press confirmations flash the whole key in colour now, not a centred text
card, because the user's finger is on the key when the confirmation appears.** The old
centred card put its only ink — the title and subtitle — dead in the middle of the key,
which is exactly where a finger still holding the key down covers it; the confirmation
fired and the user saw nothing. `MessageView` gained an optional `fill?: boolean` and a
fourth tone, `"ok"` (the existing `"neutral"`/`"warn"`/`"crit"` trio had no success colour
to reach for); `frame()` in `render.ts` takes an optional background colour so a filled face
reuses the identical `rx=20` silhouette the normal face already draws, rather than an inset
card floating inside it — the corners are exactly the part still visible around a covering
finger, so the fill has to be pixel-identical geometry, not a smaller shape. Unfilled faces
are untouched; `test/view.test.js`'s "MessageView fill flag" suite pins the six pre-existing
message faces as byte-identical SVG output to guard against a fill change leaking into the
normal path.

Colour choice is deliberate, not just "pick four things that look different": green for
`FOCUSED` and `RAISED / app only` (both count as success — the tab-vs-app precision
distinction lives in the subtitle text instead of a second colour, since a fifth colour
bucket to memorise wasn't worth it for a distinction the subtitle already makes), amber for
`EMPTY / no session`, red for `FAILED / see logs`. Verified by rendering each fill face at
the real 72×72 key size with a disc covering the middle ~60% of it — standing in for a
fingertip — and confirming the remaining ring reads unambiguously by colour alone with no
text legible. `fill` lives on `MessageView` itself rather than being special-cased inside
`sessions.ts`'s rendering, specifically so the launch keys' own `SENT`/`FAILED` flashes
(which have the identical finger-occlusion problem) can adopt it later with no new render
code — `renderMessage` already handles both paths.
