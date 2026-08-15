# Elgato Marketplace submission — AI Usage (Devbloom)

Working notes and draft copy for submitting this plugin to the Elgato Marketplace.
Everything under "Listing copy" is written for a stranger who has never seen the
plugin; everything after that is for whoever prepares the submission.

Repo: `https://github.com/dev-bloom/ai-usage-streamdeck` (MIT). Manifest UUID
`com.devbloom.ai-usage`, currently `Version 1.3.1.0`, `Author Devbloom`.

The GitHub build and the store build are the same five actions — see "Open
questions," item 5, for why that's worth the author confirming explicitly rather
than assuming.

---

## Listing copy

### Tagline

Claude and Codex usage, live on a key — plus one-press launch and a look at what
your other Claude Code sessions are doing.

### Before you install — two things that will surprise you

**The Claude meter spends a small amount of your own Claude usage to show you
your Claude usage.** There is no API endpoint that reports Claude subscription
limits. To get a number at all, the plugin sends the smallest legal request it
can — one character in, one token out — to Anthropic's Messages API, throws the
reply away, and reads your rate-limit headers off the response. That's a real,
if tiny, cost against your own quota, and because the request counts as
activity, polling around the clock will keep a 5-hour usage window nominally
open even when you're not actually working. Polling only happens while a Claude
Usage key is visible on a profile, and the interval is yours to set (30 seconds
up to 15 minutes) in the key's own settings.

**Codex is different, and free.** Codex has a dedicated, read-only usage
endpoint, so the Codex meter costs nothing and never touches your quota or your
session window, at any polling interval. Same idea, opposite mechanism — worth
knowing before you set either key's refresh rate.

**Credentials are only ever read, never written.** For both providers, this
plugin reads the credential file the CLI already maintains and never writes to
it. Claude Code and the Codex CLI/ChatGPT app own those files; if this plugin
renewed a token and lost a write race with the CLI doing the same thing, you
could be signed out of your own tools. The one opt-in exception is a
Claude-only "Auto-renew expired token" checkbox, off by default, because
Claude Code's OAuth client id is public — no equivalent exists for Codex, so
that checkbox has no Codex counterpart on purpose, not by omission.

**The first Claude read triggers a macOS keychain prompt.** Claude credentials
live in the keychain; Codex credentials come from a plain file at
`~/.codex/auth.json`, so there's no prompt for Codex. Choose **Always Allow**
on the Claude prompt. You may see it again occasionally, because Claude Code
itself rewrites that keychain item whenever it rotates its token, which can
reset the permission — that's Claude Code's behavior, not this plugin's.

### What it does

Five actions, all under one "AI Usage" category:

- **Claude Usage** — the rolling 5-hour session window and the 7-day cap, as
  two bars or a single ring gauge (your choice), colour-coded amber then red as
  you approach a limit. Press the key to peek at exactly when each window
  resets. Settings: which window(s) to show, refresh interval, the amber/red
  thresholds, and the auto-renew checkbox described above.
- **Launch Claude** — types a command (`claude --dangerously-skip-permissions`
  by default, editable) into whichever terminal you have focused, and refuses
  to type anything if the frontmost app isn't a terminal it recognises
  (Terminal, iTerm, Ghostty, WezTerm, kitty, Alacritty, Warp — VS Code and
  Cursor are opt-in, off by default, because macOS can't tell their integrated
  terminal panel from an open source file).
- **Codex Usage** — the same two-window display for Codex, read from a
  dedicated, free, read-only endpoint. Codex reports one window (weekly) on
  the plans this was tested against, so this key's settings are simpler — no
  window picker, just refresh interval and thresholds.
- **Launch Codex** — the Codex equivalent of Launch Claude, defaulting to the
  bare `codex` command with the same terminal guard.
- **Claude Sessions** — how many of your *other* Claude Code sessions are
  waiting for input, actively running, or idle, right now. Press to see which
  sessions and why; hold the key (300ms by default, adjustable) to bring the
  first matching session's terminal window to the front. Terminal.app gets
  brought to the exact tab; VS Code and Cursor can only be raised as an app —
  macOS exposes no way to pick a pane inside another app's window — and the
  key says which it achieved rather than implying more precision than it has.

  **This key reads an undocumented Claude Code file**
  (`~/.claude/sessions/<pid>.json`), not a published API, because Claude Code
  doesn't publish one for this. That file's shape can change in a future
  Claude Code release without notice. The key is built to fail loudly rather
  than silently when that happens: an unrecognised session status shows a `?`
  face naming the value it didn't understand instead of quietly folding it
  into a count, and if the registry itself disappears while `claude` processes
  are genuinely running, the key reports `NO REGISTRY` rather than a
  confident, wrong `0`. That failure-loudly behaviour is what makes shipping
  this key on an undocumented source defensible — worth saying plainly, since
  it's a real dependency, not a hidden one.

Every key that fails shows a specific reason on its face — `SIGN IN`,
`EXPIRED`, `BLOCKED`, `OFFLINE`, `API KEY` — rather than a generic error, and
tells you the fix in the subtitle.

### Requirements

- macOS 12 or later
- Stream Deck software 6.5 or later
- Signed in to Claude Code and/or the Codex CLI/ChatGPT app at least once —
  you don't need both; each provider's keys work independently of the other.

---

## Submission checklist

Grounded against `node_modules/@elgato/schemas/streamdeck/plugins/manifest.json`
(the manifest JSON Schema shipped with `@elgato/schemas`) and the files on disk
as of this writing. Anything not checkable from files in this repo is marked
**unverified** — check it against Elgato's current developer documentation
before submitting, don't trust a guess here.

### Manifest — required fields (schema: `Manifest.allOf[].then.required`)

All present in `com.devbloom.ai-usage.sdPlugin/manifest.json` as of this
writing: `Actions`, `Author`, `CodePath`, `Description`, `Icon`, `Name`, `OS`,
`SDKVersion`, `Software`, `UUID`, `Version`. Each entry in `Actions` also needs
`Icon`, `Name`, `States`, `UUID` (schema: `definitions.Action.required`), and
each `States` entry needs `Image` (schema: `definitions.State.required`) — all
five actions have these.

### Manifest — fields worth double-checking before submission

- **`SDKVersion` is `2`, which is correct — nothing to decide.** An earlier
  draft of this document claimed the schema recommended version 3 and listed
  the allowed values as `enum: [2, 3]`. Both were wrong. The schema
  (`node_modules/@elgato/schemas/streamdeck/plugins/manifest.json`) says
  verbatim: *"Preferred SDK version; this should _currently_ always be 2"*,
  and the only permitted value is `2`. Recorded here rather than quietly
  deleted, because acting on the earlier claim would have meant changing a
  correct value to an invalid one.
- **`Description`** in the current manifest already describes all five
  actions, sessions key included — consistent with the corrected decision to
  ship five actions in the store build. No change needed there on that count.
- **`Category`** is `"AI Usage"`, matching `Name` — follows the schema's own
  recommendation ("it is therefore recommended that this be the same value as
  the plugin's `Name` field").

### Icon assets — checked against schema-declared dimensions

| Asset | Schema requirement | On disk (measured from PNG header) | Status |
|---|---|---|---|
| `imgs/plugin/marketplace.png` (top-level `Icon`) | PNG, 256×256 | 256×256 | Correct (was 288×288; regenerated) |
| `imgs/plugin/marketplace@2x.png` | PNG, 512×512 (@2x) | 512×512 | Correct (was 576×576; regenerated) |
| `imgs/plugin/category-icon.png` (`CategoryIcon`) | PNG/SVG, 28×28, monochrome white on transparent | 28×28 | Matches |
| `imgs/plugin/category-icon@2x.png` | PNG/SVG, 56×56 (@2x) | 56×56 | Matches |
| `imgs/actions/*/icon.png` (per-action `Icon`, all 5 actions) | PNG/SVG, 20×20, monochrome white on transparent | 20×20 (checked `meter/icon.png`) | Matches |
| `imgs/actions/*/icon@2x.png` | PNG/SVG, 40×40 (@2x) | 40×40 | Matches |
| `imgs/actions/*/key.png` (`States[].Image`) | GIF/PNG/SVG, 72×72 | 72×72 | Matches |
| `imgs/actions/*/key@2x.png` | 144×144 (@2x) | 144×144 | Matches |

The top-level plugin `Icon` — the one shown on the Marketplace product page
itself — is the one asset that's off-spec. It was measured directly by reading
each PNG's IHDR chunk, not eyeballed. This needs fixing before submission;
outside this document's scope to fix (this file only covers `MARKETPLACE.md`),
but it should block submission until corrected.

The schema also requires the two `CategoryIcon` and per-action `Icon` assets to
be monochrome white-on-transparent — dimensions were checked here, colour
content wasn't (would need pixel inspection, not just header dimensions).
Worth a visual check before submitting.

### License

`LICENSE` at repo root — MIT, copyright Devbloom, 2026. `package.json`
declares `"license": "MIT"`. Consistent.

### Unverified — needs checking against Elgato's current developer docs

None of the following are answerable from this repo; don't submit against a
guess for any of them:

- **Marketplace-specific artwork** beyond the manifest-declared icons — hero
  image dimensions, screenshot count/dimensions/aspect ratio, whether a promo
  video is accepted or required. The manifest schema only covers the plugin
  icon, category icon, and action/key icons above; it says nothing about a
  store listing page's own hero/screenshot assets.
- **Category taxonomy** — which Marketplace category(ies) this plugin should
  be listed under (e.g. Productivity / Developer Tools / Utilities), and
  whether "AI Usage" as a manifest `Category` has any bearing on that.
- **Review turnaround time** and the current submission/review process
  mechanics (portal, required forms, resubmission rules).
- **Maker account setup** — registration, verification, payout details if
  applicable, and who at Devbloom holds it.
- **Code signing / notarization** requirements for the packaged
  `.streamDeckPlugin`, if any, beyond what `streamdeck pack` already produces.
- **Privacy policy URL** — whether Elgato requires one for a plugin that reads
  local credential files and makes outbound requests to Anthropic's and
  OpenAI's APIs, even though it stores nothing itself and sends no telemetry.

---

## Open questions for the author

1. **Maker account.** Who registers and holds the Devbloom Maker account, and
   is "Devbloom" (the manifest `Author` value) the exact name to use on the
   Marketplace, or is there a fuller legal/brand name to use instead?
2. **Store artwork.** Hero image, screenshots, and any promotional copy or
   video beyond what's in this document — needs someone to actually produce
   these once their required dimensions are confirmed (see "Unverified"
   above).
3. **Support contact.** The manifest's `URL` currently points at the GitHub
   repo. Is that the intended support channel for Marketplace users, or does
   Devbloom want a dedicated support email/page — especially relevant now that
   Claude Sessions ships to strangers who won't necessarily go looking on
   GitHub.
4. **Privacy policy URL**, if Elgato's submission flow asks for one — see
   "Unverified" above for why this can't be answered from the repo alone.
5. **Versioning story.** The original brief for this document assumed the
   store build would ship four actions (Claude Sessions excluded) while
   GitHub kept five; that was reversed mid-task and the store build now ships
   all five, matching GitHub. Worth the author explicitly confirming this is
   the final intent — a single build, one version number, both channels — since
   the premise flipped once already and a silent second flip would be easy to
   miss.
6. **Support story for the sessions key's undocumented dependency.** Claude
   Sessions reads `~/.claude/sessions/<pid>.json`, a file Claude Code doesn't
   document and can change in any release. The plugin is built to fail loudly
   rather than silently when that happens (`UNKNOWN STATUS`, `NO REGISTRY`,
   `UNREADABLE` — see README.md's "Claude Sessions" section), but a breaking
   Claude Code update will now surface as Marketplace store reviews from
   people who don't know why their key changed, not as GitHub issues from
   people who read the README first. Worth deciding in advance: how fast a
   patch release ships when that happens, and whether the store listing
   itself should say anything about this risk up front (this document's
   listing copy above already states it plainly, under "Before you install").
7. **Plugin icon dimensions — fixed, no action needed.** These were
   288×288 / 576×576 against a schema requirement of 256×256 / 512×512, which
   would have failed submission. They are now correct, regenerated by
   `scripts/gen-codex-icons.mjs`; the old `scripts/icons.py` that hardcoded
   288 has never been runnable (it needs `cairosvg`, which is not installed).
   Left here as a record of the catch rather than deleted.
