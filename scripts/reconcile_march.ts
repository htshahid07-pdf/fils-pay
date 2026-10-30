#!/usr/bin/env -S npx tsx
/**
 * One-off March 2026 reconciliation sweep. Finance wants the scheme
 * rounding residue (the gap between what gets journaled at capture and
 * what the scheme export can actually carry at 2 decimal places) written
 * off for March before the books close on it. Run manually, once — see
 * scripts/out/reconcile-2026-03.log for the last real run's output.
 *
 * Usage: DATABASE_URL=postgres://... npx tsx scripts/reconcile_march.ts
 */
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { formatBhd, toFils } from "@filspay/money";

/** Asia/Bahrain is a fixed UTC+3 with no DST, so a Bahrain wall-clock
 *  midnight is always the UTC midnight minus three hours. */
const BAHRAIN_UTC_OFFSET_MS = 3 * 60 * 60 * 1000;

/** [start, end) of a calendar month in Asia/Bahrain time — the settlement
 *  business calendar — not a UTC month. A UTC month starts at 03:00 Bahrain
 *  on the 1st and runs to 03:00 on the 1st of the next month, so it puts the
 *  first three hours of March into February and the first three hours of
 *  April into March. */
export function monthBounds(year: number, month: number): { start: Date; end: Date } {
  return {
    start: new Date(Date.UTC(year, month - 1, 1) - BAHRAIN_UTC_OFFSET_MS),
    end: new Date(Date.UTC(year, month, 1) - BAHRAIN_UTC_OFFSET_MS),
  };
}

/** Every leg this sweep posts carries this exact description; it is how a
 *  re-run recognises a merchant that has already been swept, including by
 *  earlier runs of this script (which used a random entry_group_id). */
export const SWEEP_DESCRIPTION = "March 2026 scheme rounding residue sweep — manual recon per finance";

export interface ResidueRow {
  merchantId: string;
  capturedFils: number;
}

/** The fils truncated away when a captured amount is quantized down to the
 *  scheme export's 2-decimal-place granularity. */
// MK: % 10 on a non-negative int. correct.
export function computeResidueFils(capturedFils: number): number {
  return capturedFils % 10;
}

interface MerchantResidue {
  merchantId: string;
  lineCount: number;
  residueFils: number;
}

async function fetchResidueRows(client: Client, year: number, month: number): Promise<ResidueRow[]> {
  const { start, end } = monthBounds(year, month);
  const result = await client.query<{ merchant_id: string; captured_fils: string }>(
    `SELECT merchant_id, captured_fils
       FROM transactions
      WHERE captured_fils > 0
        AND captured_fils % 10 <> 0
        AND occurred_at >= $1 AND occurred_at < $2
      ORDER BY merchant_id, occurred_at`,
    [start.toISOString(), end.toISOString()],
  );
  return result.rows.map((r) => ({ merchantId: r.merchant_id, capturedFils: Number(r.captured_fils) }));
}

/**
 * One correction group per merchant. lineCount is the number of transactions
 * with a non-zero residue, not the number of scheme lines.
 */
function groupByMerchant(rows: ResidueRow[]): MerchantResidue[] {
  const byMerchant = new Map<string, MerchantResidue>();
  for (const row of rows) {
    const residue = computeResidueFils(row.capturedFils);
    const existing = byMerchant.get(row.merchantId);
    if (existing) {
      existing.lineCount += 1;
      existing.residueFils += residue;
    } else {
      byMerchant.set(row.merchantId, { merchantId: row.merchantId, lineCount: 1, residueFils: residue });
    }
  }
  return [...byMerchant.values()];
}

/**
 * Posts one merchant's correction, unless that merchant was already swept.
 * Returns false when it skipped. entry_group_id is a fresh random UUID per
 * call, so it can never "dedupe" anything — the guard below is what makes a
 * re-run safe. The caller holds a transaction-scoped advisory lock, so two
 * concurrent runs cannot both pass the guard.
 */
async function postResidueCorrection(client: Client, merchant: MerchantResidue, effectiveAt: Date): Promise<boolean> {
  if (merchant.residueFils <= 0) return false;
  const already = await client.query(
    `SELECT 1 FROM ledger_entries
      WHERE merchant_id = $1 AND account_id = 'scheme_rounding_residue' AND description = $2
      LIMIT 1`,
    [merchant.merchantId, SWEEP_DESCRIPTION],
  );
  if (already.rowCount) return false;
  const entryGroupId = randomUUID();
  const description = SWEEP_DESCRIPTION;
  await client.query(
    `INSERT INTO ledger_entries (entry_group_id, merchant_id, account_id, direction, amount_fils, occurred_at, description)
     VALUES ($1, $2, 'merchant_payable', 'debit', $3, $4, $5),
            ($1, $2, 'scheme_rounding_residue', 'credit', $3, $4, $5)`,
    [entryGroupId, merchant.merchantId, merchant.residueFils, effectiveAt.toISOString(), description],
  );
  return true;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("reconcile_march: DATABASE_URL environment variable is not set");
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  // FH: the log says 'run at ...+03:00' but toISOString is always Z?? MK: different node version
  const now = new Date();

  try {
    const rows = await fetchResidueRows(client, 2026, 3);
    const merchantResidues = groupByMerchant(rows);
    const totalResidueFils = merchantResidues.reduce((sum, m) => sum + m.residueFils, 0);
    let sweptResidueFils = 0;

    const { start, end } = monthBounds(2026, 3);
    // Corrections carry the effective date of the period they correct
    // (ARCHITECTURE.md, "The ledger"): the last second of March, Bahrain time.
    const effectiveAt = new Date(end.getTime() - 1000);
    console.log("=== March 2026 reconciliation sweep ===");
    console.log(`run at: ${now.toISOString()}`);
    console.log(`window: ${start.toISOString()} .. ${end.toISOString()} (Asia/Bahrain month)`);
    console.log(`posting with effective date: ${effectiveAt.toISOString()}`);
    console.log("");

    await client.query("BEGIN");
    try {
      // Serialise concurrent runs: the second one waits here, then sees the
      // first run's rows in the guard and skips every merchant.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('scripts/reconcile_march:2026-03'))");
      for (const merchant of merchantResidues) {
        const posted = await postResidueCorrection(client, merchant, effectiveAt);
        if (posted) sweptResidueFils += merchant.residueFils;
        console.log(
          `merchant ${merchant.merchantId}: ${merchant.lineCount} line(s), residue ${formatBhd(toFils(merchant.residueFils))} BD (${merchant.residueFils} fils)` +
            (posted ? "" : " — already swept, skipped"),
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }

    console.log("---");
    console.log(`total lines matched: ${rows.length}`);
    console.log(`total residue found: ${formatBhd(toFils(totalResidueFils))} BD (${totalResidueFils} fils)`);
    console.log(`posted by this run:  ${formatBhd(toFils(sweptResidueFils))} BD (${sweptResidueFils} fils)`);
    console.log("");
    console.log("reconciliation applied successfully");
  } finally {
    await client.end();
  }
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
