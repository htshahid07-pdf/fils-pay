/**
 * Regression test for "Login works without entering the OTP code?".
 * A session row is written at the password step with authenticated = false
 * and the same cookie the app uses for real sessions. lookupSession read the
 * live_sessions view, which does not filter on `authenticated`, so that
 * pre-OTP cookie passed every requireMerchantAuth/requireSession check.
 * (The existing file notes this case was "covered in routes/auth.test.ts";
 * that file does not exist.)
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { lookupSession } from "./sessions.js";
import { randomToken, sha256Hex } from "../lib/crypto.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("sessions.pending.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
test.after(async () => {
  await pool.end();
});

async function insertSession(authenticated: boolean): Promise<string> {
  const suffix = randomUUID();
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Pending Session ${suffix.slice(0, 8)}`],
  );
  const user = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, password_hash, role)
     VALUES ($1, $2, 'unused', 'owner') RETURNING id`,
    [merchant.rows[0]!.id, `pending-${suffix}@sessions.test`],
  );
  const rawToken = randomToken(32);
  await pool.query(
    `INSERT INTO sessions (merchant_user_id, token_hash, authenticated, expires_at)
     VALUES ($1, $2, $3, now() + interval '10 minutes')`,
    [user.rows[0]!.id, sha256Hex(rawToken), authenticated],
  );
  return rawToken;
}

test("a pending (password-only, OTP not verified) session authenticates nothing", async () => {
  const rawToken = await insertSession(false);
  assert.equal(await lookupSession(pool, rawToken), null);
});

test("the same session resolves once OTP has promoted it", async () => {
  const rawToken = await insertSession(true);
  assert.ok(await lookupSession(pool, rawToken));
});
