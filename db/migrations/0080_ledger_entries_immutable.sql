-- The ledger is append-only: "never alter past ledger history; post
-- corrective entries" (ARCHITECTURE.md). 0007's comment claimed this was
-- already enforced because the balance trigger also fires on UPDATE/DELETE —
-- but that trigger only rejects groups that end up UNBALANCED. Deleting an
-- entire group, or updating both legs of a group by the same amount, leaves
-- it balanced and was silently accepted (verified: a DELETE of a whole
-- group commits). Nothing in the application updates or deletes ledger rows.
CREATE FUNCTION reject_ledger_entry_mutation() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'ledger_entries is append-only: % is not allowed; post a corrective entry instead', TG_OP
        USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_append_only
    BEFORE UPDATE OR DELETE ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION reject_ledger_entry_mutation();

-- TRUNCATE is intentionally not blocked: it is not reachable from any
-- application path (it needs table-owner rights) and `npm run seed` uses it
-- to reset a dev database. In production the app role should not own the
-- table (HANDOVER.md "per-service DB roles", still open).
