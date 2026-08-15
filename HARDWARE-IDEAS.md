# Hardware ideas: Stream Deck Plus and Pedal

Two new devices are inbound: a **Stream Deck Plus** and a **Stream Deck Pedal**. Current
hardware is a **Stream Deck MK.2** — 15 keys, 5×3 — verified over USB via `ioreg`. An 8×4
device named "MCP Deck" also shows up in Stream Deck's device list, but it's a *virtual*
device (type 14, no USB presence), not a second physical pad.

This file is thinking, not a plan. Nothing here is built, scheduled, or even decided —
the point is to have the reasoning ready for when the hardware actually lands, so that
session doesn't start from zero. Every claim below is either something already verified
in this codebase (stated as fact) or a stated unknown — see the last section for the
biggest one.

## 1. What has to change before anything works

**Plus.** All five current actions — Claude Usage, Launch Claude, Claude Sessions, Codex
Usage, Launch Codex — declare `"Controllers": ["Keypad"]` only (see
`com.devbloom.ai-usage.sdPlugin/manifest.json`). On a Plus they'll work fine on its 8 keys
and be **completely invisible on the 4 dials** until an action explicitly opts in with
`"Controllers": ["Keypad", "Encoder"]` plus an `Encoder` manifest block (`Icon`,
`StackColor`, `TriggerDescription`, `background`, `layout`). `layout` takes either a
predefined name (`$X1`, `$A0`, `$A1`, `$B1`, `$B2`, `$C1`) or a path to a custom JSON
layout — verified against `@elgato/schemas/streamdeck/plugins/manifest.json`.

On the code side, dial support means new SDK handlers that don't exist for keys at all:
`onDialRotate` (payload carries `ticks`, so rotation velocity is available for free),
`onDialDown`, `onDialUp`, and `onTouchTap` (payload carries a native `hold` boolean and
`tapPos`). `onTouchTap`'s `hold` is the *only* place Elgato hands a hold to the plugin for
free — everywhere else, including every key on both current devices, a hold has to be
timed by the plugin itself, which is the entire reason `src/lib/press.ts` exists. And per
`DEVELOPMENT.md`, a manifest change like this needs a full Stream Deck quit-and-reopen,
not just a rebuild — the same rule that applied when the Codex actions were added.

There's also a second render surface to build: `src/lib/render.ts` currently draws one
144×144 viewBox for a 72×72 physical key. A dial's touchscreen segment is a different
shape entirely (roughly 200×100 per dial) and has no render path today at all — this
isn't a config flag, it's new code.

**Pedal.** `DeviceType` 5, and a `Keypad` controller — both verified in
`node_modules/@elgato/schemas/dist/streamdeck/plugins/index.mjs`, which also describes it
as *"comprised of 3 customizable pedals"*, so the three-switch count is documented rather
than assumed — so, unlike the
Plus, **all five existing actions already work on it with zero manifest change.** Drag
any of them onto a pedal today and they'll fire on press exactly as they do on the MK.2.

The catch: the Pedal has **no screen**. Every face this plugin draws — the two-bar meter,
the ring gauge, the three-row session counts, the whole-key colour flash added for
hold-to-focus — draws to nothing there. A user (including future-me) could drag Claude
Usage onto a pedal and get total silence, with no error and no obvious reason why. Worth
flagging plainly rather than discovering it by surprise.

## 2. Ideas, ranked by whether the data already exists

Ergonomics are unverified for every idea below, without exception. Nobody has rotated a
dial to scroll through this plugin's own data or pressed a pedal to focus a window — that
can only be judged with the hardware in hand, not reasoned about in advance. What follows
is ranked by a different axis: how much of the *data* an idea needs already exists in this
codebase versus how much would be new.

### Tier 1 — rests entirely on data and code already produced

**Pedal, pinned to a bucket, hold-to-focus only.** Assign Claude Sessions to a pedal
switch with **Show** set to, say, "Waiting only." A press peeks (into nothing, since
there's no screen — harmless, just wasted) and a hold runs the exact same
`firstFocusableSession` → `focusSession(pid)` path `src/actions/sessions.ts` already runs
for a key. Zero new code. The pedal becomes a foot-operated "jump to whichever session is
waiting on me" trigger, and needs nothing more than dragging the action onto it and
picking a mode in the existing property inspector.

**Pedal running Launch Claude or Launch Codex.** Same story — `LaunchBase` in
`src/actions/launch.ts` is a `Keypad` action with no dependency on a screen; a foot press
types the launch command into whatever terminal is frontmost. Zero new code.

**Dial as a scroller over `SessionsSnapshot.ranked`.** This is the one genuinely new idea
worth building, and it directly dissolves two compromises this repo accepted purely
because a 72×72 key is small:

1. The peek shows at most three sessions — a key has room for three rows before overflow
   has to be carried by a count.
2. Hold-to-focus always jumps to the *first* session in the bucket — there's no way to
   choose which one.

A dial rotates through `ranked` one entry at a time (the list is already ordered waiting →
processing → idle, per `buildSnapshot` in `src/lib/sessions.ts`), the touchscreen shows
that one session's `label`, `bucket`, and `detail` (the `waitingFor` reason) with far more
room than a key ever had, and `onDialDown` calls `focusSession(session.pid)` — the same
generic-over-any-pid function `src/lib/focus.ts` already exports. The list stops being
capped at three, and "which session" becomes something the user picks rather than
something the ranking decides for them. What's reused: the entire `ranked` array, its
sort order, and `focusSession` unchanged. What's new: the touchscreen render path (there
isn't one yet, see above) and the rotate-to-index bookkeeping. What's unknown: everything
about how it actually feels to use — that's the honest answer, not a gap in the plan.

### Tier 2 — needs new code, but no new data source

**Dial as a live mode switch for a usage meter.** Rotating between "5H", "7D", and "both"
on a Claude or Codex meter, instead of setting `DisplayMode` once in the property
inspector. Rests on data that already exists — `DisplayMode`, `UsageSnapshot`, the render
logic in `render.ts` — but touching it live via a dial is new wiring, and it's worth being
honest that the property inspector already does this job adequately for a mode that
rarely changes mid-session. Lower priority than the sessions scroller for exactly that
reason: it solves a problem that may not be a problem.

**Tick velocity for faster scrolling.** `onDialRotate`'s `ticks` field means a fast spin
and a slow spin are distinguishable, so a scroller could jump multiple sessions per fast
tick instead of one. Small addition on top of the Tier 1 scroller, not a separate feature
— worth deferring until the plain one-tick-one-session version has been used and found too
slow, not built preemptively.

**`StackColor` per bucket.** The manifest's `Encoder` block supports a `StackColor` per
dial; mapping it to whichever bucket a session's ranked position falls into would reuse
the same severity-style thinking `SEVERITY_COLOURS` already encodes in `format.ts`, just
applied to a different property. Cosmetic, cheap, not worth doing before the scroller
itself works.

### Tier 3 — speculation, no data path established

**Anything that tries to show or act on Codex session state.** There is no data source for
this — see the "do not" list below. Any dial or pedal idea that implicitly assumes Codex
has a sessions-style registry is speculation dressed as a feature.

**Chording multiple pedal switches together.** The device is documented as three pedals
(`@elgato/schemas`: *"comprised of 3 customizable pedals"*), and each is expected to be a
separate `Keypad` context — but whether two simultaneous presses arrive as two independent
`keyDown` events, and with what timing, is **not** documented anywhere reachable from here,
and is not something measured on
this machine yet, since the hardware hasn't arrived. If it holds, three independent
bindings become available (e.g. one pedal per bucket: waiting / running / idle, each
focusing its own first match) rather than one. Worth confirming the moment the device is
in hand before designing around it.

## 3. The Pedal's specific strength — and its specific weakness

The strength isn't "one more input device," it's a combination of three things that
happen to line up:

- **Hands never leave the keyboard.** A foot press doesn't compete with typing the way
  reaching for a Stream Deck key does.
- **Pedals are momentary switches designed to be held.** `PressTracker` in
  `src/lib/press.ts` already distinguishes short-vs-long by timing a hold from `down()` to
  `up()`, with no assumption baked in about what triggers those events — it works
  unchanged on a pedal switch exactly as it does on a key.
- **The missing-feedback problem solves itself for exactly one use case: focus.** The
  Pedal can't show `FOCUSED` or `EMPTY` the way a key's whole-face flash does, but for a
  hold-to-focus action the confirmation *is* the window arriving on screen. No screen
  needed because the desktop itself is the screen.

That last point is also the boundary. It only works for actions whose entire feedback is
"something visibly happened." Anything that needs to *convey a number or a state* — a
usage percentage, a countdown, three bucket counts, an em dash meaning "not reported" —
has nothing to draw on, and forcing it onto a pedal just produces silence where a reading
should be.

## 4. A division of labour worth considering

If both devices end up carrying Claude Sessions in some form, the useful split is:
**the Plus displays state and allows selection; the Pedal acts without looking.** A dial
scrolling `ranked` and pressing to focus is a *browse-then-commit* interaction — you look,
you choose, you commit. A pedal pinned to "Waiting only" hold-to-focus is a
*don't-look-just-act* interaction — you already know you want the most urgent one, so you
just press.

Neither should duplicate the other's job. Putting the same "always focus the first
waiting session" binding on both a key, a pedal, and a dial-press would just be the same
feature three times over with no new capability gained. The dial earns its place only if
it's used for the thing a pedal categorically can't do — choosing *which* session, not
just acting on the top one.

## 5. Do not do these — recorded so they don't get relitigated

- **Don't put meters, counts, or any numeric readout on a pedal.** It has no screen. This
  isn't a missing feature to work around; it's the device.
- **Don't infer Codex session state.** Codex publishes none. `~/.codex/sessions/` holds
  rollout transcripts, not a status registry — there is nothing there to poll the way
  `~/.claude/sessions/<pid>.json` is polled for Claude. A Codex equivalent of the sessions
  key is not buildable honestly today; the provider layer is generic enough that it would
  be a small addition *if* OpenAI ever exposes something equivalent, but that's a
  precondition, not a task.
- **Don't assume dial ergonomics before trying them.** Every idea in Tier 1 above is
  plausible on paper and completely unverified in practice. Rotating through a list might
  feel obviously better than pressing a key repeatedly, or it might feel fiddly and slow —
  that's only answerable with the hardware.
- **Don't start with the SDK migration** (this plugin is on `@elgato/streamdeck` 1.4.1;
  dial support technically doesn't require the 2.x jump the Marketplace listing would
  need, but it's tempting to bundle them). Keep them separate decisions.

## 6. Before building anything: use the plugin for a week

The recommendation at the end of the session that produced this plugin was not to start
building on new hardware at all, but to use the existing one for a week first. Whether the
sessions key stays accurate over real, sustained use, and whether 300ms is actually the
right hold threshold rather than just a reasonable-sounding default, are only answerable
by living with the plugin — not by reasoning about dials in the abstract. This file exists
so that when the hardware arrives, or when that week is up, the thinking doesn't have to
start over.
