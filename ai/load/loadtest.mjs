// FilsPay load test: closed-loop virtual users against the real API.
// Each VU loops: authorize -> capture; every 5th iteration also a 1.000 BD partial refund.
// Usage: node loadtest.mjs <baseUrl> <keysFile> <vus> <seconds>
import fs from "node:fs"; import { randomUUID } from "node:crypto";
const [base, keysFile, vusArg, secArg] = process.argv.slice(2);
const keys = fs.readFileSync(keysFile, "utf8").trim().split("\n");
const VUS = Number(vusArg), SECS = Number(secArg);
const card = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };
const lat = { authorize: [], capture: [], refund: [] }; const codes = {}; let flows = 0;
const end = Date.now() + SECS * 1000;
async function call(kind, path, key, body) {
  const t0 = performance.now();
  let status = 0;
  try {
    const r = await fetch(base + path, { method: "POST", headers: { authorization: `Bearer ${key}`, "idempotency-key": randomUUID(), "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    status = r.status; const j = await r.json().catch(() => ({}));
    lat[kind].push(performance.now() - t0); codes[`${kind} ${status}`] = (codes[`${kind} ${status}`] ?? 0) + 1;
    return { status, j };
  } catch (e) { codes[`${kind} ERR`] = (codes[`${kind} ERR`] ?? 0) + 1; return { status: 0, j: {} }; }
}
async function vu(i) {
  const key = keys[i % keys.length]; let n = 0;
  while (Date.now() < end) {
    const a = await call("authorize", "/v1/transactions", key, { amountFils: 5000, card });
    if (a.status !== 201) continue;
    const c = await call("capture", `/v1/transactions/${a.j.id}/capture`, key, {});
    if (c.status !== 200) continue;
    flows++; n++;
    if (n % 5 === 0) await call("refund", "/v1/refunds", key, { transactionId: a.j.id, amountFils: 1000 });
  }
}
const pct = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]); };
await Promise.all(Array.from({ length: VUS }, (_, i) => vu(i)));
const total = Object.values(codes).reduce((a, b) => a + b, 0);
const errs = Object.entries(codes).filter(([k]) => !/ (200|201)$/.test(k)).reduce((a, [, v]) => a + v, 0);
console.log(JSON.stringify({ vus: VUS, seconds: SECS, checkoutsPerSec: +(flows / SECS).toFixed(1), requestsPerSec: +(total / SECS).toFixed(1), errorRatePct: +(100 * errs / Math.max(1, total)).toFixed(1),
  p50: { authorize: pct(lat.authorize, 50), capture: pct(lat.capture, 50), refund: pct(lat.refund, 50) },
  p95: { authorize: pct(lat.authorize, 95), capture: pct(lat.capture, 95), refund: pct(lat.refund, 95) }, codes }));
