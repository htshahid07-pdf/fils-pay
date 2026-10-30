-- Incident 2026-08-21: "Shops got two 'your payout is on the way' messages
-- for the same payout. Two processes checked at the same time, and both
-- thought they were first."
--
-- 1) settlement.paid enqueue. EnqueuePayoutNotifications ran
--    SELECT ... WHERE NOT EXISTS (outbox row) and then INSERTed, in separate
--    statements with nothing unique behind them. The daemon tick and a
--    `run-batch` CLI / internal-API run overlapping both passed the check.
--    Fix: a deduplication table keyed by batch. The enqueue claims the batch
--    here and inserts the outbox row in the SAME statement only if the claim
--    succeeded, so exactly one enqueue per batch can ever commit.
CREATE TABLE settlement_paid_notifications (
    settlement_batch_id UUID PRIMARY KEY REFERENCES settlement_batches (id),
    enqueued_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO settlement_paid_notifications (settlement_batch_id, enqueued_at)
SELECT aggregate_id, min(created_at)
  FROM outbox_events
 WHERE event_type = 'settlement.paid'
 GROUP BY aggregate_id
ON CONFLICT DO NOTHING;

-- 2) Payout disbursement records. These were written by the webhook
--    dispatcher as a "pre-delivery effect" of each settlement.paid DELIVERY:
--    once per merchant webhook endpoint, again for every replay, again for a
--    duplicated event — and never for a merchant with no endpoint. Now they
--    are written by PayoutBatch / PayoutSplitBatch in the same transaction
--    that marks the batch paid, at most once per batch.
--
--    Existing duplicate rows are real records of instructions already issued
--    and are NOT deleted here; they are listed for finance by the view below.
--    The unique index therefore covers every row written from now on.
DO $$
BEGIN
  EXECUTE format(
    'CREATE UNIQUE INDEX settlement_payout_disbursements_one_per_batch
         ON settlement_payout_disbursements (settlement_batch_id)
      WHERE created_at >= %L::timestamptz',
    now());
END $$;

CREATE VIEW settlement_payout_disbursement_duplicates AS
SELECT settlement_batch_id,
       count(*)          AS disbursement_count,
       sum(amount_fils)  AS total_disbursed_fils,
       min(created_at)   AS first_created_at,
       max(created_at)   AS last_created_at
  FROM settlement_payout_disbursements
 GROUP BY settlement_batch_id
HAVING count(*) > 1;
