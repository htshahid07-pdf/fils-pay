-- FP-209 "Concurrent refund: double money out" and "can you refund more than
-- what was actually charged?".
--
-- processRefund read the transaction WITHOUT a lock, released it, called the
-- acquirer, then wrote `refunded_fils = <value read earlier> + amount`. Two
-- refunds with different Idempotency-Keys both saw refunded_fils = 0, both
-- passed validation, both were paid by the acquirer, and the second write
-- overwrote the first (lost update). Capture never had this problem because
-- it holds SELECT ... FOR UPDATE for its whole decision.
--
-- refund_pending_fils is the amount reserved by refunds that have passed
-- validation but whose acquirer call has not finished. It is reserved under
-- the row lock BEFORE the acquirer is called and counted against what is
-- still refundable, so a concurrent refund sees it.
ALTER TABLE transactions
    ADD COLUMN refund_pending_fils BIGINT NOT NULL DEFAULT 0
        CHECK (refund_pending_fils >= 0);

-- Last line of defence, enforced by the database itself: never refund (or
-- reserve) more than was actually captured. NOT VALID so it applies to every
-- new write without failing on any odd legacy row.
ALTER TABLE transactions
    ADD CONSTRAINT chk_transactions_refund_within_captured
        CHECK (refunded_fils + refund_pending_fils <= captured_fils) NOT VALID;
