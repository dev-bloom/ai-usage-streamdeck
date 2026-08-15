import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  bucketFromStatus,
  buildSnapshot,
  claudePidsFromTable,
  corroborationVerdict,
  isAliveErrorCode,
  isInteractiveKind,
  isRegistryFileName,
  labelFor,
  parsePsTable,
  parseSessionRecord,
  readSessions,
} from "../.build/lib/sessions.js";
import { SessionsStore } from "../.build/lib/sessions-store.js";

/** Poll until `fn()` is truthy, rather than guessing a fixed delay. */
async function waitFor(fn, timeoutMs = 1000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * A fresh temp directory per test, cleaned up afterwards. Deliberately
 * `async` and `await`s `fn` itself: returning the bare promise from a
 * non-async `try` would let `finally` fire (and delete the directory)
 * before the caller's asserts have actually run.
 */
async function withTmpDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "sessions-test-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Three real captures from ~/.claude/sessions/<pid>.json, verbatim for the
// fields the prompt specified; the elided ("...") fields from the original
// measurement are filled in with the same shape so these parse exactly like
// real files. 2.1.229 (pid 4477) genuinely has no `nameSince` — that's not
// a redaction, it predates the field.
const CAPTURE_4477_2_1_229 = {
  pid: 4477,
  cwd: "/Users/x/Documents/patitas",
  entrypoint: "cli",
  kind: "interactive",
  messagingSocketPath: "/tmp/cc-socks/4477.sock",
  name: "fix-firestore-indexes-earthquake-response",
  peerProtocol: 1,
  // Measured landmine: UTC-rendered, unlike ps's local-time lstart. See the
  // "does not compare procStart" test below — this value is deliberately
  // never read by any function in sessions.ts.
  procStart: "Wed Aug 12 23:08:23 2026",
  startedAt: 1786576104469,
  status: "busy",
  statusUpdatedAt: 1786811287773,
  updatedAt: 1786811287773,
  version: "2.1.229",
};

const CAPTURE_54611_2_1_232 = {
  pid: 54611,
  cwd: "/Users/x/Documents/matches-app",
  entrypoint: "cli",
  kind: "interactive",
  messagingSocketPath: "/tmp/cc-socks/54611.sock",
  name: "matches-navigation-restore",
  nameSince: 1786735582777,
  peerProtocol: 1,
  procStart: "Wed Aug 12 08:00:00 2026",
  startedAt: 1786735000000,
  status: "idle",
  statusUpdatedAt: 1786771201287,
  updatedAt: 1786771201287,
  version: "2.1.232",
};

const CAPTURE_63004_2_1_233 = {
  pid: 63004,
  cwd: "/Users/x/Documents/claude-sessions-stream-deck",
  entrypoint: "cli",
  kind: "interactive",
  messagingSocketPath: "/tmp/cc-socks/63004.sock",
  name: "claude-sessions-stream-deck",
  nameSince: 1786813983673,
  nameSource: "user", // only 2.1.233 sends this
  peerProtocol: 1,
  procStart: "Wed Aug 12 12:00:00 2026",
  startedAt: 1786800000000,
  status: "busy",
  statusUpdatedAt: 1786813982636,
  updatedAt: 1786813982636,
  version: "2.1.233",
};

describe("bucketFromStatus", () => {
  it("maps the known allowlist after trim/lowercase", () => {
    assert.equal(bucketFromStatus("busy"), "processing");
    assert.equal(bucketFromStatus("shell"), "processing");
    assert.equal(bucketFromStatus("waiting"), "waiting");
    assert.equal(bucketFromStatus("idle"), "idle");
  });

  it("is tolerant of case and surrounding whitespace", () => {
    assert.equal(bucketFromStatus("  BUSY  "), "processing");
    assert.equal(bucketFromStatus("Idle"), "idle");
    assert.equal(bucketFromStatus("WAITING"), "waiting");
  });

  it("maps a plausible future status to unknown, and leaves idle unaffected", () => {
    const before = bucketFromStatus("idle");
    assert.equal(bucketFromStatus("compacting"), "unknown");
    // The critical property: an unrecognised status must never fall through
    // into a real bucket, and specifically not into idle — that's the
    // failure that would make this key falsely report "nobody is blocked".
    assert.equal(bucketFromStatus("idle"), before);
    assert.equal(before, "idle");
  });

  it("maps missing, non-string, and empty status to unknown — never to a real bucket", () => {
    assert.equal(bucketFromStatus(undefined), "unknown");
    assert.equal(bucketFromStatus(null), "unknown");
    assert.equal(bucketFromStatus(42), "unknown");
    assert.equal(bucketFromStatus({}), "unknown");
    assert.equal(bucketFromStatus([]), "unknown");
    assert.equal(bucketFromStatus(""), "unknown");
    assert.equal(bucketFromStatus("   "), "unknown");
  });
});

describe("isInteractiveKind", () => {
  it("includes missing kind (a CLI predating the field) and 'interactive'", () => {
    assert.equal(isInteractiveKind(undefined), true);
    assert.equal(isInteractiveKind("interactive"), true);
  });

  it("excludes every other value, including ones never observed before", () => {
    assert.equal(isInteractiveKind("bg"), false);
    assert.equal(isInteractiveKind("daemon"), false);
    assert.equal(isInteractiveKind("daemon-worker"), false);
    assert.equal(isInteractiveKind("some-future-kind"), false);
  });
});

describe("isRegistryFileName", () => {
  it("matches <pid>.json only", () => {
    assert.equal(isRegistryFileName("4477.json"), true);
    assert.equal(isRegistryFileName("0.json"), true);
  });

  it("filters out <pid>.<sha>.key files", () => {
    assert.equal(isRegistryFileName("4477.abcdef123.key"), false);
    assert.equal(isRegistryFileName("4477.json.key"), false);
    assert.equal(isRegistryFileName("not-a-pid.json"), false);
    assert.equal(isRegistryFileName("4477.JSON"), false);
  });
});

describe("parseSessionRecord", () => {
  it("parses all three real captures, including the 2.1.229 shape missing nameSince", () => {
    const r1 = parseSessionRecord(JSON.stringify(CAPTURE_4477_2_1_229));
    assert.equal(r1.pid, 4477);
    assert.equal(r1.status, "busy");
    assert.equal(r1.name, "fix-firestore-indexes-earthquake-response");
    assert.equal(r1.version, "2.1.229");
    assert.equal(r1.waitingFor, undefined); // absent, not null — never present until a session enters "waiting"

    const r2 = parseSessionRecord(JSON.stringify(CAPTURE_54611_2_1_232));
    assert.equal(r2.pid, 54611);
    assert.equal(r2.status, "idle");

    const r3 = parseSessionRecord(JSON.stringify(CAPTURE_63004_2_1_233));
    assert.equal(r3.pid, 63004);
    assert.equal(r3.status, "busy");
  });

  it("ignores unknown extra keys (messagingSocketPath, peerProtocol, nameSource, ...)", () => {
    const r = parseSessionRecord(JSON.stringify(CAPTURE_63004_2_1_233));
    assert.deepEqual(Object.keys(r).sort(), [
      "cwd", "kind", "name", "pid", "sessionId", "status", "statusUpdatedAt", "version", "waitingFor",
    ].sort());
  });

  it("requires a numeric pid — the one truly load-bearing field", () => {
    assert.equal(parseSessionRecord(JSON.stringify({ status: "busy" })), null);
    assert.equal(parseSessionRecord(JSON.stringify({ pid: "4477" })), null);
  });

  it("returns null on invalid JSON rather than throwing", () => {
    assert.equal(parseSessionRecord("{not valid json"), null);
  });

  it("returns null for JSON that isn't an object", () => {
    assert.equal(parseSessionRecord("42"), null);
    assert.equal(parseSessionRecord("null"), null);
    assert.equal(parseSessionRecord("[1,2,3]"), null);
  });
});

describe("labelFor", () => {
  it("prefers name, then basename(cwd), then `pid N`", () => {
    assert.equal(labelFor({ pid: 1, name: "my-session", cwd: "/a/b/c" }), "my-session");
    assert.equal(labelFor({ pid: 1, cwd: "/Users/x/Documents/patitas" }), "patitas");
    assert.equal(labelFor({ pid: 4477 }), "pid 4477");
  });
});

describe("parsePsTable", () => {
  const OUTPUT = [
    "  4477 Wed Aug 13 08:23:10 2026 claude",
    "   501 Fri Aug 14 09:12:00 2026 /Applications/Claude.app/Contents/MacOS/Claude",
    "   777 Fri Aug 14 09:12:01 2026 Claude Helper (Renderer)",
    " 63004 Sat Aug 15 03:50:09 2026 claude",
    "",
  ].join("\n");

  it("parses pid and comm, joining a multi-word comm back together", () => {
    const table = parsePsTable(OUTPUT);
    assert.equal(table.get(4477), "claude");
    assert.equal(table.get(501), "/Applications/Claude.app/Contents/MacOS/Claude");
    assert.equal(table.get(777), "Claude Helper (Renderer)");
    assert.equal(table.get(63004), "claude");
  });

  it("claudePidsFromTable matches only the bare 'claude' comm, exactly", () => {
    const live = claudePidsFromTable(parsePsTable(OUTPUT));
    assert.deepEqual([...live].sort((a, b) => a - b), [4477, 63004]);
    // A case-insensitive or substring match would wrongly pull these in.
    assert.equal(live.has(501), false);
    assert.equal(live.has(777), false);
  });

  it("ignores blank lines and lines that are too short to have a comm", () => {
    const table = parsePsTable("\n   \n42 Sat Aug 15 03:50:09 2026\n");
    assert.equal(table.size, 0);
  });
});

describe("isAliveErrorCode (process.kill fallback when ps is unavailable)", () => {
  it("treats EPERM as alive — the process exists, we're just not allowed to signal it", () => {
    assert.equal(isAliveErrorCode("EPERM"), true);
  });

  it("treats ESRCH as dead — no such process", () => {
    assert.equal(isAliveErrorCode("ESRCH"), false);
  });

  it("treats an unfamiliar errno as alive, so a weird code can't disappear a live session", () => {
    assert.equal(isAliveErrorCode("EINVAL"), true);
    assert.equal(isAliveErrorCode(undefined), true);
  });
});

describe("corroborationVerdict — all five rows", () => {
  it("no registry files, no live claude pids -> ok (honest zero)", () => {
    assert.equal(corroborationVerdict([], new Set(), true), "ok");
  });

  it("no registry files, live claude pids exist -> no-registry", () => {
    assert.equal(corroborationVerdict([], new Set([123]), true), "no-registry");
  });

  it("registry files exist, zero overlap with live pids, live pids exist -> no-registry", () => {
    assert.equal(corroborationVerdict([1, 2], new Set([999]), true), "no-registry");
  });

  it("registry files exist, at least one overlaps with live pids -> ok", () => {
    assert.equal(corroborationVerdict([1, 2], new Set([1, 999]), true), "ok");
  });

  it("ps unavailable -> ok, corroboration skipped regardless of anything else", () => {
    assert.equal(corroborationVerdict([1, 2], new Set(), false), "ok");
    assert.equal(corroborationVerdict([], new Set([1]), false), "ok");
  });

  it("a session that started 200ms ago (registry has it, ps hasn't caught up) doesn't flap: any overlap is enough", () => {
    assert.equal(corroborationVerdict([1, 2, 3], new Set([3]), true), "ok");
  });
});

describe("buildSnapshot", () => {
  it("counts only live, interactive-or-missing-kind sessions, and ranks waiting > processing > unknown > idle", () => {
    const live = new Set([1, 2, 3, 4, 5, 6]);
    const records = [
      { pid: 1, name: "idle-old", status: "idle", statusUpdatedAt: 100 },
      { pid: 2, name: "waiting-recent", status: "waiting", waitingFor: "permission", statusUpdatedAt: 500 },
      { pid: 3, name: "waiting-oldest", status: "waiting", waitingFor: "tool-approval", statusUpdatedAt: 200 },
      { pid: 4, name: "processing-one", status: "busy", statusUpdatedAt: 300 },
      { pid: 5, name: "unknown-one", status: "compacting", version: "9.9.9", statusUpdatedAt: 400 },
      // dead pid: registry file lingering after exit, must not be counted anywhere
      { pid: 999, name: "dead", status: "busy", statusUpdatedAt: 1 },
      // non-interactive kind: a worker, must not be counted anywhere
      { pid: 6, name: "worker", status: "busy", kind: "daemon-worker", statusUpdatedAt: 1 },
    ];

    const snapshot = buildSnapshot(records, live, /* staleFiles */ 2);

    assert.equal(snapshot.waiting, 2);
    assert.equal(snapshot.processing, 1);
    assert.equal(snapshot.idle, 1);
    assert.equal(snapshot.unknown, 1);
    assert.equal(snapshot.liveTotal, 5);
    assert.equal(snapshot.staleFiles, 2);
    assert.deepEqual(snapshot.unknownStatuses, ["compacting"]);
    assert.equal(snapshot.version, "9.9.9");

    assert.deepEqual(
      snapshot.ranked.map((r) => r.label),
      ["waiting-oldest", "waiting-recent", "processing-one", "unknown-one", "idle-old"],
    );
    assert.equal(snapshot.ranked[0].detail, "tool-approval");
    assert.equal(snapshot.ranked[1].detail, "permission");
    assert.equal(snapshot.ranked[3].detail, "compacting");
    assert.equal(snapshot.ranked[4].detail, undefined);
  });

  it("sorts a tie within a bucket by statusUpdatedAt ascending, with missing timestamps last", () => {
    const live = new Set([1, 2, 3]);
    const records = [
      { pid: 1, name: "b", status: "idle", statusUpdatedAt: 200 },
      { pid: 2, name: "a", status: "idle", statusUpdatedAt: 100 },
      { pid: 3, name: "c", status: "idle" }, // no timestamp at all
    ];
    const snapshot = buildSnapshot(records, live, 0);
    assert.deepEqual(snapshot.ranked.map((r) => r.label), ["a", "b", "c"]);
  });
});

describe("readSessions — end to end against a real temp directory", () => {
  it("counts a real capture as live using only ps's comm, never procStart (the measured UTC-vs-local landmine)", () =>
    withTmpDir(async (dir) => {
      writeFileSync(join(dir, "4477.json"), JSON.stringify(CAPTURE_4477_2_1_229));
      // procStart above is UTC ("Wed Aug 12 23:08:23 2026"); this ps line is
      // the same real pid's *local*-time lstart rendering, a full calendar
      // day later ("Sat Aug 15 03:50:09 2026") — measured on the same
      // machine, same process. If liveness ever compared procStart to this
      // string, it would never match and the session would vanish.
      const runPs = async () => "  4477 Sat Aug 15 03:50:09 2026 claude\n";

      const state = await readSessions({ sessionsDir: dir, runPs });
      assert.equal(state.status, "ok");
      assert.equal(state.snapshot.liveTotal, 1);
      assert.equal(state.snapshot.processing, 1); // status: "busy"
      assert.equal(state.snapshot.staleFiles, 0);
    }));

  it("treats an honest empty directory as ok, not a problem", () =>
    withTmpDir(async (dir) => {
      const state = await readSessions({ sessionsDir: dir, runPs: async () => "" });
      assert.equal(state.status, "ok");
      assert.equal(state.snapshot.liveTotal, 0);
    }));

  it("treats a missing ~/.claude/sessions directory the same as empty", async () => {
    const missing = join(tmpdir(), "sessions-test-does-not-exist-" + Date.now());
    const state = await readSessions({ sessionsDir: missing, runPs: async () => "" });
    assert.equal(state.status, "ok");
    assert.equal(state.snapshot.liveTotal, 0);
  });

  it("filters .key files out — they are never even attempted as JSON", () =>
    withTmpDir(async (dir) => {
      writeFileSync(join(dir, "4477.json"), JSON.stringify(CAPTURE_4477_2_1_229));
      writeFileSync(join(dir, "4477.deadbeef.key"), "this is not json at all");
      const runPs = async () => "  4477 Wed Aug 13 08:23:10 2026 claude\n";

      const state = await readSessions({ sessionsDir: dir, runPs });
      assert.equal(state.status, "ok");
      assert.equal(state.snapshot.liveTotal, 1);
      assert.equal(state.snapshot.ranked.length, 1);
    }));

  it("reports no-registry when live claude pids exist but nothing in the registry overlaps", () =>
    withTmpDir(async (dir) => {
      // A registry entry for a pid that is not (or no longer) live...
      writeFileSync(join(dir, "1.json"), JSON.stringify({ pid: 1, status: "idle" }));
      // ...while a real claude process is running under a completely
      // different pid the registry knows nothing about.
      const runPs = async () => "  9999 Wed Aug 13 08:23:10 2026 claude\n";

      const state = await readSessions({ sessionsDir: dir, runPs });
      assert.equal(state.status, "fail");
      assert.equal(state.problem.kind, "no-registry");
    }));

  it("hysteresis: one torn read doesn't fail the read; the same unchanged file failing again escalates; a rewrite resets it", () =>
    withTmpDir(async (dir) => {
      const path = join(dir, "9001.json");
      writeFileSync(path, "{not valid json");
      const runPs = async () => "  9001 Wed Aug 13 08:23:10 2026 claude\n";

      // First read: parse fails, gets one immediate retry (also fails),
      // hysteresis remembers the (mtime, size) tuple but does not fail the
      // overall read — an occasional torn read is expected, not an error.
      const first = await readSessions({ sessionsDir: dir, runPs });
      assert.equal(first.status, "ok");
      assert.equal(first.snapshot.liveTotal, 0);

      // Second read: file untouched since the first read, so mtime/size are
      // identical to the remembered tuple — now it escalates.
      const second = await readSessions({ sessionsDir: dir, runPs });
      assert.equal(second.status, "fail");
      assert.equal(second.problem.kind, "unreadable");

      // Rewrite the file (still invalid, but a real write bumps mtime/size
      // bookkeeping) — this must reset the hysteresis rather than compound it.
      await new Promise((r) => setTimeout(r, 5));
      writeFileSync(path, "{also not valid json, but different length}");
      const third = await readSessions({ sessionsDir: dir, runPs });
      assert.equal(third.status, "ok");

      // And now two more unchanged reads in a row escalate again.
      const fourth = await readSessions({ sessionsDir: dir, runPs });
      assert.equal(fourth.status, "fail");
      assert.equal(fourth.problem.kind, "unreadable");
    }));

  it("a torn read that recovers on its immediate retry is used normally, not remembered", () =>
    withTmpDir(async (dir) => {
      const path = join(dir, "4477.json");
      // Valid JSON from the start; nothing torn about this one. This just
      // confirms the ordinary success path leaves no hysteresis residue by
      // reading it twice in a row and expecting "ok" both times.
      writeFileSync(path, JSON.stringify(CAPTURE_4477_2_1_229));
      const runPs = async () => "  4477 Wed Aug 13 08:23:10 2026 claude\n";

      const first = await readSessions({ sessionsDir: dir, runPs });
      assert.equal(first.status, "ok");
      const second = await readSessions({ sessionsDir: dir, runPs });
      assert.equal(second.status, "ok");
    }));

  it("falls back to process.kill liveness and skips corroboration when ps itself fails", () =>
    withTmpDir(async (dir) => {
      writeFileSync(join(dir, String(process.pid) + ".json"), JSON.stringify({ pid: process.pid, status: "busy" }));
      const runPs = async () => {
        throw new Error("ps: command not found");
      };
      const state = await readSessions({ sessionsDir: dir, runPs });
      // process.pid (this test process) is always alive, and EPERM/ESRCH
      // resolution is exercised directly in the isAliveErrorCode tests
      // above; here we only need corroboration to have been skipped rather
      // than misfiring "no-registry" just because ps failed.
      assert.equal(state.status, "ok");
      assert.equal(state.snapshot.liveTotal, 1);
    }));
});

describe("SessionsStore", () => {
  function fakeReader(fn) {
    return fn;
  }

  it("never carries a lastGood snapshot into the fail state — the type has nowhere to put one", async () => {
    const store = new SessionsStore(fakeReader(async () => ({
      status: "fail",
      problem: { kind: "unreadable", message: "boom" },
    })));
    let latest;
    const unsubscribe = store.subscribe((s) => { latest = s; });
    await waitFor(() => latest?.status === "fail");
    assert.deepEqual(Object.keys(latest).sort(), ["problem", "status"]);
    unsubscribe();
  });

  it("requires two consecutive no-registry reads before publishing the fail state", async () => {
    let call = 0;
    const store = new SessionsStore(fakeReader(async () => {
      call++;
      return { status: "fail", problem: { kind: "no-registry", message: "no-registry seen" } };
    }));
    let latest;
    const unsubscribe = store.subscribe((s) => { latest = s; });

    await waitFor(() => call >= 1);
    await new Promise((r) => setTimeout(r, 20));
    // One no-registry read in: must not have surfaced as a fail yet.
    assert.notEqual(latest?.status, "fail");

    store.refreshNow();
    await waitFor(() => latest?.status === "fail");
    assert.equal(latest.problem.kind, "no-registry");
    unsubscribe();
  });

  it("a single no-registry read followed by a good read never surfaces — the streak resets, not accumulates", async () => {
    let call = 0;
    const store = new SessionsStore(fakeReader(async () => {
      call++;
      if (call === 2) {
        return { status: "ok", snapshot: { waiting: 0, processing: 0, idle: 0, unknown: 0, liveTotal: 0, staleFiles: 0, ranked: [], unknownStatuses: [] } };
      }
      return { status: "fail", problem: { kind: "no-registry", message: "flaky" } };
    }));
    let latest;
    const unsubscribe = store.subscribe((s) => { latest = s; });
    await waitFor(() => call >= 1);
    // Let call 1's in-flight poll fully settle (including its `.finally`
    // clearing `inFlight`) before forcing another — a refreshNow() landing
    // while a poll is still in flight is silently dropped, the same hazard
    // documented in store.test.js's own no-registry-adjacent tests.
    await new Promise((r) => setTimeout(r, 20));

    store.refreshNow();
    await waitFor(() => latest?.status === "ok");
    await new Promise((r) => setTimeout(r, 20));

    store.refreshNow(); // 3rd call: no-registry again, but streak was reset by the ok read
    await waitFor(() => call >= 3);
    await new Promise((r) => setTimeout(r, 20));
    assert.notEqual(latest?.status, "fail");
    unsubscribe();
  });

  it("dedupes onProblem by message and re-arms after a recovery", async () => {
    let call = 0;
    const store = new SessionsStore(fakeReader(async () => {
      call++;
      if (call === 3) {
        return { status: "ok", snapshot: { waiting: 0, processing: 0, idle: 0, unknown: 0, liveTotal: 0, staleFiles: 0, ranked: [], unknownStatuses: [] } };
      }
      return { status: "fail", problem: { kind: "unreadable", message: "boom" } };
    }));
    const logged = [];
    store.onProblem = (p) => logged.push(p.message);
    let latest;
    const unsubscribe = store.subscribe((s) => { latest = s; });

    await waitFor(() => latest?.status === "fail");
    store.refreshNow(); // still failing with the same message: no new log line
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(logged, ["boom"]);

    store.refreshNow(); // recovers
    await waitFor(() => latest?.status === "ok");

    store.refreshNow(); // fails again with the same message as before recovery
    await waitFor(() => latest?.status === "fail");
    assert.deepEqual(logged, ["boom", "boom"]);
    unsubscribe();
  });

  it("stops polling once the last subscriber unsubscribes", async () => {
    let call = 0;
    const store = new SessionsStore(fakeReader(async () => {
      call++;
      return { status: "ok", snapshot: { waiting: 0, processing: 0, idle: 0, unknown: 0, liveTotal: 0, staleFiles: 0, ranked: [], unknownStatuses: [] } };
    }));
    const unsubA = store.subscribe(() => {});
    const unsubB = store.subscribe(() => {});
    await waitFor(() => call >= 1);
    unsubA();
    unsubB();
    const countAtUnsubscribe = call;
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(call, countAtUnsubscribe);
  });

  it("never throws when onProblem is left unset", async () => {
    const store = new SessionsStore(fakeReader(async () => ({
      status: "fail",
      problem: { kind: "unreadable", message: "boom" },
    })));
    let sawFail = false;
    const unsubscribe = store.subscribe((s) => { if (s.status === "fail") sawFail = true; });
    await waitFor(() => sawFail);
    unsubscribe();
  });
});
