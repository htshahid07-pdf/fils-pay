-- "One of the reporting queries is suspiciously slow."
--
-- getBreakdown (analytics) filters transactions on (merchant_id, created_at),
-- but the only per-merchant index is (merchant_id, occurred_at, id), so the
-- breakdown scanned all of a merchant's transactions. getRecentLedgerActivity
-- is fixed in the query itself (it wrapped the indexed column in a function).
CREATE INDEX IF NOT EXISTS idx_transactions_merchant_created
    ON transactions (merchant_id, created_at);

-- 0072's refund_merchant_summary joined `t.id = r.id` — a refund's own id
-- against a transaction id. They never match, so the view was always empty.
-- The refund belongs to r.transaction_id.
DROP MATERIALIZED VIEW IF EXISTS refund_merchant_summary;

CREATE MATERIALIZED VIEW refund_merchant_summary AS
SELECT
    r.merchant_id,
    date_trunc('day', r.occurred_at AT TIME ZONE 'Asia/Bahrain') AS business_date,
    COUNT(*)                     AS refund_count,
    SUM(r.amount_fils)           AS total_refunded_fils,
    SUM(r.fee_reversed_fils)     AS total_fee_reversed_fils,
    SUM(t.captured_fils)         AS original_captured_fils
FROM refunds r
JOIN transactions t ON t.id = r.transaction_id
WHERE r.status = 'succeeded'
GROUP BY r.merchant_id, date_trunc('day', r.occurred_at AT TIME ZONE 'Asia/Bahrain');

CREATE UNIQUE INDEX idx_refund_merchant_summary_pk
    ON refund_merchant_summary (merchant_id, business_date);
