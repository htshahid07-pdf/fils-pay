-- FP-201 (reopened): "The bank sent the same callback twice and we saved two
-- identical notes on one payment. The 1.9.0 postmortem says this was fixed."
--
-- It never was. 0051 deliberately left callback_id non-unique and pointed at
-- a `processed_events` table and an FP-238 unique index — neither exists
-- anywhere in the schema (commit bf66bf2, "callbacks are deduplicated now",
-- changes nothing). applyAcquirerCallback did a plain INSERT, so every
-- redelivery (and every withCallbackRetry attempt after a timeout) added a row.
--
-- The acquirer's callbackId identifies one callback; one row per callbackId.
-- Existing duplicates are removed first (keeping the earliest-received row)
-- or the unique index cannot be built. These are notes, not ledger entries.

DELETE FROM acquirer_callback_notes n
 USING acquirer_callback_notes keep
 WHERE n.callback_id = keep.callback_id
   AND (keep.created_at, keep.id) < (n.created_at, n.id);

CREATE UNIQUE INDEX acquirer_callback_notes_callback_id_key
    ON acquirer_callback_notes (callback_id);
