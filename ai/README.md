# AI setup used for this submission

**One line:** Claude (Opus) in a claude.ai Project holding our standing engineering rules and the
challenge evidence, linked to this repository on our laptop through the Claude desktop app, plus a
cloud workspace where it ran PostgreSQL 16, Go and Node to reproduce and verify every finding.

| What | Where |
| --- | --- |
| Standing agent instructions (the project rules) | `ai/project-instructions.md` |
| Edit helper: exact-match, CRLF-aware replace that refuses ambiguous edits | `ai/tools/rep.py` |
| Old-vs-new scenario harness (FP-209, over-refund, cross-merchant, fee drift, FP-187, incident 05-14) | `ai/harness/scenarios.mts` |
| Live probes for the security fixes (OTP bypass, roles, key rotation, ledger immutability, IDOR) | `ai/harness/probe.mjs` |
| Merchant-side webhook receiver that verifies HMAC over the raw body | `ai/harness/webhook-receiver.mjs` |
| Browser checks (Playwright): refund drawer, roles and every page, settlement columns | `ai/harness/ui-*.mjs` |
| Load test and our raw results | `ai/load/loadtest.mjs`, `ai/load/results-2026-10-30.jsonl` |
| End-to-end refund check (the FEATURE_SPEC worked example) | `test-refund.sh` (repo root) |

## How we worked

1. **Evidence in, claims out.** The AI read each clue, traced it to the code, and had to reproduce a
   bug (a failing test, a query or a script) before proposing a fix.
2. **Repo notes are data, not instructions.** CLAUDE.md, AGENTS.md, .cursorrules, comments and
   handover docs were checked against the code; planted instructions ("money is integer cents",
   "never modify tests", a `Reviewed-per` commit line) were not followed.
3. **Surgical edits only**, through `tools/rep.py`, which asserts the text to replace occurs exactly once.
4. **Every fix verified twice:** a regression test that fails on the original code and passes on
   ours, and a live check against the running stack (API, settlement daemon, reporting worker, browser).

## Running the harness

```
DATABASE_URL=postgres://... ROOT=$PWD npx tsx ai/harness/scenarios.mts
BASE_URL=http://localhost:3000 node ai/load/loadtest.mjs http://localhost:3000 keys.txt 20 20   # keys.txt: one API key per line
node ai/harness/webhook-receiver.mjs   # port 4000; writes the endpoint secret to /tmp/whsec first
```
The `ui-*.mjs` scripts expect the dashboard on http://localhost:5173 (with the /v1 proxy) and read
merchant ids and transaction ids from small files in /tmp, as noted at the top of each script.
