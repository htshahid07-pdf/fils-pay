/**
 * FP-212 route-level tests for POST /v1/refunds, using `app.inject(...)` against `buildApp()` and a
 * real, migrated Postgres (no DB mocking). Requires `DATABASE_URL` (run
 * `npm run migrate` first).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "refunds.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `npm run migrate` first)",
  );
}

// Deterministic, fast, always-approved acquirer for these tests: failure
// rate 0 and near-zero latency. Card-declined/error paths are exercised via
// the acquirer simulator's own magic PANs where a test needs them.
const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  ACQUIRER_FAILURE_RATE: "0",
  ACQUIRER_LATENCY_MIN_MS: "0",
  ACQUIRER_LATENCY_MAX_MS: "1",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});

const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

const VALID_CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

/** Inserts a merchant directly (bypassing the full signup flow, which this
 *  file doesn't need) and approves it through the real recordKycReview()
 *  write path, then issues a real API key for it. */
async function createApprovedMerchantWithApiKey(label: string, mdrBps = 250) {
  const merchantResult = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, $2) RETURNING id`,
    [`Test Merchant ${label} ${randomUUID()}`, mdrBps],
  );
  const merchantId = merchantResult.rows[0]!.id;

  const userResult = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused-in-these-tests')
     RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  const ownerUserId = userResult.rows[0]!.id;

  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const issued = await issueApiKey(pool, config, { merchantId, createdBy: ownerUserId, label });

  return { merchantId, ownerUserId, rawKey: issued.rawKey };
}

function authHeader(rawKey: string) {
  return { authorization: `Bearer ${rawKey}` };
}

function refundRequest(rawKey: string, payload: Record<string, unknown>, idempotencyKey: string | null = randomUUID()) {
  return app.inject({
    method: "POST",
    url: "/v1/refunds",
    headers: { ...authHeader(rawKey), ...(idempotencyKey === null ? {} : { "idempotency-key": idempotencyKey }) },
    payload,
  });
}

/** Authorize `authFils` and capture `captureFils` through the real routes. */
async function capturedTxn(rawKey: string, authFils: number, captureFils?: number): Promise<string> {
  const a = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { ...authHeader(rawKey), "idempotency-key": randomUUID() },
    payload: { amountFils: authFils, card: VALID_CARD, reference: "fp-212" },
  });
  assert.equal(a.statusCode, 201, a.body);
  const id = (a.json() as { id: string }).id;
  const c = await app.inject({
    method: "POST",
    url: `/v1/transactions/${id}/capture`,
    headers: { ...authHeader(rawKey), "idempotency-key": randomUUID() },
    payload: captureFils === undefined ? {} : { amountFils: captureFils },
  });
  assert.equal(c.statusCode, 200, c.body);
  return id;
}

test("400 idempotency_key_required without the Idempotency-Key header", async () => {
  const { rawKey } = await createApprovedMerchantWithApiKey("no-key", 225);
  const txn = await capturedTxn(rawKey, 1_000);
  const res = await refundRequest(rawKey, { transactionId: txn }, null);
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.json().error, "idempotency_key_required");
});

test("400 invalid_request for a missing transactionId or a non-integer amountFils", async () => {
  const { rawKey } = await createApprovedMerchantWithApiKey("bad-body", 225);
  const missing = await refundRequest(rawKey, {});
  assert.equal(missing.statusCode, 400, missing.body);
  const fractional = await refundRequest(rawKey, { transactionId: randomUUID(), amountFils: 1.5 });
  assert.equal(fractional.statusCode, 400, fractional.body);
  const asString = await refundRequest(rawKey, { transactionId: randomUUID(), amountFils: "2000" });
  assert.equal(asString.statusCode, 400, asString.body);
});

test("§3.5 Alpha Retail over HTTP: 422, 200 partial, 404 for Beta, 200 rest, 409", async () => {
  const alpha = await createApprovedMerchantWithApiKey("alpha", 225);
  const beta = await createApprovedMerchantWithApiKey("beta", 225);
  const txn = await capturedTxn(alpha.rawKey, 10_000, 6_000);

  const over = await refundRequest(alpha.rawKey, { transactionId: txn, amountFils: 9_000 });
  assert.equal(over.statusCode, 422, over.body);
  assert.equal(over.json().code, "refund_exceeds_refundable");
  assert.equal(over.json().refundableFils, 6_000);

  const partial = await refundRequest(alpha.rawKey, { transactionId: txn, amountFils: 2_000, reason: "customer returned item" });
  assert.equal(partial.statusCode, 200, partial.body);
  assert.equal(partial.json().feeReversedFils, 45);
  assert.equal(partial.json().transactionStatus, "partially_captured");

  const cross = await refundRequest(beta.rawKey, { transactionId: txn, amountFils: 100 });
  assert.equal(cross.statusCode, 404, cross.body);
  assert.equal(cross.json().error, "transaction_not_found");

  // A body merchantId is ignored: the merchant always comes from the auth context.
  const spoof = await refundRequest(beta.rawKey, { transactionId: txn, merchantId: alpha.merchantId });
  assert.equal(spoof.statusCode, 404, spoof.body);

  const rest = await refundRequest(alpha.rawKey, { transactionId: txn });
  assert.equal(rest.statusCode, 200, rest.body);
  assert.equal(rest.json().amountFils, 4_000);
  assert.equal(rest.json().feeReversedFils, 90);
  assert.equal(rest.json().transactionStatus, "refunded");

  const more = await refundRequest(alpha.rawKey, { transactionId: txn, amountFils: 1 });
  assert.equal(more.statusCode, 409, more.body);
  assert.equal(more.json().code, "transaction_not_refundable");

  const timeline = await app.inject({ method: "GET", url: `/v1/transactions/${txn}/events`, headers: authHeader(alpha.rawKey) });
  const amounts = (timeline.json() as Array<{ eventType: string; amountFils: number | null }>)
    .filter((e) => e.eventType === "refund_partial" || e.eventType === "refunded")
    .map((e) => e.amountFils);
  assert.deepEqual(amounts, [-2_000, -4_000]);
});

test("403 refunds_on_hold", async () => {
  const { rawKey, merchantId } = await createApprovedMerchantWithApiKey("hold", 225);
  const txn = await capturedTxn(rawKey, 1_000);
  await pool.query(`UPDATE merchants SET refunds_enabled = false WHERE id = $1`, [merchantId]);
  const res = await refundRequest(rawKey, { transactionId: txn });
  assert.equal(res.statusCode, 403, res.body);
  assert.equal(res.json().error, "refunds_on_hold");
});

test("idempotent replay returns the original response; a different body with the same key is 422", async () => {
  const { rawKey } = await createApprovedMerchantWithApiKey("replay", 225);
  const txn = await capturedTxn(rawKey, 5_000);
  const key = randomUUID();
  const first = await refundRequest(rawKey, { transactionId: txn, amountFils: 1_000 }, key);
  const replay = await refundRequest(rawKey, { transactionId: txn, amountFils: 1_000 }, key);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.deepEqual(replay.json(), first.json());
  const reused = await refundRequest(rawKey, { transactionId: txn, amountFils: 2_000 }, key);
  assert.equal(reused.statusCode, 422, reused.body);
  assert.equal(reused.json().error, "idempotency_key_reused");
});
