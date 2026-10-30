package settlement

// FP-212 step 8: refunds reduce the merchant's NEXT settlement batch.
// DB-backed; skips without DATABASE_URL like the rest of batch_test.go.

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/filspay/settlement/internal/money"
)

// insertRefund writes exactly what apps/api's processRefund writes for one
// refund: the refunds row, the refund transaction_events row (negative
// amount, metadata refundId/feeReversedFils), and the balanced ledger legs.
func insertRefund(t *testing.T, pool *pgxpool.Pool, merchantID, txnID uuid.UUID, amount, feeReversed money.Fils, at time.Time) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	var refundID uuid.UUID
	if err := pool.QueryRow(ctx, `
		INSERT INTO refunds (transaction_id, merchant_id, amount_fils, fee_reversed_fils, status, acquirer_reference,
		                     reason, created_by_type, created_by_id, occurred_at)
		VALUES ($1, $2, $3, $4, 'succeeded', 'acq', 'unspecified', 'merchant_api_key', $5, $6)
		RETURNING id
	`, txnID, merchantID, int64(amount), int64(feeReversed), uuid.New(), at).Scan(&refundID); err != nil {
		t.Fatalf("insertRefund: refunds: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO transaction_events (transaction_id, event_type, amount_fils, actor_type, occurred_at, metadata)
		VALUES ($1, 'refund_partial', $2, 'system', $3,
		        jsonb_build_object('refundId', $4::text, 'feeReversedFils', $5::bigint, 'acquirerReference', 'acq'))
	`, txnID, -int64(amount), at, refundID.String(), int64(feeReversed)); err != nil {
		t.Fatalf("insertRefund: transaction_events: %v", err)
	}
	group := uuid.New()
	if _, err := pool.Exec(ctx, `
		INSERT INTO ledger_entries (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
		VALUES ($1, $2, $3, 'merchant_payable', 'debit', $4, $5, 'refund: gross'),
		       ($1, $2, $3, 'card_scheme_clearing', 'credit', $4, $5, 'refund: gross')
	`, group, merchantID, txnID, int64(amount), at); err != nil {
		t.Fatalf("insertRefund: gross legs: %v", err)
	}
	if feeReversed > 0 {
		if _, err := pool.Exec(ctx, `
			INSERT INTO ledger_entries (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
			VALUES ($1, $2, $3, 'platform_fee_revenue', 'debit', $4, $5, 'refund: MDR fee reversal'),
			       ($1, $2, $3, 'merchant_payable', 'credit', $4, $5, 'refund: MDR fee reversal')
		`, group, merchantID, txnID, int64(feeReversed), at); err != nil {
			t.Fatalf("insertRefund: fee legs: %v", err)
		}
	}
	return refundID
}

func TestCloseBatch_RefundReducesNet(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const mdrBps = 225
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	businessDate := time.Date(2026, 4, 10, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)

	txnID, _ := insertCaptureEvent(t, pool, merchantID, mdrBps, 10_000, start.Add(2*time.Hour))
	refundID := insertRefund(t, pool, merchantID, txnID, 2_000, 45, start.Add(5*time.Hour))

	res, err := CloseBatch(ctx, pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	if res.GrossFils != 10_000 || res.RefundedFils != 2_000 || res.FeeReversedFils != 45 {
		t.Fatalf("gross/refunded/feeReversed = %d/%d/%d, want 10000/2000/45", res.GrossFils, res.RefundedFils, res.FeeReversedFils)
	}
	if want := res.GrossFils - res.FeeFils - 2_000 + 45; res.NetPayoutFils != want {
		t.Fatalf("net = %d, want gross - fee - refunded + fee_reversed = %d", res.NetPayoutFils, want)
	}
	if res.FeeFils == 225 && res.NetPayoutFils != 7_820 {
		t.Fatalf("spec example: net = %d, want 7820", res.NetPayoutFils)
	}

	var gross, fee, refunded, feeRev, net int64
	if err := pool.QueryRow(ctx, `
		SELECT gross_fils, fee_fils, refunded_fils, fee_reversed_fils, net_payout_fils FROM settlement_batches WHERE id = $1
	`, res.BatchID).Scan(&gross, &fee, &refunded, &feeRev, &net); err != nil {
		t.Fatal(err)
	}
	if gross-fee-refunded+feeRev != net || refunded != 2_000 || feeRev != 45 {
		t.Fatalf("frozen row inconsistent: %d %d %d %d %d", gross, fee, refunded, feeRev, net)
	}
	if n := countRows(t, pool, `SELECT 1 FROM refunds WHERE id = $1 AND settlement_batch_id = $2`, refundID, res.BatchID); n != 1 {
		t.Fatalf("refunds row not claimed by the batch")
	}
	if n := countRows(t, pool, `SELECT 1 FROM transaction_events WHERE transaction_id = $1 AND event_type = 'refund_partial' AND settlement_batch_id = $2`, txnID, res.BatchID); n != 1 {
		t.Fatalf("refund event not claimed by the batch")
	}
	// Scheme file stays capture-only (amount_fils >= 0 CHECK): one line, the capture.
	if n := countRows(t, pool, `SELECT 1 FROM scheme_export_lines WHERE settlement_batch_id = $1 AND amount_fils = 10000`, res.BatchID); n != 1 {
		t.Fatalf("scheme export should hold exactly the capture line")
	}
	// Re-close is a no-op that reports the same refund figures.
	again, err := CloseBatch(ctx, pool, merchantID, businessDate)
	if err != nil || !again.AlreadyClosed || again.RefundedFils != 2_000 || again.NetPayoutFils != res.NetPayoutFils {
		t.Fatalf("re-close: %+v %v", again, err)
	}
}

func TestCloseBatch_RefundsNeverDriveNetNegative_CarryOver(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const mdrBps = 225
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	day1 := time.Date(2026, 4, 20, 0, 0, 0, 0, time.UTC)
	day2 := day1.AddDate(0, 0, 1)
	s1, _ := BusinessDayWindow(day1)
	s2, _ := BusinessDayWindow(day2)

	// Day 1: 1.000 BD captured, but 0.500 + 0.600 BD of refunds (of an older capture).
	older, _ := insertCaptureEvent(t, pool, merchantID, mdrBps, 5_000, s1.Add(-48*time.Hour))
	insertCaptureEvent(t, pool, merchantID, mdrBps, 1_000, s1.Add(1*time.Hour))
	first := insertRefund(t, pool, merchantID, older, 500, 11, s1.Add(2*time.Hour))
	second := insertRefund(t, pool, merchantID, older, 600, 14, s1.Add(3*time.Hour))

	r1, err := CloseBatch(ctx, pool, merchantID, day1)
	if err != nil {
		t.Fatalf("CloseBatch day1: %v", err)
	}
	if r1.NetPayoutFils < 0 {
		t.Fatalf("net went negative: %d", r1.NetPayoutFils)
	}
	if r1.RefundedFils != 500 || r1.FeeReversedFils != 11 || r1.RefundEventCount != 1 {
		t.Fatalf("day1 should include only the first refund: %+v", r1)
	}
	if n := countRows(t, pool, `SELECT 1 FROM refunds WHERE id = $1 AND settlement_batch_id IS NULL`, second); n != 1 {
		t.Fatalf("the refund that did not fit must stay unbatched")
	}

	// Day 2: a 2.000 BD capture; the 0.600 BD refund carries over into it.
	insertCaptureEvent(t, pool, merchantID, mdrBps, 2_000, s2.Add(1*time.Hour))
	r2, err := CloseBatch(ctx, pool, merchantID, day2)
	if err != nil {
		t.Fatalf("CloseBatch day2: %v", err)
	}
	if r2.RefundedFils != 600 || r2.FeeReversedFils != 14 {
		t.Fatalf("day2 should carry the second refund: %+v", r2)
	}
	if r2.NetPayoutFils != r2.GrossFils-r2.FeeFils-600+14 {
		t.Fatalf("day2 net = %d", r2.NetPayoutFils)
	}
	_ = first
}

func TestRecalculateMDR_KeepsRefundDeduction(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const mdrBps = 225
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	day := time.Date(2026, 5, 2, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(day)
	txnID, _ := insertCaptureEvent(t, pool, merchantID, mdrBps, 10_000, start.Add(time.Hour))
	insertRefund(t, pool, merchantID, txnID, 2_000, 45, start.Add(2*time.Hour))
	closed, err := CloseBatch(ctx, pool, merchantID, day)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}

	if _, err := pool.Exec(ctx, `UPDATE merchants SET mdr_bps = 300 WHERE id = $1`, merchantID); err != nil {
		t.Fatal(err)
	}
	res, err := RecalculateMDR(ctx, pool, merchantID, day, day.AddDate(0, 0, 1))
	if err != nil {
		t.Fatalf("RecalculateMDR: %v", err)
	}
	if len(res.Adjusted) != 1 {
		t.Fatalf("adjusted = %+v", res.Adjusted)
	}
	adj := res.Adjusted[0]
	// Fee is recomputed over the CAPTURE only: 3.00% of 10000 = 300. The
	// refund event (-2000) must not shrink it.
	if adj.NewFeeFils != ComputeSettlementFee(10_000, 300, 0) {
		t.Fatalf("new fee = %d, want %d (capture events only)", adj.NewFeeFils, ComputeSettlementFee(10_000, 300, 0))
	}
	var net int64
	if err := pool.QueryRow(ctx, `SELECT net_payout_fils FROM settlement_batches WHERE id = $1`, closed.BatchID).Scan(&net); err != nil {
		t.Fatal(err)
	}
	if want := int64(closed.NetPayoutFils - adj.DiffFils); net != want {
		t.Fatalf("net after recalculation = %d, want %d (refund deduction must survive)", net, want)
	}
}
