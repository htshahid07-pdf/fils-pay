/**
 * FP-212 refund tests against a real, migrated Postgres. No HTTP layer:
 * these drive authorize/capture/refund through the same business functions
 * the routes call, so they run without the web framework. Route-level
 * behaviour (400 without Idempotency-Key, 404 cross-merchant over HTTP) is
 * in routes/refunds.test.ts.
 *
 * Requires DATABASE_URL (run `npm run migrate` first).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { toFils } from "@filspay/money";
import { createAcquirerSimulator } from "../acquirer/simulator.js";
import { authorizeTransaction } from "./authorize.js";
import { captureTransaction } from "./capture.js";
import { applyCaptureDiscountAdjustment } from "./discountAdjustment.js";
import { processRefund } from "./processRefund.js";
import { initiateMerchantRefund } from "../refunds/initiateMerchantRefund.js";
import { getReconciliationReport } from "../settlement/query.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("processRefund.fp212.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}
const pool = new Pool({ connectionString: databaseUrl, max: 10 });
test.after(async () => {
  await pool.end();
});

// A little latency so concurrent refunds really overlap inside the acquirer call.
const acquirer = createAcquirerSimulator({
  acquirerLatencyMinMs: 5,
  acquirerLatencyMaxMs: 15,
  acquirerFailureRate: 0,
  acquirerRngSeed: 212,
});
const CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };
const actor = { type: "merchant_api_key" as const, id: randomUUID() };

async function merchant(mdrBps: number, opts: { discountBps?: number; refundsEnabled?: boolean | null } = {}) {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, negotiated_discount_bps, status, onboarding_status, refunds_enabled)
     VALUES ($1, $2, $3, 'active', 'approved', $4) RETURNING id`,
    [`FP-212 ${randomUUID().slice(0, 8)}`, mdrBps, opts.discountBps ?? 0, opts.refundsEnabled ?? null],
  );
  return r.rows[0]!.id;
}

async function captured(merchantId: string, authFils: number, captureFils?: number): Promise<string> {
  const a = await authorizeTransaction(pool, acquirer, {
    merchantId,
    amountFils: toFils(authFils),
    card: CARD,
    idempotencyKey: randomUUID(),
    actor,
  });
  assert.equal(a.statusCode, 201, JSON.stringify(a.body));
  const id = (a.body as { id: string }).id;
  const c = await captureTransaction(pool, acquirer, {
    transactionId: id,
    merchantId,
    idempotencyKey: randomUUID(),
    actor,
    ...(captureFils === undefined ? {} : { amountFils: toFils(captureFils) }),
  });
  assert.equal(c.statusCode, 200, JSON.stringify(c.body));
  await applyCaptureDiscountAdjustment(pool, { merchantId, transactionId: id });
  return id;
}

function refund(merchantId: string, transactionId: string, amountFils?: number, idempotencyKey = randomUUID()) {
  return initiateMerchantRefund(pool, acquirer, {
    merchantId,
    transactionId,
    amountFils: amountFils === undefined ? undefined : toFils(amountFils),
    idempotencyKey,
    actor,
  });
}

async function catching(p: Promise<unknown>): Promise<{ statusCode: number; code: string }> {
  try {
    await p;
  } catch (err) {
    const e = err as { statusCode?: number; code?: string };
    return { statusCode: e.statusCode ?? 500, code: e.code ?? String(err) };
  }
  throw new Error("expected a thrown error");
}

async function feeRevenue(transactionId: string) {
  const r = await pool.query<{ credit: string; debit: string }>(
    `SELECT COALESCE(SUM(amount_fils) FILTER (WHERE direction = 'credit'), 0)::text AS credit,
            COALESCE(SUM(amount_fils) FILTER (WHERE direction = 'debit'), 0)::text AS debit
       FROM ledger_entries WHERE transaction_id = $1 AND account_id = 'platform_fee_revenue'`,
    [transactionId],
  );
  return { credit: Number(r.rows[0]!.credit), debit: Number(r.rows[0]!.debit) };
}

async function assertEveryGroupBalances(transactionId: string) {
  const r = await pool.query<{ entry_group_id: string; diff: string }>(
    `SELECT entry_group_id,
            SUM(CASE WHEN direction = 'debit' THEN amount_fils ELSE -amount_fils END)::text AS diff
       FROM ledger_entries WHERE transaction_id = $1 GROUP BY entry_group_id`,
    [transactionId],
  );
  assert.ok(r.rows.length > 0);
  for (const row of r.rows) assert.equal(Number(row.diff), 0, `entry group ${row.entry_group_id} unbalanced`);
}

/** Today and tomorrow as Asia/Bahrain calendar dates (UTC+3, no DST). */
function bahrainToday(): { from: string; to: string } {
  const now = new Date(Date.now() + 3 * 3600_000);
  const from = now.toISOString().slice(0, 10);
  const to = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);
  return { from, to };
}

test("§3.5 Alpha Retail end to end: over-refund, partial, cross-merchant, rest, then nothing left", async () => {
  const alpha = await merchant(225);
  const beta = await merchant(225);
  const txn = await captured(alpha, 10_000, 6_000);
  assert.equal((await feeRevenue(txn)).credit, 135);

  const over = await refund(alpha, txn, 9_000);
  assert.equal(over.statusCode, 422);
  assert.deepEqual(over.body, { ok: false, code: "refund_exceeds_refundable", refundableFils: 6_000 });

  const first = await refund(alpha, txn, 2_000);
  assert.equal(first.statusCode, 200, JSON.stringify(first.body));
  const b1 = first.body as Record<string, unknown>;
  assert.equal(b1.feeReversedFils, 45);
  assert.equal(b1.refundedTotalFils, 2_000);
  assert.equal(b1.transactionStatus, "partially_captured"); // captured < authorised

  const cross = await catching(refund(beta, txn, 100));
  assert.deepEqual(cross, { statusCode: 404, code: "transaction_not_found" });

  const rest = await refund(alpha, txn);
  assert.equal(rest.statusCode, 200, JSON.stringify(rest.body));
  const b2 = rest.body as Record<string, unknown>;
  assert.equal(b2.amountFils, 4_000);
  assert.equal(b2.feeReversedFils, 90);
  assert.equal(b2.transactionStatus, "refunded");

  const again = await refund(alpha, txn, 1);
  assert.equal(again.statusCode, 409);
  assert.equal((again.body as { code: string }).code, "transaction_not_refundable");

  assert.deepEqual(await feeRevenue(txn), { credit: 135, debit: 135 });
  await assertEveryGroupBalances(txn);
  const refunds = await pool.query(`SELECT 1 FROM refunds WHERE merchant_id = $1`, [beta]);
  assert.equal(refunds.rowCount, 0, "a cross-merchant attempt must not create a refunds row");

  const events = await pool.query<{ event_type: string; amount_fils: string }>(
    `SELECT event_type, amount_fils::text FROM transaction_events
      WHERE transaction_id = $1 AND event_type IN ('refund_partial', 'refunded') ORDER BY id`,
    [txn],
  );
  assert.deepEqual(
    events.rows.map((e) => [e.event_type, Number(e.amount_fils)]),
    [
      ["refund_partial", -2_000],
      ["refunded", -4_000],
    ],
  );
});

test("§3.2 cumulative fee reversal: captured 1000, fee 5, refunds 300/300/400 reverse 2/1/2 = 5", async () => {
  const m = await merchant(50); // 0.50% of 1000 = 5 fils
  const txn = await captured(m, 1_000);
  assert.equal((await feeRevenue(txn)).credit, 5);
  const reversed: number[] = [];
  for (const amount of [300, 300, 400]) {
    const r = await refund(m, txn, amount);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    reversed.push((r.body as { feeReversedFils: number }).feeReversedFils);
  }
  assert.deepEqual(reversed, [2, 1, 2]);
  assert.deepEqual(await feeRevenue(txn), { credit: 5, debit: 5 });
  await assertEveryGroupBalances(txn);
});

test("discounted merchant: reversal is based on the NET fee, never the gross MDR", async () => {
  // 2.50% of 10000 = 250; 20% negotiated discount gives 50 back at capture: net fee 200.
  const m = await merchant(250, { discountBps: 2_000 });
  const txn = await captured(m, 10_000);
  const before = await feeRevenue(txn);
  assert.equal(before.credit - before.debit, 200);

  let total = 0;
  for (const amount of [3_333, 3_333, 3_334]) {
    const r = await refund(m, txn, amount);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    total += (r.body as { feeReversedFils: number }).feeReversedFils;
  }
  assert.equal(total, 200, "credits-only would have reversed 250: 50 fils of fee never charged");
  const after = await feeRevenue(txn);
  assert.equal(after.credit - after.debit, 0);
  await assertEveryGroupBalances(txn);
});

test("refunds on hold -> 403 refunds_on_hold; NULL (no hold) is allowed", async () => {
  const held = await merchant(225, { refundsEnabled: false });
  const txn = await captured(held, 1_000);
  assert.deepEqual(await catching(refund(held, txn)), { statusCode: 403, code: "refunds_on_hold" });

  const open = await merchant(225, { refundsEnabled: null });
  const t2 = await captured(open, 1_000);
  assert.equal((await refund(open, t2)).statusCode, 200);
});

test("same Idempotency-Key + same body replays; same key + different body is 422", async () => {
  const m = await merchant(225);
  const txn = await captured(m, 5_000);
  const key = randomUUID();
  const first = await refund(m, txn, 1_000, key);
  const replay = await refund(m, txn, 1_000, key);
  assert.equal(first.statusCode, 200);
  assert.deepEqual(replay, first);
  const reused = await catching(refund(m, txn, 2_000, key));
  assert.deepEqual(reused, { statusCode: 422, code: "idempotency_key_reused" });
  const rows = await pool.query(`SELECT 1 FROM refunds WHERE transaction_id = $1`, [txn]);
  assert.equal(rows.rowCount, 1);
});

test("concurrent full refunds with different keys: exactly one succeeds", async () => {
  const m = await merchant(225);
  const txn = await captured(m, 10_000);
  const results = await Promise.all([1, 2, 3].map(() => refund(m, txn)));
  const codes = results.map((r) => r.statusCode).sort();
  assert.equal(codes.filter((c) => c === 200).length, 1, JSON.stringify(results));
  assert.ok(codes.every((c) => c === 200 || c === 409 || c === 422));
  const sum = await pool.query<{ s: string }>(
    `SELECT COALESCE(SUM(amount_fils), 0)::text AS s FROM refunds WHERE transaction_id = $1`,
    [txn],
  );
  assert.equal(Number(sum.rows[0]!.s), 10_000);
});

test("acquirer error -> 502, nothing written; retry with the same key succeeds", async () => {
  const m = await merchant(225);
  const txn = await captured(m, 2_000);
  let calls = 0;
  const flaky = {
    ...acquirer,
    async refund(req: Parameters<typeof acquirer.refund>[0]) {
      calls += 1;
      if (calls === 1) return { outcome: "error" as const, acquirerReference: req.acquirerReference, latencyMs: 0 };
      return acquirer.refund(req);
    },
  };
  const key = randomUUID();
  const input = { merchantId: m, transactionId: txn, idempotencyKey: key, actor };
  const failed = await processRefund(pool, flaky, input);
  assert.equal(failed.statusCode, 502);
  const none = await pool.query(`SELECT refunded_fils FROM transactions WHERE id = $1`, [txn]);
  assert.equal(Number(none.rows[0]!.refunded_fils), 0);
  const retried = await processRefund(pool, flaky, input);
  assert.equal(retried.statusCode, 200, JSON.stringify(retried.body));
});

test("refund with no reason stores 'unspecified' (0070 NOT NULL)", async () => {
  const m = await merchant(225);
  const txn = await captured(m, 1_000);
  assert.equal((await refund(m, txn)).statusCode, 200);
  const r = await pool.query<{ reason: string }>(`SELECT reason FROM refunds WHERE transaction_id = $1`, [txn]);
  assert.equal(r.rows[0]!.reason, "unspecified");
});

test("reconciliation gap stays 0 after captures and refunds, before any batch closes", async () => {
  const m = await merchant(225);
  const t1 = await captured(m, 10_000);
  const t2 = await captured(m, 6_000);
  assert.equal((await refund(m, t1, 2_000)).statusCode, 200);
  assert.equal((await refund(m, t2)).statusCode, 200);
  const report = await getReconciliationReport(pool, { merchantId: m, ...bahrainToday() });
  assert.equal(report.gapFils, 0, JSON.stringify(report));
  assert.equal(report.explained, true);
});

test("refund.succeeded outbox payload carries what reporting and webhooks need", async () => {
  const m = await merchant(225);
  const txn = await captured(m, 6_000);
  const r = await refund(m, txn, 2_000);
  const refundId = (r.body as { id: string }).id;
  const ev = await pool.query<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM outbox_events WHERE event_type = 'refund.succeeded' AND payload->>'refundId' = $1`,
    [refundId],
  );
  assert.equal(ev.rowCount, 1);
  assert.deepEqual(ev.rows[0]!.payload, {
    merchantId: m,
    transactionId: txn,
    refundId,
    amountFils: 2_000,
    feeReversedFils: 45,
    refundedTotalFils: 2_000,
    newStatus: "partially_refunded",
  });
});
