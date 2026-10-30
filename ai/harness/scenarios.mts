import { Pool } from "pg";
import { randomUUID } from "node:crypto";
const ROOT = process.env.ROOT!;
const api = (p: string) => import(`${ROOT}/apps/api/src/${p}`);
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
const { createAcquirerSimulator } = await api("acquirer/simulator.ts");
const { authorizeTransaction } = await api("payments/authorize.ts");
const { captureTransaction } = await api("payments/capture.ts");
const { processRefund } = await api("payments/processRefund.ts");
const { initiateMerchantRefund } = await api("refunds/initiateMerchantRefund.ts");
const { payPaymentLink } = await api("paymentLinks/pay.ts");
const sim = createAcquirerSimulator({ acquirerLatencyMinMs: 0, acquirerLatencyMaxMs: 0, acquirerFailureRate: 0, acquirerRngSeed: 7 });
const card = (pan = "4242424242424242") => ({ pan, expiryMonth: 12, expiryYear: 2030, cvv: "123" });
const actor = { type: "merchant_api_key" as const, id: randomUUID() };

async function merchant(): Promise<string> {
  const r = await pool.query(`INSERT INTO merchants (display_name, mdr_bps, status, onboarding_status) VALUES ($1, 250, 'active', 'approved') RETURNING id`, [`scn ${randomUUID().slice(0, 8)}`]);
  return r.rows[0].id;
}
async function paid(merchantId: string, authFils: number, captureFils?: number): Promise<string> {
  const a = await authorizeTransaction(pool, sim, { merchantId, amountFils: authFils, card: card(), idempotencyKey: randomUUID(), actor });
  if (a.statusCode !== 201) throw new Error("auth " + JSON.stringify(a.body));
  const c = await captureTransaction(pool, sim, { transactionId: a.body.id, merchantId, idempotencyKey: randomUUID(), actor, ...(captureFils ? { amountFils: captureFils } : {}) });
  if (c.statusCode !== 200) throw new Error("capture " + JSON.stringify(c.body));
  return a.body.id;
}
const out: Record<string, unknown> = {};
const safe = async (f: () => Promise<any>) => { try { return await f(); } catch (e: any) { return { statusCode: e.statusCode ?? 500, body: { error: e.code ?? e.message } }; } };

// FP-209: two concurrent full refunds, different idempotency keys
{ const m = await merchant(); const t = await paid(m, 10_000);
  const rs = await Promise.all([1, 2].map(() => safe(() => processRefund(pool, sim, { transactionId: t, merchantId: m, idempotencyKey: randomUUID(), actor }))));
  const sum = await pool.query(`SELECT COALESCE(SUM(amount_fils),0)::int s FROM refunds WHERE transaction_id=$1`, [t]);
  out["FP-209 concurrent refunds of a 10.000 BD payment"] = { statuses: rs.map((r) => r.statusCode), totalRefundedFils: sum.rows[0].s }; }

// refund more than captured
{ const m = await merchant(); const t = await paid(m, 10_000, 6_000);
  const r = await safe(() => processRefund(pool, sim, { transactionId: t, merchantId: m, amountFils: 10_000, idempotencyKey: randomUUID(), actor }));
  out["refund 10.000 BD of a 6.000 BD capture"] = { status: r.statusCode, body: (r.body as any).code ?? (r.body as any).error ?? "refunded" }; }

// cross-merchant refund
{ const a = await merchant(); const b = await merchant(); const tb = await paid(b, 5_000);
  const r = await safe(() => initiateMerchantRefund(pool, sim, { merchantId: a, transactionId: tb, idempotencyKey: randomUUID(), actor }));
  out["merchant A refunds merchant B's payment"] = { status: r.statusCode, body: (r.body as any).error ?? "refunded" }; }

// fee reversal across partials
{ const m = await merchant(); const t = await paid(m, 1_000);
  const fee = (await pool.query(`SELECT COALESCE(SUM(amount_fils),0)::int f FROM ledger_entries WHERE transaction_id=$1 AND account_id='platform_fee_revenue' AND direction='credit'`, [t])).rows[0].f;
  for (const amt of [333, 333, 334]) await processRefund(pool, sim, { transactionId: t, merchantId: m, amountFils: amt, idempotencyKey: randomUUID(), actor });
  const rev = (await pool.query(`SELECT SUM(fee_reversed_fils)::int r FROM refunds WHERE transaction_id=$1`, [t])).rows[0].r;
  out["fee reversal: 3 partial refunds of a fully refunded payment"] = { feeCharged: fee, feeReversed: rev }; }

// FP-187: expired link paid with a back-dated submittedAt
{ const m = await merchant(); const token = `plink_${randomUUID()}`;
  await pool.query(`INSERT INTO payment_links (merchant_id, token, amount_fils, expires_at, created_by_type, created_by_id) VALUES ($1,$2,2500, now() - interval '1 day','merchant_api_key',$3)`, [m, token, randomUUID()]);
  const r = await payPaymentLink(pool, sim, { paymentLinkReservationTimeoutSeconds: 60 }, { token, card: card(), idempotencyKey: randomUUID(), submittedAt: "2020-01-01T00:00:00Z" });
  out["FP-187 pay a link that expired yesterday, submittedAt=2020"] = { status: r.statusCode, body: (r.body as any).error ?? (r.body as any).status }; }

// Incident 05-14: slow buyer A, buyer B re-claims after the reservation timeout
{ const m = await merchant(); const token = `plink_${randomUUID()}`;
  await pool.query(`INSERT INTO payment_links (merchant_id, token, amount_fils, expires_at, created_by_type, created_by_id) VALUES ($1,$2,7000, now() + interval '1 day','merchant_api_key',$3)`, [m, token, randomUUID()]);
  const slowSim = { ...sim, authorize: async (req: any) => { if (req.card.pan.endsWith("1111")) await new Promise((r) => setTimeout(r, 1600)); return sim.authorize(req); } };
  const cfg = { paymentLinkReservationTimeoutSeconds: 1 };
  const pA = payPaymentLink(pool, slowSim, cfg, { token, card: card("4000000000001111"), idempotencyKey: "buyer-A" });
  await new Promise((r) => setTimeout(r, 1200));
  const rB = await payPaymentLink(pool, slowSim, cfg, { token, card: card(), idempotencyKey: "buyer-B" });
  const rA = await pA;
  const caps = (await pool.query(`SELECT count(*)::int n FROM transactions WHERE merchant_id=$1 AND captured_fils > 0`, [m])).rows[0].n;
  out["05-14 slow buyer A + buyer B on one link"] = { buyerA: rA.statusCode, buyerB: rB.statusCode, cardsCharged: caps }; }

console.log(JSON.stringify(out, null, 1));
await pool.end();
