/**
 * Unit tests for the inbound acquirer-callback signature verifier. Pure
 * function, no database — the route-level behavior it drives is covered in
 * routes/acquirerCallbacks.test.ts.
 *
 * Updated for FP-240: the verifier now takes the RAW body string, requires a
 * signature by default and enforces a freshness window. The previous version
 * of this file asserted that an unsigned callback was accepted.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { verifyAcquirerCallbackSignature } from "./inboundVerify.js";

const SECRET = "acqsec_test_secret";
const NOW = 1_800_000_000;

/** The header the acquirer sends: HMAC over `${t}.${rawBody}`. */
function acquirerHeader(rawBody: string, secret: string, timestamp = NOW): string {
  const signature = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

const raw = JSON.stringify({ callbackId: "acqcb_1", outcome: "cleared" });

test("a correctly-signed callback verifies", () => {
  assert.deepEqual(verifyAcquirerCallbackSignature(raw, acquirerHeader(raw, SECRET), SECRET, { now: NOW }), { valid: true });
});

test("the exact bytes are verified: same JSON with different whitespace still verifies against its own bytes", () => {
  const spaced = '{ "callbackId": "acqcb_1", "outcome": "cleared" }';
  assert.equal(verifyAcquirerCallbackSignature(spaced, acquirerHeader(spaced, SECRET), SECRET, { now: NOW }).valid, true);
});

test("a tampered payload is rejected (signature_mismatch)", () => {
  const header = acquirerHeader(raw, SECRET);
  const tampered = JSON.stringify({ callbackId: "acqcb_1", outcome: "confirmed_fraud" });
  assert.equal(verifyAcquirerCallbackSignature(tampered, header, SECRET, { now: NOW }).reason, "signature_mismatch");
});

test("the wrong secret is rejected (signature_mismatch)", () => {
  const header = acquirerHeader(raw, "acqsec_someone_elses_secret");
  assert.equal(verifyAcquirerCallbackSignature(raw, header, SECRET, { now: NOW }).reason, "signature_mismatch");
});

test("a malformed header is rejected (malformed_header)", () => {
  assert.equal(verifyAcquirerCallbackSignature(raw, "not-a-real-header", SECRET).reason, "malformed_header");
  assert.equal(verifyAcquirerCallbackSignature(raw, "t=abc,v1=deadbeef", SECRET).reason, "malformed_header");
  assert.equal(verifyAcquirerCallbackSignature(raw, "v1=deadbeef", SECRET).reason, "malformed_header");
});

test("an unsigned callback is rejected by default", () => {
  assert.deepEqual(verifyAcquirerCallbackSignature(raw, undefined, SECRET), { valid: false, reason: "missing_signature" });
});

test("an unsigned callback is only accepted when explicitly opted out (non-production)", () => {
  assert.deepEqual(verifyAcquirerCallbackSignature(raw, undefined, SECRET, { requireSignature: false }), { valid: true });
});

test("a stale signature is rejected (replay protection)", () => {
  const header = acquirerHeader(raw, SECRET, NOW - 301);
  assert.equal(verifyAcquirerCallbackSignature(raw, header, SECRET, { now: NOW }).reason, "timestamp_out_of_tolerance");
});

test("a same-length wrong signature is a mismatch, not a thrown error (constant-time path)", () => {
  const good = acquirerHeader(raw, SECRET);
  const bad = good.replace(/v1=./, (m) => (m.endsWith("0") ? "v1=1" : "v1=0"));
  assert.equal(verifyAcquirerCallbackSignature(raw, bad, SECRET, { now: NOW }).reason, "signature_mismatch");
});
