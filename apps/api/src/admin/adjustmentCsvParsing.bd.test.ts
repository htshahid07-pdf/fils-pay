/**
 * Regression tests for "CSV import: I uploaded 4.755 BD and the ledger shows
 * 4.750; I uploaded 4.75 BD and it shows 0.475". Amounts are BD with three
 * decimals; 1 BD = 1000 fils (ADR-0001).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAdjustmentAmountFils } from "./adjustmentCsvParsing.js";

test("BD amounts parse to fils at 3 decimal places", () => {
  assert.equal(parseAdjustmentAmountFils("4.755"), 4755);
  assert.equal(parseAdjustmentAmountFils("4.750"), 4750);
  assert.equal(parseAdjustmentAmountFils("4.75"), 4750);
  assert.equal(parseAdjustmentAmountFils("4.7"), 4700);
  assert.equal(parseAdjustmentAmountFils("12"), 12000);
  assert.equal(parseAdjustmentAmountFils("0.001"), 1);
});

test("negative corrections keep their sign", () => {
  assert.equal(parseAdjustmentAmountFils("-1.250"), -1250);
  assert.equal(parseAdjustmentAmountFils("-3.5"), -3500);
});

test("a 4th decimal is rejected, never silently truncated", () => {
  assert.throws(() => parseAdjustmentAmountFils("4.7555"), /could not parse amount/);
});
