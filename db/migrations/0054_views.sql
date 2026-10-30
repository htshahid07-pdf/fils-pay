-- Convenience views used by the API and admin dashboard.
--
-- Fixed so a fresh database can migrate at all. As committed, this file
-- referenced a table that does not exist (settlement_batch_events — the
-- schema records batching as transaction_events.settlement_batch_id, 0023),
-- so `npm run migrate` aborted here and NOTHING after 0053 was ever applied
-- (refund columns, credits, adjustment imports, ...). HANDOVER.md confirms
-- 0054 never ran on any database, so correcting it in place is safe.
--
-- merchant_payable_position now reports the merchant's payable from the
-- LEDGER (the only source of truth for money). It summed scheme export
-- gross amounts, which is what made the admin "Rebuild cached balances"
-- button write 7K over a 135K balance (see ledger/refresh.go).

CREATE OR REPLACE VIEW merchant_payable_position AS
SELECT merchant_id,
       COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0) AS payable_fils
  FROM ledger_entries
 WHERE account_id = 'merchant_payable'
 GROUP BY merchant_id;

CREATE OR REPLACE VIEW v_unbatched_capture_events AS
SELECT te.id AS event_id,
       te.transaction_id,
       te.event_type,
       te.amount_fils,
       te.created_at,
       t.merchant_id
  FROM transaction_events te
  JOIN transactions t ON t.id = te.transaction_id
 WHERE te.event_type IN ('captured', 'partially_captured')
   AND te.settlement_batch_id IS NULL;

CREATE OR REPLACE VIEW v_active_api_keys AS
SELECT ak.id,
       ak.merchant_id,
       ak.key_prefix,
       ak.created_at,
       ak.label
  FROM api_keys ak
 WHERE ak.revoked_at IS NULL;
