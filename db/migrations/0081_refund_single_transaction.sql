-- FP-212 step 3: processRefund now runs claim -> FOR UPDATE -> validate ->
-- acquirer -> journal in ONE transaction (the capture.ts shape). The row
-- lock is held across the acquirer call, so the in-flight reservation column
-- added by 0078 (refund_pending_fils) has no job left. Drop it and keep the
-- database-level guard in its simpler form: never refund more than was
-- actually captured. NOT VALID, so it applies to every new write without
-- failing on any odd legacy row.
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS chk_transactions_refund_within_captured;
ALTER TABLE transactions DROP COLUMN IF EXISTS refund_pending_fils;
ALTER TABLE transactions
    ADD CONSTRAINT chk_transactions_refund_within_captured
        CHECK (refunded_fils <= captured_fils) NOT VALID;
