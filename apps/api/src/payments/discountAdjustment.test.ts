/**
 * Tests for the negotiated-discount capture adjustment, against a real,
 * migrated Postgres (no DB mocking) — same as transactions.test.ts and
 * settlement.test.ts.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { applyCaptureDiscountAdjustment } from "./discountAdjustment.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "discountAdjustment.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `npm run migrate` first)",
  );
}

const pool = new Pool({ connectionString: databaseUrl, max: 5 });

test.after(async () => {
  await pool.end();
});

async function seedCapturedTransaction(opts: {
  mdrBps: number;
  discountBps: number;
  capturedFils: number;
  feeFils: number;
}): Promise<{ merchantId: string; transactionId: string }> {
  const merchantResult = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, negotiated_discount_bps)
     VALUES ($1, $2, $3) RETURNING id`,
    [`Discount Test ${randomUUID()}`, opts.mdrBps, opts.discountBps],
  );
  const merchantId = merchantResult.rows[0]!.id;

  const txnResult = await pool.query<{ id: string }>(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference)
     VALUES ($1, 'captured', $2, $2, $3) RETURNING id`,
    [merchantId, opts.capturedFils, `acq_${randomUUID()}`],
  );
  const transactionId = txnResult.rows[0]!.id;

  await pool.query(
    `INSERT INTO transaction_events (transaction_id, event_type, amount_fils, actor_type, metadata)
     VALUES ($1, 'captured', $2, 'system', $3)`,
    [transactionId, opts.capturedFils, JSON.stringify({ feeFils: opts.feeFils })],
  );

  return { merchantId, transactionId };
}

async function adjustmentLegs(transactionId: string): Promise<Array<{ account_id: string; direction: string; amount_fils: string }>> {
  const result = await pool.query<{ account_id: string; direction: string; amount_fils: string }>(
    `SELECT account_id, direction, amount_fils FROM ledger_entries
      WHERE transaction_id = $1 AND description = 'capture: negotiated discount adjustment'
      ORDER BY account_id`,
    [transactionId],
  );
  return result.rows;
}

/** Settlement's order (discount off the amount, then MDR): 602 fils @ 275 bps = 17 fils charged; the net fee is 14, so the rebate is 3. */
test("posts a rebate leg pair that brings the fee down to settlement's discounted fee", async () => {
  // 602 fils captured at 275bps MDR charges 17 fils. Settlement charges MDR
  // on the discounted amount: 602 - 75 = 527 fils, 527 * 2.75% = 14 fils
  // (TestComputeSettlementFee pins the same 14). The rebate is 17 - 14 = 3.
  // It used to be 12.5% of the fee (2 fils, net 15), so ledger and payout
  // disagreed by a fil.
  const { merchantId, transactionId } = await seedCapturedTransaction({
    mdrBps: 275,
    discountBps: 1250,
    capturedFils: 602,
    feeFils: 17,
  });

  await applyCaptureDiscountAdjustment(pool, { merchantId, transactionId });

  const legs = await adjustmentLegs(transactionId);
  assert.deepEqual(legs, [
    { account_id: "merchant_payable", direction: "credit", amount_fils: "3" },
    { account_id: "platform_fee_revenue", direction: "debit", amount_fils: "3" },
  ]);
});

test("a merchant with no negotiated discount produces no rows at all", async () => {
  const { merchantId, transactionId } = await seedCapturedTransaction({
    mdrBps: 275,
    discountBps: 0,
    capturedFils: 602,
    feeFils: 17,
  });

  await applyCaptureDiscountAdjustment(pool, { merchantId, transactionId });

  assert.deepEqual(await adjustmentLegs(transactionId), []);
});

test("a fee that rounds the discount down to zero posts nothing", async () => {
  // 250 fils @ 275bps charges 7 fils. With a 1% discount, settlement charges
  // MDR on 250 - 2 = 248 fils, which is still 7 fils, so the rebate is 0 —
  // ledger_entries has a CHECK (amount_fils > 0), so no leg is written.
  const { merchantId, transactionId } = await seedCapturedTransaction({
    mdrBps: 275,
    discountBps: 100,
    capturedFils: 250,
    feeFils: 7,
  });

  await applyCaptureDiscountAdjustment(pool, { merchantId, transactionId });

  assert.deepEqual(await adjustmentLegs(transactionId), []);
});

// this is the FP-219 regression test — FH
test("re-running against the same capture event does not rebate the fee twice", async () => {
  const { merchantId, transactionId } = await seedCapturedTransaction({
    mdrBps: 275,
    discountBps: 1250,
    capturedFils: 602,
    feeFils: 17,
  });

  await applyCaptureDiscountAdjustment(pool, { merchantId, transactionId });
  await applyCaptureDiscountAdjustment(pool, { merchantId, transactionId });

  assert.equal((await adjustmentLegs(transactionId)).length, 2);
});
