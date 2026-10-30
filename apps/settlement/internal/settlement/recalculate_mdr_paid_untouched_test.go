package settlement

import (
	"context"
	"testing"
	"time"
)

// TestRecalculateMDR_LeavesPaidBatchesAlone is the regression test for "MDR
// recalculation changed batches that were already paid out". RecalculateMDR
// selected every batch with status <> 'open', i.e. closed AND paid, and
// rewrote fee_fils / net_payout_fils on batches whose payout had already
// been sent.
func TestRecalculateMDR_LeavesPaidBatchesAlone(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const oldMdrBps = 250
	merchantID := insertActiveMerchant(t, pool, oldMdrBps)
	businessDate := time.Date(2026, 4, 2, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)
	insertCaptureEvent(t, pool, merchantID, oldMdrBps, 100_000, start.Add(time.Hour))

	closed, err := CloseBatch(ctx, pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	if _, err := PayoutBatch(ctx, pool, closed.BatchID); err != nil {
		t.Fatalf("PayoutBatch: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE merchants SET mdr_bps = 100 WHERE id = $1`, merchantID); err != nil {
		t.Fatalf("change rate: %v", err)
	}

	result, err := RecalculateMDR(ctx, pool, merchantID, businessDate, businessDate.AddDate(0, 0, 1))
	if err != nil {
		t.Fatalf("RecalculateMDR: %v", err)
	}
	if result.BatchesConsidered != 0 || len(result.Adjusted) != 0 {
		t.Fatalf("paid batch was considered/adjusted: %+v", result)
	}

	var fee, net int64
	if err := pool.QueryRow(ctx, `SELECT fee_fils, net_payout_fils FROM settlement_batches WHERE id = $1`, closed.BatchID).
		Scan(&fee, &net); err != nil {
		t.Fatalf("read batch: %v", err)
	}
	if fee != int64(closed.FeeFils) || net != int64(closed.NetPayoutFils) {
		t.Fatalf("paid batch changed: fee %d -> %d, net %d -> %d", closed.FeeFils, fee, closed.NetPayoutFils, net)
	}
}
