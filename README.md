# AI Usage — Stream Deck plugin

Puts Claude and Codex subscription usage on a key: the rolling 5-hour session window, the
7-day cap, how long until the next reset, and a colour that goes amber then red as you
close in on a limit. Two independent meters — Claude Usage and Codex Usage — plus a
launch key for each. A fifth action, Claude Sessions, reports what your other Claude Code
sessions are doing right now rather than a usage number — see its own section below. Five
actions in total. The plugin was originally Claude-only (hence the repo and package name);
the manifest's `Name` and `Category` are now "AI Usage" to match.

Press a meter key to peek at exactly when each window resets — it shows for a few
seconds, then reverts. Which window(s) the key shows the rest of the time — both, just
the 5-hour one, or just the weekly one — is set from the key's property inspector.

## Install

Double-click `com.devbloom.ai-usage.streamDeckPlugin`. Stream Deck will ask you to
confirm; the plugin then appears under an "AI Usage" category in the actions list on the
right, with five actions to drag onto keys: Claude Usage, Launch Claude, Codex Usage,
Launch Codex, Claude Sessions.

Requires macOS 12 or newer, Stream Deck software 6.5 or newer, and — for whichever
provider's keys you use — that provider signed in at least once on this machine: `claude`
for the Claude actions, and for the Codex ones, Codex signed in from inside the ChatGPT
desktop app (the standalone `codex` CLI also works, if you have it installed — see
"Codex credentials" below). You don't need both; a Codex key works with no Claude Code
install present, and vice versa.

The first time the plugin reads your Claude credentials, macOS shows a keychain
authorisation dialog. Choose **Always Allow**. You may be asked again occasionally,
because Claude Code rewrites that keychain item whenever it rotates its token, which can
reset the permission. Codex credentials come from a plaintext file instead (see below),
so there is no keychain dialog for the Codex keys.

## Where the numbers come from

The two providers get their numbers in opposite ways, and the contrast is the most
interesting thing about how this plugin works: one polls for free, the other has to pay
for every reading.

### Claude: no usage endpoint, so probe and throw away the answer

There is no public endpoint that reports subscription limits, but every response from
Anthropic's Messages API carries them in headers:

```
anthropic-ratelimit-unified-5h-utilization    0.14        fraction, not a percentage
anthropic-ratelimit-unified-5h-reset          1786152600  unix seconds, not ISO-8601
anthropic-ratelimit-unified-5h-status         allowed
anthropic-ratelimit-unified-7d-utilization    0.9
anthropic-ratelimit-unified-7d-reset          1786492800
anthropic-ratelimit-unified-7d-status         allowed_warning
anthropic-ratelimit-unified-representative-claim  seven_day
```

Those are real observed values, not a guess at the format. The resets arrive as **unix
seconds** — `parseReset` tries ISO-8601 first, gets `Invalid Date`, and falls through to
the seconds branch, so the ISO path never actually fires in practice.

So the plugin sends the smallest legal request it can (one character in, one token out),
throws the completion away, and keeps the headers. It authenticates with the OAuth token
Claude Code has already stored in your keychain, so there is nothing to configure.

Two consequences worth knowing about. The probe costs a negligible but non-zero slice of
quota. And it counts as activity, which means polling around the clock will keep a 5-hour
window nominally open even when you are not working. Polling therefore stops whenever no
key is on screen, and the interval is adjustable in the key's settings — 5 minutes is
plenty for the weekly number if the default minute feels eager.

### Codex: a dedicated, free, read-only usage endpoint

Codex has what Claude doesn't: `GET https://chatgpt.com/backend-api/codex/usage` reports
subscription usage directly, so there is no throwaway request to make and nothing of
yours to spend. The Codex meter's polling interval doesn't touch your quota or your
session window at any frequency — the property inspector for the Claude meter carries a
warning about that trade-off; the Codex one deliberately doesn't repeat it, because for
Codex it isn't true.

That endpoint came with its own traps, found by measuring rather than guessing:

- The two windows in the response are named `primary_window` and `secondary_window`, and
  on this account `primary_window` turned out to be the **weekly** one (`limit_window_seconds:
  604800`), not the 5-hour one the name suggests — independently confirmed by the
  `x-codex-primary-window-minutes: 10080` header on a different endpoint. Trusting the slot
  name would silently swap the 5-hour and weekly numbers on screen, so the plugin classifies
  each window by its duration instead (≤6h is the session window, ≥24h is weekly) and never
  by which slot it arrived in.
- `used_percent` is already on a 0–100 scale, unlike Anthropic's 0–1 fraction for the same
  concept. The two providers' raw payloads are not swappable through the same math.
- `secondary_window` was `null` throughout testing on this ChatGPT Plus account, including
  immediately after a request — which is exactly why it wasn't trusted at first. Every one
  of those readings was also at 0% usage, and at 0% a dormant window and a nonexistent one
  produce the identical null. That's resolved now, three ways. A real `codex exec` run was
  made that actually spent tokens (4,069 of them), and the endpoint was re-read immediately
  after: `secondary_window` was still `null`, and `primary_window` was still the 7-day one.
  Separately, the responses endpoint sends `x-codex-secondary-window-minutes: 0` alongside
  `x-codex-primary-window-minutes: 10080`. And the ChatGPT app's own "Usage remaining" menu
  shows a single `Weekly 100% Aug 21` row and no 5-hour row at all — OpenAI's own UI,
  independent of anything this plugin reads, agreeing down to the reset date. **Codex on a
  ChatGPT Plus plan has no 5-hour window; it limits weekly only.** That's measured on this
  one plan, not asserted for every Codex plan or promised to stay true — the plugin still
  classifies windows by duration and still renders an unreported window as `—` with no bar,
  so a 5-hour window showing up on some other plan needs no code change to display.

  It also removed a choice. `Provider` carries `defaultMode` (`"both"` for Claude,
  `"weekly"` for Codex) and `supportedModes` (all three for Claude, weekly alone for
  Codex), and `ui/codex-meter.html` has **no window selector at all** — on a provider that
  reports one window, offering the other two faces could only ever draw an em dash where a
  number belongs. `supportedModes` is enforced in `meter.ts` as well as in the panel,
  because Stream Deck persists per-key settings: a Codex key that saved `mode: "both"`
  before this was understood would otherwise keep rendering a dead row forever, with
  nothing to ever clear it. A Claude key's saved mode still wins over its default.

There is also a transport-level trap that has nothing to do with the payload shape:
Node's built-in `fetch` cannot reach this endpoint at all. Cloudflare fronts it and
rejects `fetch`'s underlying HTTP client (undici) with a 403 no matter how valid the
token is — measured back to back on this machine, 0/6 successful with `fetch` against 6/6
with `node:https`, identical credentials and headers both times. The plugin talks to this
endpoint over `node:https` for exactly that reason, plus an explicit non-default
`User-Agent` header, which is required independently — a missing one 403s on its own even
over `node:https`. Neither of those was optional; both together are what gets a 200.

### Codex credentials

Codex credentials come from `~/.codex/auth.json`, a plaintext file — not the keychain, so
there is no macOS authorisation dialog for these keys. Codex now ships inside the ChatGPT
desktop app, and that's what writes and owns this file day to day; the standalone `codex`
CLI writes the same file and works too, if you have it installed. Either way, you
authenticate by signing in to Codex — from inside the ChatGPT app, or via `codex` — not
through this plugin, which only ever reads the file, for the same reason as the Claude
keychain read below: it's Codex's file, and a lost write race would sign you out of Codex
itself, not just dim this key.

## The one deliberate limitation

The plugin only ever *reads* credentials, for both providers. It never writes to the
keychain, and it never writes to `~/.codex/auth.json`.

### Claude

That matters because Claude Code owns that record. If this plugin renewed the token and
Anthropic rotated the refresh token in the process, the copy Claude Code has on disk would
be dead and you would have to sign into the CLI again. A key that briefly reads `EXPIRED`
is a much smaller problem than a CLI that has logged you out.

In practice the stored token is refreshed every time you run Claude Code, so the key
recovers on its own. If you would rather it never went stale, there is an
**Auto-renew expired token** checkbox in the key's settings — off by default, with that
trade-off spelled out next to it.

### Codex

The Codex meter has no equivalent checkbox, by choice rather than by omission. Claude's
opt-in refresh works because Claude Code's OAuth client id is publicly known; no
equivalent id for the Codex CLI could be verified, and shipping a guessed one — and
minting tokens against it — is worse than the failure it would prevent. So the Codex
provider accepts the same `allowRefresh` setting the Claude one does, and ignores it.

This costs little in practice. A Codex access token lasts roughly 10 days — measured
directly from a real token's `iat`/`exp` claims, not a guess — so a `STALE` (now `EXPIRED`)
Codex key is rare to begin with. The Codex CLI is known to refresh its own stored token on
every launch, so a `codex` invocation clears it if the CLI is installed. Whether opening
the ChatGPT app on its own refreshes the same file has not been verified — the app owns
the file and is the thing to try first, but if the key is still `EXPIRED` afterwards,
sign out and back in to Codex inside the app.

## Key states

| Key shows | Meaning |
| --- | --- |
| Two bars, `5H` and `7D` | Normal. Set the mode in the property inspector. |
| A ring gauge | Single-window mode, set in the property inspector. |
| `RESETS IN` + countdown | Temporary peek. Press the key; it reverts after four seconds. Shows only the window(s) the key itself shows. |
| `FULL IN 8h` | Burn-rate projection: at the current pace this window fills before it resets. |
| `+50% ENDS 12d` | The temporary weekly-limit boost expires soon. Weekly peek only. See below — the notice is a plain calendar check, so it can appear on either meter's weekly peek, not just Claude's. |
| `SIGN IN` | No credentials for that key's provider on this machine. Subtitle names the fix — `run claude` for Claude, `open ChatGPT` for Codex. |
| `EXPIRED` | Credentials found but the token has aged out. Subtitle again names the right fix. |
| `API KEY` / `no limits` | Codex only. Signed in with a bare `OPENAI_API_KEY` rather than a ChatGPT login, which has no subscription limits to report — nothing to fix, this key just has nothing to show. |
| `BLOCKED` / `403` | The usage endpoint's own edge network rejected the request. Not a credentials problem — signing in again won't fix it. |
| `OFFLINE` / `no network` | DNS failure, connection refused/reset, or a timed-out request — this machine's network, not the plugin or your credentials. |
| `ERROR` | Everything else — a genuine, unclassified network or API problem. Check the logs; see "Logs and the failure taxonomy" below. |

### Colour, and who decides it

The warn/critical sliders in the property inspector are not the whole story. Every
response also carries Anthropic's own view of each window — `allowed`, `allowed_warning`
and so on — and the key takes **whichever of the two is more severe**. Your sliders can
warn you earlier than Anthropic would; Anthropic can escalate a key your sliders would
call fine. Neither source can make the key less alarming than the other thinks it should
be.

### The projection

The store keeps recent readings and works out points-per-hour from the oldest and newest.
If that pace fills the window *before* it resets, the peek says so. Two deliberate
silences: it needs at least two minutes between readings, because closer samples give a
slope that swings wildly on every tick; and a flat or falling rate produces nothing at
all, since both windows are rolling and decay is the normal healthy case, not news.

Because it needs history, nothing appears for the first couple of poll intervals after the
plugin restarts.

### The August 19 notice

Anthropic is running a promotion that raises weekly limits by 50%, ending 2026-08-19.
`src/lib/promo.ts` hardcodes that date because nothing in the API reports it. The notice
appears on the weekly peek within 14 days of expiry, self-disables afterwards, and that
whole file can be deleted once the date passes. It is a plain calendar check with no
provider distinction in it, so as written it can surface on the Codex meter's weekly peek
too, even though the promotion it describes is Anthropic's.

A transient failure keeps the last good numbers on screen rather than blanking the key,
so a dropped packet does not interrupt you mid-glance.

### Logs and the failure taxonomy

Logs live in `~/Library/Application Support/com.elgato.StreamDeck/Plugins/com.devbloom.ai-usage.sdPlugin/logs/`.
Every failure that reaches a key — `signed-out`, `stale`, `no-plan`, `blocked`, `offline`,
or `error` — is written there with its full message, tagged with which provider it came
from since both meters now share one log file. A failure that repeats every poll is
written once, not once per 60-second tick, and re-arms the next time it actually changes
or clears (see `UsageStore.onFailure` in `src/lib/store.ts`). `ERROR` is deliberately the
only card that still says "see logs" — every other card already says what's wrong on its
own face, so there's nothing further to look up.

## Launch Claude and Launch Codex

Two more keys, **Launch Claude** and **Launch Codex**, type a command into whichever
terminal you currently have focused. Before either types anything, it checks what app is
actually frontmost and refuses unless that app is a real terminal it can address (Terminal,
iTerm, Ghostty, WezTerm, kitty, Alacritty, or Warp). Pressing either key with, say, Slack or
a browser focused shows `NOT A TERMINAL` and does nothing else.

**Launch Claude** defaults to `claude --dangerously-skip-permissions`, starting a Claude Code
session with permission checks off. **Launch Codex** defaults to the bare `codex` — no
permission-bypass flag, even though one now exists and is verified:
`--dangerously-bypass-approvals-and-sandbox`, read from `--help` on the Codex CLI bundled
inside the ChatGPT app (`codex-cli 0.147.0-alpha.6.5`; there is no `--yolo` alias in that
build). The default stays plain `codex` regardless — shipping a permission-bypass flag as
the *default* risks silently disabling sandboxing for anyone who never opens the property
inspector, verified or not. Add the flag yourself in the key's settings if you want it.

That default only works if a `codex` CLI is on your shell's `PATH`, and getting it there
took three separate fixes on the machine this was built on — worth reading before you
conclude the key is broken:

- **`node` wasn't on `PATH` at all.** `~/.zshrc` loaded nvm correctly, but nvm's default
  pointed at an uninstalled version (`default -> lts/jod (-> N/A)`), so nvm selected
  nothing and the CLI's `#!/usr/bin/env node` shim died with
  `env: node: No such file or directory`. Fixed with `nvm alias default 24`.
- **A `bun`-installed copy shadowed everything.** `~/.bun/bin` precedes the nvm bin on
  `PATH`, and `bun`'s global `@openai/codex` 0.77.0 had an *empty* vendored binary
  directory, so `codex` resolved to a shim with nothing behind it and `npm i -g` appeared
  to do nothing. Fixed with `bun remove -g @openai/codex`.
- **A corrupt `~/.codex/config.toml`** stopped every binary from starting; see the config
  gotcha in `DEVELOPMENT.md`.

With those three sorted, `codex` resolves to the npm install (`codex-cli 0.147.0`, which
no longer uses a `vendor/` directory at all) and the bare default works. If you'd rather
not install anything, a working Codex binary already ships inside the ChatGPT app at
`/Applications/ChatGPT.app/Contents/Resources/codex` — point the key's Command field at
that full path instead. It's a path into an app bundle, so it can move on a major
ChatGPT.app update.

VS Code and Cursor are opt-in via a checkbox in the key's settings, off by default, for both
launch keys. macOS can tell you which *app* is frontmost but not which *view within it* has
focus, so there is no way to distinguish the integrated terminal panel from an open source
file — turning this on means a press can just as easily type a shell command into whatever
file you were last editing.

The command, whether it runs immediately or only gets typed (leaving you to press Enter
yourself), and the VS Code/Cursor opt-in are all set from each key's own property inspector.

The first press asks macOS for permission — Automation for Terminal and iTerm, since they are
driven through their own scripting API, or Accessibility for everything else, since those are
driven by synthetic keystrokes. Accept the system prompt; each app only asks once, shared
across both launch keys.

## Claude Sessions

A fifth key, **Claude Sessions**, reports what your *other* Claude Code sessions are doing
right now: how many are waiting for input, how many are actively processing, and how many
are idle. Press it to see which sessions specifically, and why.

Only top-level interactive sessions are counted. A session's subagents roll up into their
parent for free — subagents don't register their own entries in the source this key reads,
confirmed by running three subagents under one terminal and finding one registry entry, not
four.

### Where the numbers come from

Claude Code maintains an undocumented live registry at `~/.claude/sessions/<pid>.json`, one
file per running top-level session, written on every status transition and removed on clean
exit. Each file carries a `status` — `busy`, `idle`, `waiting`, or `shell` — and, once a
session is waiting, a `waitingFor` reason (`"input needed"`, `"permission prompt"`,
`"dialog open"`, `"sandbox request"`, `"worker request"`). This key exists because those
states are **read** straight out of the registry, never inferred. Parsing the whole
directory measured 0.45 ms.

The plugin deliberately never reads the `.jsonl` conversation transcripts to work out
session state, even though that sounds like a reasonable fallback. Measured directly, it's
actively misleading: a blocked permission prompt writes nothing at all to the transcript, so
a transcript-based version would report a session stuck waiting on you as idle — the one
case this key most needs to get right — and a `turn_duration` line can appear even when a
queued prompt just continued straight into its next turn, which would report a session still
working as finished. The registry's own `status` field has neither problem, which is the
whole reason to read it instead.

A second source, `ps`, corroborates rather than replaces the registry: it confirms a
registry pid is still a live `claude` process rather than a stale leftover file, and it
catches the registry directory itself disappearing or changing shape out from under this
feature — something that would otherwise read as a silent, permanent "0 sessions,"
indistinguishable from nothing actually running. See `DEVELOPMENT.md` for a specific,
measured trap in how that liveness check has to be done.

### Faces

| Key shows | Meaning |
| --- | --- |
| `WAIT` / `RUN` / `IDLE`, three rows | Normal, mode "All three" (the default). Counts of your top-level Claude Code sessions right now. Three grey zeros means nothing is running — that's a measurement, not a gap, so it isn't shown as an em dash. |
| One large number over `WAITING` / `RUNNING` / `IDLE` | Normal, mode pinned to a single bucket. Same sizing as the usage meter's single-window gauge face. A count of zero still draws in grey rather than that bucket's colour, and still draws as a literal `0`, never an em dash — zero is a measurement here too. |
| `?` / `UNKNOWN STATUS` | At least one session reported a status this build doesn't recognise (e.g. a future CLI status this plugin predates). Replaces the counts or the single-bucket number rather than sitting beside it — see below. |
| `?` / `NO REGISTRY` | Live `claude` processes exist but none match a registry entry — the registry may have moved or changed shape. Only shown after two consecutive polls agree, so a session that just started and hasn't written its file yet can't trigger it. |
| `?` / `UNREADABLE` | A registry file failed to parse across two consecutive polls. Check the logs. |
| Ranked list + footer | Peek. Press the key: up to three sessions (label, and why if waiting) plus a one-line footer, for 4 seconds before it reverts. Follows whichever bucket the key is pinned to — "Waiting only" peeks only waiting sessions, and says "no waiting sessions" rather than listing anything else if there are none. On the unknown-status face, the peek substitutes the raw unrecognised status strings instead and ignores the bucket filter, since an unrecognised status was never sorted into waiting/running/idle in the first place — there's nothing for the filter to match against. |

An unrecognised status gets its own bucket rather than being folded into `IDLE` or dropped
silently: the other counts might still be right, but the key can no longer claim
completeness, and "3 IDLE" sitting next to a small badge would read as "3 idle, full stop."
It's one line to revert if this proves noisy in practice.

### Hold to focus

Holding the key (300ms by default, adjustable — see the property inspector below) brings
the terminal window of the first matching session to the front — the same session a peek
would list first: with "All three" selected, the first session overall (waiting before
running before idle); with one bucket selected, that bucket's first session. A short press
still peeks, unchanged; a hold never also triggers the peek.

The confirmation flashes the whole key in colour rather than showing centred text, because
your finger is still on the key when it appears — a centred card is exactly the part a
finger covers. Green means the focus succeeded (`FOCUSED` and `RAISED / app only` both —
the tab-vs-app distinction lives in the subtitle, not a second colour), amber means nothing
was there to focus, red means the attempt itself failed. The three are chosen to be
separable peripherally, glance-and-go, with no text legible under a finger.

| Key flashes | Meaning |
| --- | --- |
| `FOCUSED` | Terminal.app only. The exact tab was matched by tty and brought forward. |
| `RAISED` / `app only` | VS Code or Cursor. Only the app itself came forward — macOS exposes no way to select a specific pane inside another app's window, the same ceiling `terminal.ts` already documents for Launch Claude/Launch Codex typing into an editor. This face deliberately doesn't claim a precision the press didn't achieve. |
| `EMPTY` / `no session` | Nothing in the relevant bucket to focus — a hold that appeared to do nothing would be indistinguishable from a broken gesture, so an empty result still gets a face. |
| `FAILED` / `see logs` | The focus attempt itself failed (the session's process exited between the hold firing and the lookup running, `ps`/`osascript` timed out, or similar). Check the logs. |

The gesture exists because the Stream Deck SDK gives keys only `keyDown` and `keyUp`, with
no timing in either payload, so the plugin times the hold itself; richer gestures
(a native `hold` boolean, dial ticks) exist only on Stream Deck + hardware, which neither
of this repo's target devices is.

### The property inspector

Claude Sessions has two settings: **Show**, a dropdown offering *All three*, *Waiting
only*, *Running only*, or *Idle only*, defaulting to all three; and **Hold to focus**, a
slider from 200ms to 1000ms in 50ms steps, defaulting to 300ms, controlling how long a
press must be held before it counts as a hold rather than a tap.

Picking a single bucket in **Show** switches the key from the three-row counts face to a
single large number over that bucket's name, and narrows what pressing the key peeks at to
that bucket alone.

This setting is deliberately weaker than it looks: **the problem faces outrank it in
every mode.** A key pinned to "Idle only" still shows `UNKNOWN STATUS`, `NO REGISTRY`, or
`UNREADABLE` in full when one of those occurs — verified directly across all three problem
states and all four modes. The Show dropdown is a display preference over data the key
already trusts; it must never be able to hide the fact that the data isn't trustworthy.
The one deliberate exception is the peek on the unknown-status face, which always shows the
raw unrecognised statuses regardless of the selected bucket, for the reason given in the
Faces table above.

An unset or unrecognised mode — a key that predates this setting, or a hand-edited
settings blob — falls back to "All three," the same defensive posture the usage meters'
`thresholdsFrom` already takes toward a nonsense slider value rather than trusting it and
rendering a broken face.

**Hold to focus** trades snappiness against false holds: a shorter setting makes the
gesture feel quicker to trigger, but push it too low and an ordinary tap starts reading as
a hold, which pulls a window to the front instead of just peeking — the two mistakes don't
cost the same, so the slider floors at 200ms rather than going lower. Values are clamped to
200–2000ms regardless of what's actually in a key's saved settings; a non-finite or missing
value falls back to the 300ms default, the same defensive posture as the Show dropdown
above. The threshold is resolved fresh on every press rather than once when the plugin
starts, so changing this slider mid-hold can't corrupt a press already in progress — only
the next one sees the new value.

For a long time this key had *no* settings at all, which was itself a deliberate choice
rather than an oversight — there was nothing to configure when the only thing to show was
three counts. That stopped being true the moment a way to pin the key to one bucket became
worth having, and again when the hold duration became worth adjusting; the omission was
correct for as long as it was correct, and no longer.

## Building from source

For the live-reload development loop — edit, save, watch the key update without
re-installing — see [DEVELOPMENT.md](DEVELOPMENT.md), or just run `./scripts/dev-setup.sh`.


```bash
npm install
npm run build      # bundle into com.devbloom.ai-usage.sdPlugin/bin/
npm test           # unit tests over parsing, thresholds, rendering, the Codex transport guard, and the sessions source guards
npm run test:ui    # drives the settings panel in headless Chromium — Claude meter panel only
npm run preview    # render every key state to /tmp/preview
npm run pack       # produce the .streamDeckPlugin installer
```

The settings panel bundles its own copy of [sdpi-components](https://sdpi-components.dev)
at `ui/sdpi-components.js` rather than loading it from the CDN, so the panel still opens
with no internet and cannot change underneath the plugin.

`npm run watch` rebuilds and restarts the plugin in Stream Deck as you edit. It needs
Node 24+ and the Elgato CLI (`npm install -g @elgato/cli`), plus a one-time
`streamdeck link com.devbloom.ai-usage.sdPlugin` to register the development copy.

`python3 scripts/icons.py` regenerates the two original Claude icons, but it's dead —
it needs `cairosvg`, which has never been installed on this machine. The Codex icons are
generated a different way: `npm run icons:codex` (`scripts/gen-codex-icons.mjs`)
screenshots the SVG in headless Chromium via Playwright, the same technique
`scripts/shoot-pi.mjs` already used for property-inspector screenshots. Preview every key
state without a device attached using
`npx tsc --outDir .build && node scripts/preview.mjs /tmp/preview`.

### Layout

```
src/lib/credentials.ts        read the Claude OAuth token from keychain or ~/.claude/.credentials.json
src/lib/usage.ts              probe the Messages API, parse the rate-limit headers
src/lib/providers/index.ts    the Provider seam: { id, label, signInHint, fetchUsage, invalidateCredentialCache, pollCostsQuota }
src/lib/providers/claude.ts   Claude provider — wraps credentials.ts + usage.ts behind the seam
src/lib/providers/codex.ts    Codex provider — reads ~/.codex/auth.json, calls the usage endpoint over node:https
src/lib/store.ts              UsageStore class; one shared poller per provider (claudeStore, codexStore)
src/lib/render.ts             SVG key faces — bars, ring gauge, message cards
src/lib/view.ts               store state + settings → what to draw
src/lib/terminal.ts           frontmost-app classification + AppleScript building for both launch keys
src/lib/sessions.ts           ~/.claude/sessions registry parsing + ps corroboration, pure functions on top
src/lib/sessions-store.ts     SessionsStore — one shared 3s poller behind every Claude Sessions key
src/lib/press.ts              PressTracker — short-vs-long-press gesture, timer injectable for tests
src/lib/focus.ts              focusSession(pid) — bring a session's terminal window to the front
src/actions/meter.ts          UsageMeterBase + UsageMeter (Claude) + CodexUsageMeter subclasses
src/actions/launch.ts         LaunchBase + LaunchClaude + LaunchCodex subclasses
src/actions/sessions.ts       SessionsKey — counts/focus/problem/peek faces, ui/sessions.html for the bucket filter
```

## Adapting it

The pieces most likely to need changing:

- **Colours and thresholds** — `SEVERITY_COLOURS` and `DEFAULT_THRESHOLDS` in `src/lib/format.ts`.
- **Layout** — `src/lib/render.ts` draws into a 144×144 viewBox. `scripts/preview.mjs`
  renders every state to a folder so you can iterate without touching hardware.
- **Stream Deck +** — add `"Encoder"` to `Controllers` in the manifest, give the action an
  `onDialRotate` handler, and add a second render path for the 200×100 touchscreen strip.
- **A third provider** — implement `Provider` in `src/lib/providers/`, add a `UsageStore`
  for it in `store.ts`, and add a subclass each to `meter.ts` and `launch.ts`. Remember the
  manifest change needs a full Stream Deck restart, not just a rebuild (see DEVELOPMENT.md).
