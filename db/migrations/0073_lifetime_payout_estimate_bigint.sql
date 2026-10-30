-- merchants.lifetime_net_payout_monitoring_estimate was REAL (float32, 0040).
-- float32 has a 24-bit mantissa: once a merchant's running total passes
-- 16,777,216 fils (~16,777 BD) adding a small payout rounds to the nearest
-- representable value, so the figure drifts further from the truth with
-- every batch ("lifetime payout estimate drifts for high-volume merchants").
-- Money is whole fils in BIGINT (ADR-0001).
--
-- The drifted values cannot be trusted, so rebuild them from the source of
-- truth: the sum of net_payout_fils over the merchant's paid batches, which
-- is exactly what PayoutBatch / PayoutSplitBatch add as each batch is paid.

ALTER TABLE merchants
    ALTER COLUMN lifetime_net_payout_monitoring_estimate DROP DEFAULT,
    ALTER COLUMN lifetime_net_payout_monitoring_estimate TYPE BIGINT USING 0,
    ALTER COLUMN lifetime_net_payout_monitoring_estimate SET DEFAULT 0;

UPDATE merchants m
   SET lifetime_net_payout_monitoring_estimate = paid.total_fils
  FROM (
        SELECT merchant_id, SUM(net_payout_fils) AS total_fils
          FROM settlement_batches
         WHERE status = 'paid'
         GROUP BY merchant_id
       ) paid
 WHERE paid.merchant_id = m.id;
