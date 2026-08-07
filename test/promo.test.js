import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BOOST_NOTICE_WITHIN_DAYS, WEEKLY_BOOST_ENDS_AT, boostNotice } from "../.build/lib/promo.js";

describe("boostNotice", () => {
  it("returns null after WEEKLY_BOOST_ENDS_AT", () => {
    assert.equal(boostNotice(WEEKLY_BOOST_ENDS_AT), null);
    assert.equal(boostNotice(new Date(WEEKLY_BOOST_ENDS_AT.getTime() + 1)), null);
  });

  it("returns null when more than 14 days before it", () => {
    const tooEarly = new Date(
      WEEKLY_BOOST_ENDS_AT.getTime() - (BOOST_NOTICE_WITHIN_DAYS + 1) * 24 * 60 * 60 * 1000,
    );
    assert.equal(boostNotice(tooEarly), null);
  });

  it("returns a non-null string containing '+50%' inside the window", () => {
    const twelveDaysBefore = new Date(WEEKLY_BOOST_ENDS_AT.getTime() - 12 * 24 * 60 * 60 * 1000);
    const notice = boostNotice(twelveDaysBefore);
    assert.notEqual(notice, null);
    assert.match(notice, /\+50%/);
    assert.match(notice, /12d/);

    const twentyHoursBefore = new Date(WEEKLY_BOOST_ENDS_AT.getTime() - 20 * 60 * 60 * 1000);
    const hourNotice = boostNotice(twentyHoursBefore);
    assert.match(hourNotice, /\+50%/);
    assert.match(hourNotice, /20h/);
  });
});
