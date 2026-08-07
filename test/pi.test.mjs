/**
 * Drives the property inspector in a real browser to prove the threshold
 * readouts track the sliders. The rest of the suite is pure functions; this
 * covers the one piece of behaviour that only exists in the DOM.
 *
 *   node --test test/pi.test.mjs
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const pagePath = resolve(here, "..", "com.alejo.claude-usage.sdPlugin", "ui", "meter.html");

let browser;
let page;

/** Text currently shown in a readout span. */
const readout = (id) => page.locator(`#${id}`).innerText();

/**
 * Move a slider the way a person does: set the inner range input and fire the
 * events a real drag produces — `input` while dragging, `change` on release.
 */
async function drag(id, value, { release = true } = {}) {
  await page.evaluate(
    ({ id, value, release }) => {
      const inner = document.getElementById(id).shadowRoot.querySelector("input");
      inner.value = String(value);
      inner.dispatchEvent(new Event("input", { bubbles: true }));
      if (release) inner.dispatchEvent(new Event("change", { bubbles: true }));
    },
    { id, value, release },
  );
  await page.waitForTimeout(60);
}

before(async () => {
  // No explicit executablePath: let Playwright resolve the browser it
  // installed. Pinning an absolute path ties the suite to one machine — this
  // previously pointed at a Linux container path and so could never run on
  // macOS at all.
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 344, height: 700 } });

  // Stand in for the Stream Deck host so the components bind to real settings.
  await page.addInitScript(() => {
    const settings = { warnAt: 65, critAt: 85, mode: "both" };
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
              payload: { settings, coordinates: { column: 0, row: 0 }, isInMultiAction: false },
            }),
          });
        }, 0);
      }
      send() {}
      close() {}
      addEventListener(type, fn) { this[`on${type}`] = fn; }
    }
    window.WebSocket = FakeSocket;
    window.addEventListener("load", () =>
      setTimeout(
        () =>
          window.connectElgatoStreamDeckSocket?.(
            28196, "ctx", "registerPropertyInspector",
            JSON.stringify({ application: { platform: "mac" } }),
            JSON.stringify({ action: "com.alejo.claude-usage.meter", context: "ctx", payload: { settings } }),
          ),
        30,
      ),
    );
  });

  await page.goto(`file://${pagePath}`);
  await page.waitForTimeout(1200);
});

after(async () => {
  await browser?.close();
});

describe("property inspector thresholds", () => {
  it("shows the persisted values, not the markup defaults", async () => {
    // Defaults are 70/90; the mocked settings say 65/85.
    assert.equal(await readout("warnOut"), "65%");
    assert.equal(await readout("critOut"), "85%");
  });

  it("tracks the thumb while dragging, before release", async () => {
    await drag("warn", 40, { release: false });
    assert.equal(await readout("warnOut"), "40%");
  });

  it("keeps the value after release", async () => {
    await drag("crit", 95);
    assert.equal(await readout("critOut"), "95%");
  });

  it("handles both ends of the range", async () => {
    await drag("warn", 0);
    assert.equal(await readout("warnOut"), "0%");
    await drag("warn", 100);
    assert.equal(await readout("warnOut"), "100%");
  });

  it("persists the dragged value into settings", async () => {
    await drag("crit", 75);
    const stored = await page.evaluate(() => document.getElementById("crit").value);
    assert.equal(Number(stored), 75);
  });

  it("loads its components from the bundled copy, not a CDN", async () => {
    // The panel has to work with no internet; a remote <script> would break it.
    const remote = await page.evaluate(() =>
      [...document.querySelectorAll("script[src]")].map((s) => s.getAttribute("src")),
    );
    assert.deepEqual(remote, ["sdpi-components.js"]);
  });
});
