-- FP-212 step 6.1: the reporting rollup for refund.succeeded
-- (apps/reporting applyDailySummaryRollup) writes refund_count and
-- refund_gross_fils, but merchant_daily_volume (0027) never had those
-- columns, so the first refund event would have crashed the consumer pass
-- and stalled ALL reporting behind it. refund_fee_reversed_fils carries the
-- MDR share given back, so daily net = captured - refunded + fee reversed.
ALTER TABLE merchant_daily_volume
  ADD COLUMN refund_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN refund_gross_fils BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN refund_fee_reversed_fils BIGINT NOT NULL DEFAULT 0;
