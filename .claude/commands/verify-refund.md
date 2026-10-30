---
description: End-to-end check of full and partial refunds, ledger and settlement
---
Verify refunds end to end against the running stack:

1. `./test-refund.sh` with BASE_URL and two merchant keys from the seed output.
   Every check must pass; paste the summary.
2. Run the integrity queries: no unbalanced `entry_group_id`, no transaction
   with `refunded_fils > captured_fils`, no stuck idempotency claims.
3. Open the dashboard: the transaction timeline shows each refund, and the
   settlement page shows Refunded and Fee reversed so that
   gross - fee - refunded + fee reversed = net.
4. Report any number that does not match, with the query that shows it.
