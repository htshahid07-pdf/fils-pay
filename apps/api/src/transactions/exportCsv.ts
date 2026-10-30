import type { Pool } from "pg";
import { formatBhd, toFils } from "@filspay/money";
import type { TransactionRow } from "./serialize.js";

export interface TransactionsExportFilters {
  merchantId: string;
  from?: Date;
  to?: Date;
  status?: string[];
}

function csvEscape(value: string): string {
  // CSV/formula injection: a merchant-controlled reference such as
  // "=HYPERLINK(...)" or "+cmd|..." is executed by Excel/Sheets when finance
  // opens the export. Prefix a quote so it is shown as text (OWASP).
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  if (safe.includes(",") || safe.includes('"') || safe.includes("\n") || safe.includes("\r")) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

function toCsvRow(row: TransactionRow): string {
  return [
    row.id,
    row.status,
    formatBhd(toFils(Number(row.amount_fils))),
    formatBhd(toFils(Number(row.captured_fils))),
    csvEscape(row.reference ?? ""),
    row.occurred_at.toISOString(),
  ].join(",");
}

/** Builds the CSV body for `GET /v1/transactions/export`. */
export async function buildTransactionsExportCsv(
  pool: Pool,
  filters: TransactionsExportFilters,
): Promise<string> {
  const statusArray = filters.status && filters.status.length > 0 ? filters.status : null;
  const result = await pool.query<TransactionRow>(
    `SELECT * FROM transactions
      WHERE merchant_id = $1
        AND ($2::timestamptz IS NULL OR occurred_at >= $2)
        AND ($3::timestamptz IS NULL OR occurred_at <  $3)
        AND ($4::text[] IS NULL OR status = ANY($4))
      ORDER BY occurred_at ASC`,
    [filters.merchantId, filters.from ?? null, filters.to ?? null, statusArray],
  );

  const header = "id,status,amount_bhd,captured_bhd,reference,occurred_at";
  const lines = result.rows.map(toCsvRow);
  return [header, ...lines].join("\n");
}


/**
 * Keyset-paginated export: at most PAGE_SIZE rows in memory at a time, so a
 * merchant with millions of transactions cannot exhaust the 512 MB API
 * container. Yields CSV text chunks for a streamed HTTP response.
 *
 * The cursor is (occurred_at, id), not occurred_at alone: with `occurred_at
 * > cursor` every row sharing the last timestamp of a page was skipped.
 */
export async function* transactionsExportCsvChunks(
  pool: Pool,
  filters: TransactionsExportFilters,
): AsyncGenerator<string> {
  yield "id,status,amount_bhd,captured_bhd,reference,occurred_at\n";
  let cursor: { occurredAt: Date; id: string } | null = null;
  const PAGE_SIZE = 1000;
  const statusArray = filters.status && filters.status.length > 0 ? filters.status : null;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result: { rows: TransactionRow[] } = await pool.query<TransactionRow>(
      `SELECT * FROM transactions
        WHERE merchant_id = $1
          AND ($2::timestamptz IS NULL OR occurred_at >= $2)
          AND ($3::timestamptz IS NULL OR occurred_at <  $3)
          AND ($4::text[] IS NULL OR status = ANY($4))
          AND ($5::timestamptz IS NULL OR (occurred_at, id) > ($5::timestamptz, $6::uuid))
        ORDER BY occurred_at ASC, id ASC
        LIMIT $7`,
      [
        filters.merchantId,
        filters.from ?? null,
        filters.to ?? null,
        statusArray,
        cursor?.occurredAt ?? null,
        cursor?.id ?? null,
        PAGE_SIZE,
      ],
    );
    if (result.rows.length > 0) {
      yield result.rows.map((row) => toCsvRow(row) + "\n").join("");
    }
    if (result.rows.length < PAGE_SIZE) break;
    const last = result.rows[result.rows.length - 1]!;
    cursor = { occurredAt: last.occurred_at, id: last.id };
  }
}

/** Cursor-paginated export for large date ranges (callback form). */
export async function streamTransactionsExportCsv(
  pool: Pool,
  filters: TransactionsExportFilters,
  write: (chunk: string) => void,
): Promise<void> {
  for await (const chunk of transactionsExportCsvChunks(pool, filters)) {
    write(chunk);
  }
}
