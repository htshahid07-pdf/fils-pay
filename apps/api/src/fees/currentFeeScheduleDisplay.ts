import type { Pool } from "pg";

/**
 * effectiveFrom: when the rate starts applying. createdAt: when it was
 * keyed in. The display returns the latest row whose effectiveFrom is not
 * in the future.
 */
export interface CurrentFeeScheduleDisplay {
  mdrBps: number;
  effectiveFrom: Date;
  createdAt: Date;
}

/**
 * Fetches the merchant's current negotiated fee schedule for display on the
 * admin merchant-detail page. We only need the newest schedule for display,
 * not point-in-time resolution — an admin looking at this page wants "what
 * did we most recently agree to for this merchant," not "what rate applied
 * to some specific past transaction" (that per-event resolution already
 * exists at capture/settlement time). Ordering by created_at is the
 * simplest way to answer "most recently agreed," since that's literally
 * when the row was entered.
 */
// The rate shown must be the rate we actually charge, so this resolves the
// schedule exactly like capture/settlement do (feeSchedule.ts and
// fee_schedule.go): the newest row whose effective_from has arrived, ties by
// created_at. Ordering by created_at alone made a backdated backfill
// (245 bps effective March, keyed in August) look "current" while every
// payment was charged the August 225 bps row; a future-dated row would also
// have shown before it took effect.
export async function getCurrentFeeScheduleForDisplay(
  pool: Pool,
  merchantId: string,
): Promise<CurrentFeeScheduleDisplay | null> {
  const result = await pool.query<{ mdr_bps: number; effective_from: Date; created_at: Date }>(
    `SELECT mdr_bps, effective_from, created_at
       FROM fee_schedules
      WHERE merchant_id = $1 AND effective_from <= now()
      ORDER BY effective_from DESC, created_at DESC
      LIMIT 1`,
    [merchantId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { mdrBps: row.mdr_bps, effectiveFrom: row.effective_from, createdAt: row.created_at };
}
