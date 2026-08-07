import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { hasUsageHeaders, parsePct, parseReset } from "../.build/lib/usage.js";

describe("parsePct", () => {
  it("scales the documented 0..1 fraction to a percentage", () => {
    assert.equal(parsePct("0.42"), 42);
    assert.equal(parsePct("0"), 0);
    assert.equal(parsePct("1"), 100);
  });

  it("passes through values that are already percentages", () => {
    // Values above 1 have been observed; multiplying them would be nonsense.
    assert.equal(parsePct("87"), 87);
    assert.equal(parsePct("100"), 100);
  });

  it("clamps beyond 100", () => {
    assert.equal(parsePct("140"), 100);
  });

  it("treats a missing or unparseable header as zero", () => {
    assert.equal(parsePct(null), 0);
    assert.equal(parsePct("n/a"), 0);
    assert.equal(parsePct(""), 0);
  });
});

describe("parseReset", () => {
  it("parses ISO-8601", () => {
    const d = parseReset("2026-08-07T20:00:00Z");
    assert.equal(d?.toISOString(), "2026-08-07T20:00:00.000Z");
  });

  it("falls back to Unix seconds", () => {
    const d = parseReset("1786060800");
    assert.equal(d?.getTime(), 1786060800 * 1000);
  });

  it("returns null for missing or junk values", () => {
    assert.equal(parseReset(null), null);
    assert.equal(parseReset(""), null);
    assert.equal(parseReset("soon"), null);
  });
});

describe("hasUsageHeaders", () => {
  const withHeaders = (obj) => ({ headers: new Headers(obj) });

  it("is true when either window reports utilisation", () => {
    assert.equal(
      hasUsageHeaders(withHeaders({ "anthropic-ratelimit-unified-5h-utilization": "0.1" })),
      true,
    );
    assert.equal(
      hasUsageHeaders(withHeaders({ "anthropic-ratelimit-unified-7d-utilization": "0.1" })),
      true,
    );
  });

  it("is false when the response carries neither", () => {
    assert.equal(hasUsageHeaders(withHeaders({ "content-type": "application/json" })), false);
  });
});
