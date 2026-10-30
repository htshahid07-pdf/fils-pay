#!/usr/bin/env bash
# FP-212 end-to-end check, the §3.5 Alpha Retail example from FEATURE_SPEC.md.
# Works against local or the live Dilmune Cloud URL:
#
#   BASE_URL=https://<host> ALPHA_KEY=<alpha api key> BETA_KEY=<beta api key> ./test-refund.sh
#
# Alpha Retail must be 2.25% MDR with no discount (fee on 6.000 BD = 135 fils).
# Exits non-zero on the first unexpected answer.
set -euo pipefail
BASE_URL="${BASE_URL:-http://localhost:3000}"
: "${ALPHA_KEY:?set ALPHA_KEY to Alpha Retail's API key}"
: "${BETA_KEY:?set BETA_KEY to Beta's API key}"

pass=0
uuid() { cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen 2>/dev/null || node -e "console.log(crypto.randomUUID())"; }
# call METHOD PATH KEY [IDEMPOTENCY_KEY|-] [JSON]  -> sets STATUS and BODY
call() {
  local method=$1 path=$2 key=$3 idem=${4:--} data=${5:-}
  local args=(-sS -o /tmp/fp212.body -w '%{http_code}' -X "$method" "$BASE_URL$path" -H "Authorization: Bearer $key")
  [ "$idem" != "-" ] && args+=(-H "Idempotency-Key: $idem")
  [ -n "$data" ] && args+=(-H 'Content-Type: application/json' -d "$data")
  STATUS=$(curl "${args[@]}"); BODY=$(cat /tmp/fp212.body)
}
expect() { # expect STATUS SUBSTRING LABEL
  if [ "$STATUS" = "$1" ] && [[ "$BODY" == *"$2"* ]]; then
    pass=$((pass + 1)); echo "PASS  $3  ($STATUS)"
  else
    echo "FAIL  $3: wanted $1 containing '$2', got $STATUS $BODY"; exit 1
  fi
}
field() { sed -n "s/.*\"$1\":\"\{0,1\}\([^,\"}]*\).*/\1/p" <<<"$BODY"; }

call POST /v1/transactions "$ALPHA_KEY" "$(uuid)" \
  '{"amountFils":10000,"card":{"pan":"4242424242424242","expiryMonth":12,"expiryYear":2030,"cvv":"123"},"reference":"fp212-demo"}'
expect 201 '"id"' "authorise 10.000 BD"
TXN=$(field id)
call POST "/v1/transactions/$TXN/capture" "$ALPHA_KEY" "$(uuid)" '{"amountFils":6000}'
expect 200 '"capturedFils":6000' "capture 6.000 BD"

call POST /v1/refunds "$ALPHA_KEY" - "{\"transactionId\":\"$TXN\"}"
expect 400 'idempotency_key_required' "no Idempotency-Key header -> 400"

call POST /v1/refunds "$ALPHA_KEY" "$(uuid)" "{\"transactionId\":\"$TXN\",\"amountFils\":9000}"
expect 422 '"refundableFils":6000' "refund 9.000 BD -> 422 refund_exceeds_refundable"

KEY=$(uuid)
call POST /v1/refunds "$ALPHA_KEY" "$KEY" "{\"transactionId\":\"$TXN\",\"amountFils\":2000,\"reason\":\"customer returned item\"}"
expect 200 '"feeReversedFils":45' "refund 2.000 BD -> fee reversed 45"
[[ "$BODY" == *'"transactionStatus":"partially_captured"'* ]] || { echo "FAIL status: $BODY"; exit 1; }
FIRST=$BODY
call POST /v1/refunds "$ALPHA_KEY" "$KEY" "{\"transactionId\":\"$TXN\",\"amountFils\":2000,\"reason\":\"customer returned item\"}"
# Compare as JSON, not bytes: the stored response comes back from a JSONB
# column, which may order keys differently. Same refund id and values = replay.
same_json() { node -e 'const s=(o)=>JSON.stringify(o,Object.keys(o).sort());process.exit(s(JSON.parse(process.argv[1]))===s(JSON.parse(process.argv[2]))?0:1)' "$1" "$2"; }
[ "$STATUS" = 200 ] && same_json "$BODY" "$FIRST" && { pass=$((pass + 1)); echo "PASS  same key + same body replays the original"; } \
  || { echo "FAIL replay: $STATUS $BODY"; exit 1; }
call POST /v1/refunds "$ALPHA_KEY" "$KEY" "{\"transactionId\":\"$TXN\",\"amountFils\":1000}"
expect 422 'idempotency_key_reused' "same key + different body -> 422"

call POST /v1/refunds "$BETA_KEY" "$(uuid)" "{\"transactionId\":\"$TXN\",\"amountFils\":100}"
expect 404 'transaction_not_found' "Beta refunds Alpha's transaction -> 404"

call POST /v1/refunds "$ALPHA_KEY" "$(uuid)" "{\"transactionId\":\"$TXN\"}"
expect 200 '"feeReversedFils":90' "refund the rest (4.000 BD) -> fee reversed 90"
[[ "$BODY" == *'"transactionStatus":"refunded"'* ]] || { echo "FAIL status: $BODY"; exit 1; }

call POST /v1/refunds "$ALPHA_KEY" "$(uuid)" "{\"transactionId\":\"$TXN\",\"amountFils\":1}"
expect 409 'transaction_not_refundable' "any further refund -> 409"

call GET "/v1/transactions/$TXN/events" "$ALPHA_KEY"
expect 200 '"amountFils":-4000' "timeline shows the negative refund amounts"

echo "all $pass checks passed against $BASE_URL"
