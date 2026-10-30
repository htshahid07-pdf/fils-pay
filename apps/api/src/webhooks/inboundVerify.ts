import { createHmac } from "node:crypto";
import { timingSafeEqualHex } from "../lib/crypto.js";

/**
 * Verifies the signature on an inbound acquirer callback.
 *
 * FP-240 ("the incoming signature check has its own problems"). The old
 * version:
 *  1. accepted a request with NO signature header unless a flag was set, and
 *     the flag defaulted to false — anyone could POST forged callbacks;
 *  2. compared with Buffer.compare plus a length check, which is not
 *     constant-time;
 *  3. parsed `t` but never checked it, so a captured genuine callback could
 *     be replayed forever;
 *  4. HMAC'd JSON.stringify(parsedBody) instead of the bytes the acquirer
 *     sent, so any whitespace/key-order difference broke genuine callbacks.
 * Now: signature required by default, HMAC over the raw body, constant-time
 * hex compare (lib/crypto.timingSafeEqualHex), 300 s freshness window.
 */

interface ParsedAcquirerSignatureHeader {
  timestamp: number;
  signature: string;
}

function parseAcquirerSignatureHeader(header: string): ParsedAcquirerSignatureHeader | null {
  let timestampStr: string | null = null;
  let signature: string | null = null;

  for (const part of header.split(",")) {
    const eqIndex = part.indexOf("=");
    if (eqIndex === -1) continue;
    const key = part.slice(0, eqIndex).trim();
    const value = part.slice(eqIndex + 1).trim();
    if (key === "t") timestampStr = value;
    else if (key === "v1") signature = value;
  }

  if (!timestampStr || !signature) return null;
  if (!/^\d+$/.test(timestampStr)) return null;

  const timestamp = Number.parseInt(timestampStr, 10);
  if (!Number.isFinite(timestamp)) return null;

  return { timestamp, signature };
}

export type VerifyAcquirerCallbackFailureReason =
  | "missing_signature"
  | "malformed_header"
  | "signature_mismatch"
  | "timestamp_out_of_tolerance";

export interface VerifyAcquirerCallbackResult {
  valid: boolean;
  reason?: VerifyAcquirerCallbackFailureReason;
}

export interface VerifyAcquirerCallbackOptions {
  /** Default true. Only a non-production config may turn this off. */
  requireSignature?: boolean;
  /** Default 300 seconds. */
  toleranceSeconds?: number;
  /** Unix seconds; injectable for tests. */
  now?: number;
}

/** Verifies `rawBody` (the exact request body string) against the header. */
export function verifyAcquirerCallbackSignature(
  rawBody: string,
  header: string | undefined,
  secret: string,
  options: VerifyAcquirerCallbackOptions = {},
): VerifyAcquirerCallbackResult {
  const requireSignature = options.requireSignature ?? true;
  if (!header) {
    return requireSignature ? { valid: false, reason: "missing_signature" } : { valid: true };
  }

  const parsed = parseAcquirerSignatureHeader(header);
  if (!parsed) return { valid: false, reason: "malformed_header" };

  const expected = createHmac("sha256", secret).update(`${parsed.timestamp}.${rawBody}`).digest("hex");
  if (!timingSafeEqualHex(expected, parsed.signature)) {
    return { valid: false, reason: "signature_mismatch" };
  }

  const now = options.now ?? Math.floor(Date.now() / 1000);
  const tolerance = options.toleranceSeconds ?? 300;
  if (Math.abs(now - parsed.timestamp) > tolerance) {
    return { valid: false, reason: "timestamp_out_of_tolerance" };
  }

  return { valid: true };
}
