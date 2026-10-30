import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { applyRateFils, subtractFils, toFils } from "@filspay/money";
import { getEffectiveMdrBps } from "../fees/feeSchedule.js";
import { withTransaction } from "../db/withTransaction.js";
import { BadRequestError } from "../lib/errors.js";


/**
 * Parses a promotional discount amount (BD string from the merchant
 * pricing dashboard) into fils for the ledger adjustment.
 */
export function parsePromotionalDiscountFils(raw: string): number {
  const parsed = parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new BadRequestError("invalid_discount", `could not parse discount amount "${raw}"`);
  }
  return Math.round(parsed * 100);
}

/**
 * Applies a merchant's negotiated processing discount against the MDR fee
 * capture.ts already charged, per the merchant's pricing agreement: the
 * discount applies to our processing fee, after it's calculated — see the
 * partner-pricing addendum. capture.ts's own response doesn't carry the
 * fee it just charged, so this reads it back from the transaction_events
 * row capture.ts already wrote (its `metadata.feeFils`), then reverses the
 * merchant's share via a same-day ledger adjustment.
 *
 * A merchant with negotiated_discount_bps = 0 (the default for anyone
 * without a negotiated rate) is a no-op: this
 * function reads the merchant row, sees a zero discount rate, and inserts
 * nothing.
 */
export async function applyCaptureDiscountAdjustment(
  pool: Pool,
  input: { merchantId: string; transactionId: string },
): Promise<void> {
  return withTransaction(pool, async (client) => {
    const merchantRow = await client.query<{ negotiated_discount_bps: number; mdr_bps: number }>(
      `SELECT negotiated_discount_bps, mdr_bps FROM merchants WHERE id = $1`,
      [input.merchantId],
    );
    const discountBps = merchantRow.rows[0]?.negotiated_discount_bps ?? 0;
    if (discountBps === 0) return;

    // Exactly one adjustment per capture event. A replayed (idempotent)
    // capture returns its cached 200 without writing a new
    // transaction_events row, so the caller re-enters this path with
    // nothing new to adjust — reversing the same fee a second time would
    // credit the merchant twice for one capture. The row lock serializes
    // this count against a concurrent capture's own adjustment.
    await client.query(`SELECT id FROM transactions WHERE id = $1 FOR UPDATE`, [input.transactionId]);
    const countRow = await client.query<{ capture_events: string; adjustments: string }>(
      `SELECT (SELECT count(*) FROM transaction_events
                WHERE transaction_id = $1 AND event_type IN ('captured', 'partially_captured')) AS capture_events,
              (SELECT count(*) FROM ledger_entries
                WHERE transaction_id = $1 AND direction = 'credit'
                  AND description = 'capture: negotiated discount adjustment') AS adjustments`,
      [input.transactionId],
    );
    const counts = countRow.rows[0];
    if (counts && Number(counts.adjustments) >= Number(counts.capture_events)) return;

    const eventRow = await client.query<{ amount_fils: string; occurred_at: Date; metadata: { feeFils?: number } }>(
      `SELECT amount_fils, occurred_at, metadata FROM transaction_events
        WHERE transaction_id = $1 AND event_type IN ('captured', 'partially_captured')
        ORDER BY occurred_at DESC, id DESC LIMIT 1`,
      [input.transactionId],
    );
    const feeBeforeDiscount = toFils(eventRow.rows[0]?.metadata?.feeFils ?? 0);
    if (feeBeforeDiscount <= 0) return;

    // Settlement's ComputeSettlementFee (Go) is the reference for fees (eng
    // sync 2026-06-02: "Go is the reference for fees, capture.ts follows"):
    // MDR on the DISCOUNTED AMOUNT. This used to discount the FEE instead,
    // which rounds at a different point, so ledger and payout could differ by
    // a fil per capture (5000 fils @275bps, 12.5% off: 121 here vs 120 in Go;
    // the Go and TS unit tests pinned 14 and 15 for the same inputs). The
    // rebate is now whatever brings the charged fee down to Go's figure, with
    // the same effective-dated MDR capture.ts charged at the event's time.
    const event = eventRow.rows[0]!;
    const amountFils = toFils(Number(event.amount_fils));
    const mdrBps = await getEffectiveMdrBps(client, input.merchantId, event.occurred_at, merchantRow.rows[0]!.mdr_bps);
    const netFeeFils = applyRateFils(subtractFils(amountFils, applyRateFils(amountFils, discountBps)), mdrBps);
    const discountFils = subtractFils(feeBeforeDiscount, netFeeFils);
    if (discountFils <= 0) return;

    const entryGroupId = randomUUID();
    await client.query(
      `INSERT INTO ledger_entries
         (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
       VALUES
         ($1, $2, $3, 'platform_fee_revenue', 'debit',  $4, now(), 'capture: negotiated discount adjustment'),
         ($1, $2, $3, 'merchant_payable',     'credit', $4, now(), 'capture: negotiated discount adjustment')`,
      [entryGroupId, input.merchantId, input.transactionId, discountFils],
    );
  });
}
