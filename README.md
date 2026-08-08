# Claude Usage — Stream Deck plugin

Puts your Claude usage on a key: the rolling 5-hour session window, the 7-day cap,
how long until the next reset, and a colour that goes amber then red as you close in
on a limit.

Press the key to peek at exactly when each window resets — it shows for a few seconds,
then reverts. Which window(s) the key shows the rest of the time — both, just the 5-hour
one, or just the weekly one — is set from the key's property inspector.

## Install

Double-click `com.alejo.claude-usage.streamDeckPlugin`. Stream Deck will ask you to
confirm; the plugin then appears under a "Claude Usage" category in the actions list on
the right. Drag it onto a key.

Requires macOS 12 or newer, Stream Deck software 6.5 or newer, and Claude Code signed in
at least once on this machine.

The first time the plugin reads your credentials, macOS shows a keychain authorisation
dialog. Choose **Always Allow**. You may be asked again occasionally, because Claude Code
rewrites that keychain item whenever it rotates its token, which can reset the permission.

## Where the numbers come from

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

## The one deliberate limitation

The plugin only ever *reads* credentials. It never writes to the keychain.

That matters because Claude Code owns that record. If this plugin renewed the token and
Anthropic rotated the refresh token in the process, the copy Claude Code has on disk would
be dead and you would have to sign into the CLI again. A key that briefly reads `EXPIRED`
is a much smaller problem than a CLI that has logged you out.

In practice the stored token is refreshed every time you run Claude Code, so the key
recovers on its own. If you would rather it never went stale, there is an
**Auto-renew expired token** checkbox in the key's settings — off by default, with that
trade-off spelled out next to it.

## Key states

| Key shows | Meaning |
| --- | --- |
| Two bars, `5H` and `7D` | Normal. Set the mode in the property inspector. |
| A ring gauge | Single-window mode, set in the property inspector. |
| `RESETS IN` + countdown | Temporary peek. Press the key; it reverts after four seconds. Shows only the window(s) the key itself shows. |
| `FULL IN 8h` | Burn-rate projection: at the current pace this window fills before it resets. |
| `+50% ENDS 12d` | The temporary weekly-limit boost expires soon. Weekly peek only. |
| `SIGN IN` | No Claude Code credentials on this machine. Run `claude` once. |
| `EXPIRED` | Credentials found but the token has aged out. Run `claude` to refresh it. |
| `ERROR` | Network or API problem. Check the logs. |

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
whole file can be deleted once the date passes.

Logs live in `~/Library/Application Support/com.elgato.StreamDeck/Plugins/com.alejo.claude-usage.sdPlugin/logs/`.
A transient failure keeps the last good numbers on screen rather than blanking the key,
so a dropped packet does not interrupt you mid-glance.

## Launch Claude — the second action

A second key, **Launch Claude**, types a command into whichever terminal you currently have
focused. It defaults to `claude --dangerously-skip-permissions`, which starts a Claude Code
session with permission checks off — so before it types anything, it checks what app is
actually frontmost and refuses unless that app is a real terminal it can address (Terminal,
iTerm, Ghostty, WezTerm, kitty, Alacritty, or Warp). Pressing the key with, say, Slack or a
browser focused shows `NOT A TERMINAL` and does nothing else.

VS Code and Cursor are opt-in via a checkbox in the key's settings, off by default. macOS can
tell you which *app* is frontmost but not which *view within it* has focus, so there is no way
to distinguish the integrated terminal panel from an open source file — turning this on means
a press can just as easily type a shell command into whatever file you were last editing.

The command, whether it runs immediately or only gets typed (leaving you to press Enter
yourself), and the VS Code/Cursor opt-in are all set from the key's property inspector.

The first press asks macOS for permission — Automation for Terminal and iTerm, since they are
driven through their own scripting API, or Accessibility for everything else, since those are
driven by synthetic keystrokes. Accept the system prompt; each app only asks once.

## Building from source

For the live-reload development loop — edit, save, watch the key update without
re-installing — see [DEVELOPMENT.md](DEVELOPMENT.md), or just run `./scripts/dev-setup.sh`.


```bash
npm install
npm run build      # bundle into com.alejo.claude-usage.sdPlugin/bin/
npm test           # unit tests over parsing, thresholds, and rendering
npm run test:ui    # drives the settings panel in headless Chromium
npm run preview    # render every key state to /tmp/preview
npm run pack       # produce the .streamDeckPlugin installer
```

The settings panel bundles its own copy of [sdpi-components](https://sdpi-components.dev)
at `ui/sdpi-components.js` rather than loading it from the CDN, so the panel still opens
with no internet and cannot change underneath the plugin.

`npm run watch` rebuilds and restarts the plugin in Stream Deck as you edit. It needs
Node 24+ and the Elgato CLI (`npm install -g @elgato/cli`), plus a one-time
`streamdeck link com.alejo.claude-usage.sdPlugin` to register the development copy.

Regenerate the icons with `python3 scripts/icons.py`, and preview every key state without
a device attached using `npx tsc --outDir .build && node scripts/preview.mjs /tmp/preview`.

### Layout

```
src/lib/credentials.ts   read the OAuth token from keychain or ~/.claude/.credentials.json
src/lib/usage.ts         probe the Messages API, parse the rate-limit headers
src/lib/store.ts         one shared poller behind every key
src/lib/render.ts        SVG key faces — bars, ring gauge, message cards
src/lib/view.ts          store state + settings → what to draw
src/lib/terminal.ts      frontmost-app classification + AppleScript building for Launch Claude
src/actions/meter.ts     Stream Deck action glue
src/actions/launch.ts    Stream Deck action glue for Launch Claude
```

## Adapting it

The pieces most likely to need changing:

- **Colours and thresholds** — `SEVERITY_COLOURS` and `DEFAULT_THRESHOLDS` in `src/lib/format.ts`.
- **Layout** — `src/lib/render.ts` draws into a 144×144 viewBox. `scripts/preview.mjs`
  renders every state to a folder so you can iterate without touching hardware.
- **Stream Deck +** — add `"Encoder"` to `Controllers` in the manifest, give the action an
  `onDialRotate` handler, and add a second render path for the 200×100 touchscreen strip.
