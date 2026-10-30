import assert from "node:assert/strict";
import { test } from "node:test";
import { computeResidueFils, monthBounds } from "./reconcile_march.js";

test("computeResidueFils returns the amount lost to 2dp quantization", () => {
  assert.equal(computeResidueFils(4750), 0);
  assert.equal(computeResidueFils(4759), 9);
  assert.equal(computeResidueFils(10), 0);
  assert.equal(computeResidueFils(1), 1);
  assert.equal(computeResidueFils(0), 0);
});

test("monthBounds for March 2026 spans 31 days", () => {
  const { start, end } = monthBounds(2026, 3);
  const days = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
  assert.equal(days, 31);
});

// Was: start/end asserted to fall in UTC March/April, which pinned the bug.
// The settlement month is Asia/Bahrain (UTC+3): March 1 00:00 Bahrain is
// Feb 28 21:00 UTC.
test("monthBounds uses Asia/Bahrain midnights, not UTC midnights", () => {
  const { start, end } = monthBounds(2026, 3);
  assert.equal(start.toISOString(), "2026-02-28T21:00:00.000Z");
  assert.equal(end.toISOString(), "2026-03-31T21:00:00.000Z");
});
