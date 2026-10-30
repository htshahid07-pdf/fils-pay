import { randomInt } from "node:crypto";

// Both helpers produce secrets — OTP codes (randomDigits) and payment-link
// bearer tokens (randomFromAlphabet) — so they must use the CSPRNG.
// Math.random() is a predictable PRNG (V8 xorshift128+): its internal state
// can be recovered from a handful of outputs, after which future OTPs and
// link tokens can be predicted. crypto.randomInt is uniform (no modulo bias).

/** Generates a string of `n` random decimal digits (e.g. "042817"). */
export function randomDigits(n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) {
    out += String(randomInt(10));
  }
  return out;
}

/** Generates a string of `n` characters drawn uniformly from `alphabet`. */
export function randomFromAlphabet(alphabet: string, n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) {
    out += alphabet[randomInt(alphabet.length)];
  }
  return out;
}

/** Short display-only reference for receipts and logs (e.g. "FP-A7K2M3"). */
export function displayReference(): string {
  return `FP-${randomFromAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 6)}`;
}
