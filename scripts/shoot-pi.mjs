/**
 * Screenshot the property inspector in headless Chromium so layout can be
 * checked without a Stream Deck attached.
 *
 * The real panel is 344px wide on a dark chrome, and sdpi-components expects a
 * `connectElgatoStreamDeckSocket` handshake it will never get here — so we stub
 * just enough of the websocket for the components to settle, and feed them the
 * settings we want to see rendered.
 */
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const page = resolve(here, "..", "com.alejo.claude-usage.sdPlugin", "ui", "meter.html");
const out = process.argv[2] ?? "/tmp/pi.png";
const settings = JSON.parse(process.argv[3] ?? '{"warnAt":65,"critAt":85,"mode":"both","intervalSeconds":"60"}');

// No explicit executablePath — see the note in test/pi.test.mjs. Pinning one
// tied this script to a single machine's browser location.
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 344, height: 700 }, deviceScaleFactor: 2 });
const p = await ctx.newPage();

// Stand in for the Stream Deck host: echo back a didReceiveSettings payload so
// the bound components populate exactly as they would in the real panel.
await p.addInitScript((s) => {
  class FakeSocket {
    constructor() {
      this.readyState = 1;
      setTimeout(() => {
        this.onopen?.();
        this.onmessage?.({
          data: JSON.stringify({
            event: "didReceiveSettings",
            context: "ctx",
            action: "com.alejo.claude-usage.meter",
            payload: { settings: s, coordinates: { column: 0, row: 0 }, isInMultiAction: false },
          }),
        });
      }, 0);
    }
    send() {}
    close() {}
    addEventListener(type, fn) { this[`on${type}`] = fn; }
  }
  window.WebSocket = FakeSocket;
  window.addEventListener("load", () => {
    setTimeout(() => {
      window.connectElgatoStreamDeckSocket?.(
        28196, "ctx", "registerPropertyInspector",
        JSON.stringify({ application: { platform: "mac" } }),
        JSON.stringify({ action: "com.alejo.claude-usage.meter", context: "ctx", payload: { settings: s } }),
      );
    }, 50);
  });
}, settings);

await p.goto(`file://${page}`);
// Stream Deck's own panel background, so contrast reads truthfully.
await p.addStyleTag({ content: "body{background:#2d2d2d;margin:0;padding:12px 0;}" });
await p.waitForTimeout(1800);
await p.screenshot({ path: out, fullPage: true });

await browser.close();
console.log(`wrote ${out}`);
