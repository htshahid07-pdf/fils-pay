-- FP-212 step 6.2: refund_merchant_summary.
-- 0072 joined `t.id = r.id` (never matches -> view always empty); 0079
-- corrected the join to r.transaction_id. It still did SUM(t.captured_fils)
-- across the refund rows: a transaction refunded three times in one day had
-- its captured amount counted three times. The original captured total is
-- now summed over DISTINCT transactions per merchant/day.
DROP MATERIALIZED VIEW IF EXISTS refund_merchant_summary;

CREATE MATERIALIZED VIEW refund_merchant_summary AS
WITH r AS (
    SELECT merchant_id,
           transaction_id,
           date_trunc('day', occurred_at AT TIME ZONE 'Asia/Bahrain') AS business_date,
           amount_fils,
           fee_reversed_fils
      FROM refunds
     WHERE status = 'succeeded'
),
refund_totals AS (
    SELECT merchant_id,
           business_date,
           COUNT(*)               AS refund_count,
           SUM(amount_fils)       AS total_refunded_fils,
           SUM(fee_reversed_fils) AS total_fee_reversed_fils
      FROM r
  GROUP BY merchant_id, business_date
),
captured_totals AS (
    SELECT d.merchant_id, d.business_date, SUM(t.captured_fils) AS original_captured_fils
      FROM (SELECT DISTINCT merchant_id, business_date, transaction_id FROM r) d
      JOIN transactions t ON t.id = d.transaction_id
  GROUP BY d.merchant_id, d.business_date
)
SELECT rt.merchant_id,
       rt.business_date,
       rt.refund_count,
       rt.total_refunded_fils,
       rt.total_fee_reversed_fils,
       COALESCE(ct.original_captured_fils, 0) AS original_captured_fils
  FROM refund_totals rt
  LEFT JOIN captured_totals ct
    ON ct.merchant_id = rt.merchant_id AND ct.business_date = rt.business_date;

CREATE UNIQUE INDEX idx_refund_merchant_summary_pk
    ON refund_merchant_summary (merchant_id, business_date);
