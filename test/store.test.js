import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { UsageStore } from "../.build/lib/store.js";

/** A minimal Provider whose fetchUsage is fully controlled by the test. */
function fakeProvider(fetchUsage) {
  return {
    id: "test",
    label: "Test",
    signInHint: "run test",
    fetchUsage,
    invalidateCredentialCache() {},
    pollCostsQuota: false,
  };
}

/** Poll until `fn()` is truthy, rather than guessing a fixed delay for doFetch's async chain to settle. */
async function waitFor(fn, timeoutMs = 1000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("UsageStore failure logging (see the comment on onFailure in store.ts)", () => {
  it("logs a repeating failure once, not once per poll", async () => {
    const store = new UsageStore(fakeProvider(async () => {
      throw new Error("boom");
    }));
    const logged = [];
    store.onFailure = (failure) => logged.push(failure.message);

    const unsubscribe = store.subscribe(() => {});
    await waitFor(() => logged.length >= 1);

    // A second and third poll of the *same* failure must not add more lines.
    store.refreshNow();
    store.refreshNow();
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(logged.length, 1);
    assert.equal(logged[0], "boom");
    unsubscribe();
  });

  it("logs again when the failure message actually changes", async () => {
    let call = 0;
    const store = new UsageStore(fakeProvider(async () => {
      call++;
      throw new Error(call === 1 ? "first problem" : "second problem");
    }));
    const logged = [];
    store.onFailure = (failure) => logged.push(failure.message);

    const unsubscribe = store.subscribe(() => {});
    await waitFor(() => logged.length >= 1);
    store.refreshNow();
    await waitFor(() => logged.length >= 2);

    assert.deepEqual(logged, ["first problem", "second problem"]);
    unsubscribe();
  });

  it("re-arms after a successful fetch, so a later recurrence of the same message logs again", async () => {
    let call = 0;
    const store = new UsageStore(fakeProvider(async () => {
      call++;
      if (call === 2) {
        // One good reading in the middle — a real recovery, not a fluke.
        return {
          sessionPct: 1, weeklyPct: 1,
          sessionResetAt: null, weeklyResetAt: null,
          fetchedAt: new Date(),
        };
      }
      throw new Error("boom");
    }));
    const logged = [];
    store.onFailure = (failure) => logged.push(failure.message);

    // Track status via the subscriber rather than the `call` counter alone:
    // `call` increments the instant fetchUsage starts, before doFetch has
    // finished updating state and clearing `inFlight` — waiting on the
    // published *state* instead avoids a refreshNow() landing while the
    // previous fetch's cleanup is still in flight.
    let latest;
    const unsubscribe = store.subscribe((state) => {
      latest = state;
    });
    await waitFor(() => latest?.status === "fail"); // call 1: fails, logs

    store.refreshNow();
    await waitFor(() => latest?.status === "ok"); // call 2: succeeds, no new log

    store.refreshNow();
    await waitFor(() => latest?.status === "fail" && logged.length >= 2); // call 3: fails again

    assert.equal(call, 3);
    assert.deepEqual(logged, ["boom", "boom"]);
    unsubscribe();
  });

  it("logs once even with several keys subscribed to the same store", async () => {
    // Two keys of one provider share one UsageStore (see the class comment
    // in store.ts); doFetch runs once regardless of subscriber count, so
    // logging inside it — rather than per-subscriber in meter.ts — must
    // never produce one line per key.
    const store = new UsageStore(fakeProvider(async () => {
      throw new Error("boom");
    }));
    const logged = [];
    store.onFailure = (failure) => logged.push(failure.message);

    const unsubA = store.subscribe(() => {});
    const unsubB = store.subscribe(() => {});
    await waitFor(() => logged.length >= 1);
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(logged.length, 1);
    unsubA();
    unsubB();
  });

  it("never throws when onFailure is left unset — logging is opt-in", async () => {
    const store = new UsageStore(fakeProvider(async () => {
      throw new Error("boom");
    }));
    let sawFail = false;
    const unsubscribe = store.subscribe((state) => {
      if (state.status === "fail") sawFail = true;
    });
    await waitFor(() => sawFail);
    unsubscribe();
    // Reaching here without an uncaught rejection or thrown error is the pass.
  });
});
