---
description: Make the smallest correct fix for a reproduced finding, with proof
argument-hint: <finding id>
---
Fix finding $ARGUMENTS. It must already have a failing reproduction.

1. Propose the smallest change that fixes the root cause, following CLAUDE.md
   section 2 (integer fils, Bahrain day, auth-scoped queries, recorded fees,
   append-only ledger, idempotency). Explain every changed line before editing.
2. Edit surgically (`python3 ai/tools/rep.py` for exact replacements). New
   migrations only; never edit an applied one; never touch `packages/money`.
3. Add or update a regression test that fails on the old code and passes now.
   If an existing test asserted the broken behaviour, change it and say why.
4. Run `npm run typecheck`, the affected test files, then the full suites.
   Paste the real counts.
5. Re-run the reproduction against the running stack and show the new result.
6. Write the finding entry: symptom, reproduction, root cause, fix,
   verification, effect on existing data.
7. Commit as `FP-212: <what changed>` only after the human approves.
