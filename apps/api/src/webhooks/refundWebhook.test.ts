/**
 * FP-212 step 5: refund.succeeded reaches merchants, signed over the exact
 * bytes sent. Pure — no database.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { buildEnvelope } from "./envelope.js";
import { serializeWebhookBody, signRawBody, verifySignatureRawBody } from "./sign.js";

const SECRET = "whsec_fp212_test";

const outboxRow = {
  eventType: "refund.succeeded",
  aggregateId: "6f1c1c39-0000-4000-8000-000000000001",
  payload: {
    merchantId: "6f1c1c39-0000-4000-8000-0000000000aa",
    transactionId: "6f1c1c39-0000-4000-8000-000000000001",
    refundId: "6f1c1c39-0000-4000-8000-0000000000bb",
    amountFils: 2_000,
    feeReversedFils: 45,
    refundedTotalFils: 2_000,
    newStatus: "partially_captured",
  },
  createdAt: new Date("2026-10-30T09:00:00.000Z"),
};

test("buildEnvelope maps refund.succeeded field by field (newStatus published as status)", () => {
  const env = buildEnvelope("evt_refund_1", outboxRow);
  assert.deepEqual(env, {
    id: "evt_refund_1",
    type: "refund.succeeded",
    createdAt: "2026-10-30T09:00:00.000Z",
    data: {
      transactionId: outboxRow.aggregateId,
      merchantId: outboxRow.payload.merchantId,
      refundId: outboxRow.payload.refundId,
      amountFils: 2_000,
      feeReversedFils: 45,
      refundedTotalFils: 2_000,
      status: "partially_captured",
    },
  });
});

test("a receiver computing HMAC-SHA256(secret, t + '.' + rawBody) matches the signature sent", () => {
  const body = serializeWebhookBody(buildEnvelope("evt_refund_2", outboxRow));
  const { signature, timestamp } = signRawBody(body, SECRET, 1_793_350_000);
  const v1 = createHmac("sha256", SECRET).update(`${timestamp}.${body}`).digest("hex");
  assert.equal(signature, `t=${timestamp},v1=${v1}`);
  assert.deepEqual(verifySignatureRawBody(body, signature, SECRET, { now: 1_793_350_000 }), { valid: true });
  // One byte changed in transit no longer verifies.
  assert.equal(
    verifySignatureRawBody(body.replace("2000", "9000"), signature, SECRET, { now: 1_793_350_000 }).valid,
    false,
  );
});
