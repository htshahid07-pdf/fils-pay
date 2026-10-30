import fs from "node:fs"; import pg from "pg";
const r = (f) => fs.readFileSync(f, "utf8").trim(); const B = "http://localhost:3000";
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const out = []; const say = (k, v) => { out.push(`${k}: ${v}`); };
const cookieOf = (res) => (res.headers.get("set-cookie") ?? "").split(";")[0];
async function call(method, path, { body, headers = {}, cookie } = {}) {
  const res = await fetch(B + path, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await res.json(); } catch {} return { status: res.status, body: j, res };
}
// #11 OTP bypass: pending cookie must not authenticate
{ const l = await call("POST", "/v1/auth/login", { body: { merchantId: r("/tmp/alpha.mid"), email: "owner@alpharetail.example", password: "FilsPaySeed!2026" } });
  const pending = cookieOf(l.res);
  say("#11 pending (pre-OTP) cookie on /v1/auth/me", (await call("GET", "/v1/auth/me", { cookie: pending })).status);
  const guesses = await Promise.all(Array.from({ length: 20 }, () => call("POST", "/v1/auth/otp/verify", { cookie: pending, body: { code: "000000" } })));
  const codes = {}; for (const g of guesses) codes[g.status] = (codes[g.status] ?? 0) + 1;
  const real = await call("POST", "/v1/auth/otp/verify", { cookie: pending, body: { code: l.body.devOtpCode } });
  say("#11 20 parallel wrong OTP guesses -> status counts", JSON.stringify(codes) + `; correct code afterwards -> ${real.status} (challenge burned after max attempts)`); }
// admin sessions
async function admin(email) { const l = await call("POST", "/v1/admin/auth/login", { body: { email, password: "FilsPayAdminSeed!2026" } });
  const c = cookieOf(l.res); const v = await call("POST", "/v1/admin/auth/otp/verify", { cookie: c, body: { code: l.body.devOtpCode } }); return cookieOf(v.res) || c; }
const sa = await admin("superadmin@filspay.test"), sup = await admin("support@filspay.test");
// #6 fee display
{ const m = await call("GET", `/v1/admin/merchants/${r("/tmp/alpha.mid")}`, { cookie: sa });
  say("#6 admin merchant page current fee for Alpha (charged at capture: 225)", JSON.stringify(m.body?.currentFeeSchedule ?? m.body?.feeSchedule ?? m.body?.currentMdrBps ?? Object.keys(m.body ?? {}))); }
// #10 recompute statuses must not flip test_mode
{ const gm = r("/tmp/gamma.mid"); const before = (await db.query("select test_mode from merchants where id=$1", [gm])).rows[0].test_mode;
  const rc = await call("POST", `/v1/admin/merchants/${gm}/transactions/recompute-statuses`, { cookie: sa, body: {} });
  const after = (await db.query("select test_mode from merchants where id=$1", [gm])).rows[0].test_mode;
  say("#10 recompute-statuses on test merchant Gamma", `${rc.status}; test_mode before=${before} after=${after}`); }
// page2 admin roles: support cannot create credits
{ const c = await call("POST", `/v1/admin/merchants/${r("/tmp/alpha.mid")}/credits`, { cookie: sup, body: { amountFils: 1000, reason: "probe" } });
  say("page2 admin roles: support creates a credit", `${c.status} ${c.body?.error ?? ""}`); }
// page2 key rotation
{ const mid = r("/tmp/alpha.mid"); const oldKey = r("/tmp/alpha.key");
  const keyId = (await db.query("select id from api_keys where merchant_id=$1 and revoked_at is null order by created_at desc limit 1", [mid])).rows[0].id;
  const rot = await call("POST", `/v1/admin/merchants/${mid}/api-keys/${keyId}/rotate`, { cookie: sa, body: {} });
  const ra = (await db.query("select revoke_after from api_keys where id=$1", [keyId])).rows[0].revoke_after;
  const during = (await call("GET", "/v1/transactions?limit=1", { headers: { authorization: `Bearer ${oldKey}` } })).status;
  await db.query("update api_keys set revoke_after = now() - interval '1 minute' where id=$1", [keyId]);
  const after = (await call("GET", "/v1/transactions?limit=1", { headers: { authorization: `Bearer ${oldKey}` } })).status;
  const newKey = rot.body?.rawKey ?? rot.body?.key ?? rot.body?.apiKey?.rawKey; if (newKey) fs.writeFileSync("/tmp/alpha.key", newKey);
  const newOk = newKey ? (await call("GET", "/v1/transactions?limit=1", { headers: { authorization: `Bearer ${newKey}` } })).status : "n/a";
  say("page2 key rotation", `rotate ${rot.status}; revoke_after set=${ra !== null}; old key during overlap ${during}; after revoke_after ${after}; new key ${newOk}`); }
// page1 #12 cross-merchant payment-link cancel
{ const linkId = r("/tmp/link.id"); const bm = r("/tmp/beta.mid");
  const res = await call("POST", `/v1/merchants/${r("/tmp/alpha.mid")}/payment-links/${linkId}/cancel`, { headers: { authorization: `Bearer ${r("/tmp/beta.key")}` } });
  const res2 = await call("POST", `/v1/merchants/${bm}/payment-links/${linkId}/cancel`, { headers: { authorization: `Bearer ${r("/tmp/beta.key")}` } });
  say("#12 Beta cancels Alpha's payment link (Alpha path / Beta path)", `${res.status} / ${res2.status}`); }
// whiteboard inbound: unsigned acquirer callback
{ const c = await call("POST", "/v1/acquirer/callbacks", { body: { callbackId: "probe-1", acquirerReference: "x", outcome: "approved" } });
  say("whiteboard inbound: unsigned acquirer callback", `${c.status} ${c.body?.error ?? ""}`); }
// page2 ledger immutability
for (const sql of ["update ledger_entries set amount_fils = amount_fils where id = (select id from ledger_entries limit 1)", "delete from ledger_entries where id = (select id from ledger_entries limit 1)"]) {
  try { await db.query(sql); say("page2 ledger immutability " + sql.split(" ")[0], "ALLOWED (bad)"); } catch (e) { say("page2 ledger immutability " + sql.split(" ")[0], "rejected: " + e.message.slice(0, 70)); } }
// every ledger group balanced
{ const u = await db.query("select count(*)::int c from (select entry_group_id from ledger_entries group by 1 having sum(case when direction='debit' then amount_fils else -amount_fils end) <> 0) x");
  say("ledger: unbalanced entry groups in whole DB", u.rows[0].c); }
// FP-212 DB guard
{ try { await db.query("update transactions set refunded_fils = captured_fils + 1 where id = (select id from transactions where captured_fils > 0 limit 1)"); say("FP-212 DB guard refunded<=captured", "ALLOWED (bad)"); } catch (e) { say("FP-212 DB guard refunded<=captured", "rejected: " + e.message.slice(0, 60)); } }
// page2 slow reporting query plan
{ const p = await db.query(`explain select * from transactions where merchant_id=$1 and created_at >= now() - interval '1 day' and created_at < now()`, [r("/tmp/alpha.mid")]);
  say("page2 reporting query plan", p.rows.map((x) => x["QUERY PLAN"]).find((l) => /Index|Seq/.test(l)).trim()); }
console.log(out.join("\n")); await db.end();
