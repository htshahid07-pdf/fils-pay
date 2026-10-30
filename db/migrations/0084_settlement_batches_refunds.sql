-- FP-212 step 8: refunds reduce the merchant's NEXT settlement batch.
-- gross_fils and fee_fils stay capture-only (they feed the scheme file and
-- the platform volume counter). The refund side is frozen beside them, so
-- net_payout_fils = gross_fils - fee_fils - refunded_fils + fee_reversed_fils
-- is auditable from the row itself. Existing batches had no refunds: 0.
ALTER TABLE settlement_batches
  ADD COLUMN refunded_fils BIGINT NOT NULL DEFAULT 0 CHECK (refunded_fils >= 0),
  ADD COLUMN fee_reversed_fils BIGINT NOT NULL DEFAULT 0 CHECK (fee_reversed_fils >= 0);
