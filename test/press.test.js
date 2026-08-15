import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PressTracker } from "../.build/lib/press.js";

/**
 * A fake scheduler that never sleeps: `setTimer` just records the callback
 * and delay, and `fire(handle)` invokes it synchronously. This is what lets
 * the "hold past threshold" tests below run instantly instead of racing a
 * real 500ms timer.
 */
function fakeScheduler() {
  let nextHandle = 1;
  const pending = new Map();
  return {
    setTimer(fn, ms) {
      const handle = nextHandle++;
      pending.set(handle, { fn, ms });
      return handle;
    },
    clearTimer(handle) {
      pending.delete(handle);
    },
    /** Simulate the timer for `handle` reaching its delay. No-op if already cleared. */
    fire(handle) {
      const entry = pending.get(handle);
      if (!entry) return;
      pending.delete(handle);
      entry.fn();
    },
    pendingCount() {
      return pending.size;
    },
    /** The delay a still-pending handle was scheduled with, for asserting a per-press threshold. */
    msFor(handle) {
      return pending.get(handle)?.ms;
    },
  };
}

function makeTracker(overrides = {}) {
  const scheduler = fakeScheduler();
  const longs = [];
  const tracker = new PressTracker({
    thresholdMs: 500,
    onLong: (id) => longs.push(id),
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    ...overrides,
  });
  return { tracker, scheduler, longs };
}

describe("PressTracker", () => {
  it("fires onLong once while held past the threshold, then up() reports long", () => {
    const { tracker, scheduler, longs } = makeTracker();
    tracker.down("a");
    scheduler.fire(1); // down("a") is the very first setTimer call, handle 1
    assert.deepEqual(longs, ["a"]);
    assert.equal(tracker.up("a"), "long");
  });

  it("never fires onLong and reports short when released before the threshold", () => {
    const { tracker, scheduler, longs } = makeTracker();
    tracker.down("a");
    assert.equal(tracker.up("a"), "short");
    assert.deepEqual(longs, []);
    // up() must have cleared the pending timer, not just ignored it.
    assert.equal(scheduler.pendingCount(), 0);
  });

  it("up() without a matching down() reports short and does not throw", () => {
    const { tracker, longs } = makeTracker();
    assert.doesNotThrow(() => {
      assert.equal(tracker.up("never-pressed"), "short");
    });
    assert.deepEqual(longs, []);
  });

  it("a second down() for the same id replaces the pending timer instead of stacking one", () => {
    const { tracker, scheduler, longs } = makeTracker();
    tracker.down("a"); // handle 1
    tracker.down("a"); // replaces handle 1 with handle 2
    assert.equal(scheduler.pendingCount(), 1);
    scheduler.fire(1); // the replaced timer must be inert
    assert.deepEqual(longs, []);
    scheduler.fire(2); // only the live one fires
    assert.deepEqual(longs, ["a"]);
    assert.equal(tracker.up("a"), "long");
  });

  it("cancel() drops a pending timer so a later fire is a no-op", () => {
    const { tracker, scheduler, longs } = makeTracker();
    tracker.down("a");
    tracker.cancel("a");
    scheduler.fire(1);
    assert.deepEqual(longs, []);
    assert.equal(tracker.up("a"), "short");
  });

  it("cancel() after onLong already fired also clears the long verdict", () => {
    const { tracker, scheduler } = makeTracker();
    tracker.down("a");
    scheduler.fire(1);
    tracker.cancel("a");
    assert.equal(tracker.up("a"), "short");
  });

  it("cancelAll() drops every pending timer across ids", () => {
    const { tracker, scheduler, longs } = makeTracker();
    tracker.down("a"); // handle 1
    tracker.down("b"); // handle 2
    tracker.cancelAll();
    scheduler.fire(1);
    scheduler.fire(2);
    assert.deepEqual(longs, []);
    assert.equal(tracker.up("a"), "short");
    assert.equal(tracker.up("b"), "short");
  });

  it("cancelAll() also clears ids that already fired but never reached up()", () => {
    const { tracker, scheduler } = makeTracker();
    tracker.down("a");
    scheduler.fire(1);
    tracker.cancelAll();
    assert.equal(tracker.up("a"), "short");
  });

  it("two ids are tracked independently", () => {
    const { tracker, scheduler, longs } = makeTracker();
    tracker.down("a"); // handle 1
    tracker.down("b"); // handle 2
    scheduler.fire(1); // only "a" crosses the threshold
    assert.deepEqual(longs, ["a"]);
    assert.equal(tracker.up("b"), "short"); // "b" released early
    assert.equal(tracker.up("a"), "long");
  });

  it("uses a default threshold and a default real timer when none are injected", () => {
    // Just verifying construction doesn't throw without the test-only
    // options — no real timer is allowed to fire during this test.
    assert.doesNotThrow(() => new PressTracker({ onLong: () => {} }));
  });

  it("down(id, ms) schedules at the given threshold instead of the constructor default", () => {
    const { tracker, scheduler, longs } = makeTracker(); // constructor default is 500
    tracker.down("a", 250);
    assert.equal(scheduler.msFor(1), 250);
    scheduler.fire(1);
    assert.deepEqual(longs, ["a"]);
  });

  it("down(id) with no second argument still uses the constructor default", () => {
    const { tracker, scheduler } = makeTracker();
    tracker.down("a");
    assert.equal(scheduler.msFor(1), 500);
  });

  it("clamps an out-of-range per-press threshold into [200, 2000]", () => {
    const { tracker, scheduler } = makeTracker();
    tracker.down("a", 50);
    assert.equal(scheduler.msFor(1), 200);

    tracker.down("a", 5000); // replaces handle 1 with handle 2
    assert.equal(scheduler.msFor(2), 2000);
  });

  for (const bad of [NaN, Infinity, -Infinity, null, undefined, "soon"]) {
    it(`falls back to the constructor default for a nonsense threshold (${String(bad)})`, () => {
      const { tracker, scheduler } = makeTracker();
      tracker.down("a", bad);
      assert.equal(scheduler.msFor(1), 500);
    });
  }

  it("two ids can hold different per-press thresholds concurrently without interfering", () => {
    const { tracker, scheduler, longs } = makeTracker();
    tracker.down("a", 200); // handle 1
    tracker.down("b", 900); // handle 2
    assert.equal(scheduler.msFor(1), 200);
    assert.equal(scheduler.msFor(2), 900);

    scheduler.fire(1); // "a" crosses its own, shorter threshold
    assert.deepEqual(longs, ["a"]);
    assert.equal(tracker.up("b"), "short"); // "b"'s longer timer never fired

    assert.equal(tracker.up("a"), "long");
  });
});
