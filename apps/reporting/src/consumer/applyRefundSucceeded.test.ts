/**
 * FP-212 step 6: refund.succeeded in the daily rollup. Requires DATABASE_URL
 * to point at a real, migrated Postgres (0082 adds the refund columns).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { withTransaction } from "../db/withTransaction.js";
import { applyEvent } from "./applyEvent.js";
import { REPORTING_EVENT_TYPES } from "./runConsumerPass.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("applyRefundSucceeded.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}
const pool = new Pool({ connectionString: databaseUrl, max: 3 });
test.after(async () => {
  await pool.end();
});

async function createMerchant(): Promise<string> {
  const r = await pool.query<{ id: string }>(`INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 225) RETURNING id`, [
    `FP-212 reporting ${randomUUID()}`,
  ]);
  return r.rows[0]!.id;
}

function refundRow(merchantId: string, createdAt: Date, amountFils: number, feeReversedFils: number) {
  return {
    id: 1,
    event_type: "refund.succeeded",
    aggregate_id: randomUUID(),
    payload: { merchantId, refundId: randomUUID(), amountFils, feeReversedFils, refundedTotalFils: amountFils },
    created_at: createdAt,
  };
}

test("the consumer selects refund.succeeded", () => {
  assert.ok(REPORTING_EVENT_TYPES.includes("refund.succeeded"));
});

test("refunds roll up into merchant_daily_volume on the Asia/Bahrain date", async () => {
  const merchantId = await createMerchant();
  // 2026-10-29T22:30Z is 01:30 on 2026-10-30 in Bahrain: the UTC date
  // (toISOString().slice(0,10)) would have filed it under the 29th.
  const at = new Date("2026-10-29T22:30:00.000Z");
  await withTransaction(pool, async (client) => {
    await applyEvent(client, refundRow(merchantId, at, 2_000, 45));
    await applyEvent(client, refundRow(merchantId, at, 4_000, 90));
  });
  const r = await pool.query<{ volume_date: string; refund_count: number; refund_gross_fils: string; refund_fee_reversed_fils: string }>(
    `SELECT volume_date::text, refund_count, refund_gross_fils::text, refund_fee_reversed_fils::text
       FROM merchant_daily_volume WHERE merchant_id = $1`,
    [merchantId],
  );
  assert.deepEqual(r.rows, [
    { volume_date: "2026-10-30", refund_count: 2, refund_gross_fils: "6000", refund_fee_reversed_fils: "135" },
  ]);
});
