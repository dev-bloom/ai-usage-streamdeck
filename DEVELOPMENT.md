# Working on this plugin

The development loop is: save a file → rollup rebuilds → the Stream Deck app restarts
the plugin → the key repaints. No re-installing, no dragging the action back onto a key.

## One-time setup

```bash
cd ~/Documents/streamdeck/plugins/claude-usage-streamdeck
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
streamdeck link com.alejo.claude-usage.sdPlugin
```

### Remove the packaged copy first

If you already installed `com.alejo.claude-usage.streamDeckPlugin` by double-clicking it,
uninstall that before linking. Two copies with the same UUID will fight over which one
Stream Deck loads, and the symptom — edits that appear to do nothing — is confusing.

Right-click the plugin in the Stream Deck actions list and choose **Uninstall**, or run:

```bash
rm -rf ~/Library/Application\ Support/com.elgato.StreamDeck/Plugins/com.alejo.claude-usage.sdPlugin
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
tail -f com.alejo.claude-usage.sdPlugin/logs/*.log
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

## Tests

```bash
npm test          # parsing, thresholds, countdown formatting, SVG rendering
npm run test:ui   # the settings panel, in a browser
```

`npm test` compiles to `.build/` first, so it always runs against current source.

## Shipping a build

```bash
npm run pack
```

Produces `com.alejo.claude-usage.streamDeckPlugin`. Bump `Version` in
`com.alejo.claude-usage.sdPlugin/manifest.json` first — Stream Deck uses it to decide
whether an install is an upgrade.

Note that packing while `streamdeck link` is active is fine; the linked copy and the
packaged file are independent.

## Gotchas worth knowing

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
pgrep -f com.alejo.claude-usage.sdPlugin/bin/plugin.js
```

**Changing the manifest requires a real restart.** Restarting the plugin process is not
enough — Stream Deck only re-reads `manifest.json` when the plugin is loaded fresh. After
editing actions, icons, or `Controllers`, quit and reopen Stream Deck. This applies just the
same to adding a whole new action, as when Launch Claude was added — a rebuilt bundle alone
does not make the new action show up in the actions list.

**The probe counts as activity.** A tight watch loop that keeps restarting the plugin will
keep firing usage probes. Harmless, but if you are testing for a while, set the refresh
interval to 15 minutes in the key's settings so you are not nudging your own 5-hour window.
