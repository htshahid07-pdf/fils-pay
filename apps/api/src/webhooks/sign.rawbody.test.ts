/**
 * FP-240 / ya/sign-raw regression: a merchant verifies a webhook by
 * computing HMAC-SHA256 over the RAW request body it received. The
 * dispatcher must therefore sign exactly the string it sends.
 *
 * The existing sign/dispatcher tests verify a *re-parsed object*, which
 * verifySignature re-canonicalizes — that is precisely the path that hid the
 * bug, so these tests verify the raw string instead.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { serializeWebhookBody, signBody, signPayload, verifySignatureRawBody } from "./sign.js";

const SECRET = "whsec_fp240_test";

// A delivery payload as it comes back from webhook_deliveries.payload
// (JSONB): Postgres stores object keys shortest-first, so the key order is
// id, data, type, createdAt — neither insertion order nor alphabetical.
const fromJsonb = {
  id: "evt_1",
  data: { merchantId: "m_1", netPayoutFils: 131625120, batchDate: "2026-09-10" },
  type: "settlement.paid",
  createdAt: "2026-09-10T21:00:00.000Z",
};

test("the body that is sent verifies with a plain raw-body HMAC (merchant-side check)", () => {
  const body = serializeWebhookBody(fromJsonb);
  const { signature, timestamp } = signBody(body, SECRET);
  const v1 = createHmac("sha256", SECRET).update(`${timestamp}.${body}`).digest("hex");
  assert.equal(signature, `t=${timestamp},v1=${v1}`);
  assert.deepEqual(verifySignatureRawBody(body, signature, SECRET), { valid: true });
});

test("the old pairing — sign canonical JSON, send JSON.stringify — fails raw-body verification", () => {
  const { signature } = signPayload(fromJsonb, SECRET);
  const oldWireBody = JSON.stringify(fromJsonb);
  assert.notEqual(oldWireBody, serializeWebhookBody(fromJsonb));
  assert.equal(verifySignatureRawBody(oldWireBody, signature, SECRET).reason, "signature_mismatch");
});

test("signature value is unchanged for receivers that already re-canonicalized", () => {
  const t = 1_800_000_000;
  assert.equal(signPayload(fromJsonb, SECRET, t).signature, signBody(serializeWebhookBody(fromJsonb), SECRET, t).signature);
});

test("a body re-ordered in transit no longer verifies (the signature covers exact bytes)", () => {
  const body = serializeWebhookBody(fromJsonb);
  const { signature } = signBody(body, SECRET);
  assert.equal(verifySignatureRawBody(JSON.stringify(JSON.parse(body), null, 2), signature, SECRET).valid, false);
});
