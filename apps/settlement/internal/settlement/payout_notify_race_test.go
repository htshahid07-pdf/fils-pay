package settlement

import (
	"context"
	"sync"
	"testing"
	"time"
)

// TestEnqueuePayoutNotifications_ConcurrentRunsEnqueueOnce is the regression
// test for incident 2026-08-21 ("two processes checked at the same time, and
// both thought they were first"): the daemon tick and a CLI/internal-API run
// overlapping must produce exactly one settlement.paid event per batch, and
// the batch must have exactly one payout disbursement record.
func TestEnqueuePayoutNotifications_ConcurrentRunsEnqueueOnce(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	businessDate := time.Date(2026, 8, 20, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)
	insertCaptureEvent(t, pool, merchantID, mdrBps, 50_000, start.Add(time.Hour))

	closed, err := CloseBatch(ctx, pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	if _, err := PayoutBatch(ctx, pool, closed.BatchID); err != nil {
		t.Fatalf("PayoutBatch: %v", err)
	}

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := EnqueuePayoutNotifications(ctx, pool); err != nil {
				t.Errorf("EnqueuePayoutNotifications: %v", err)
			}
		}()
	}
	wg.Wait()

	if n := countRows(t, pool, `SELECT count(*) FROM outbox_events WHERE event_type = 'settlement.paid' AND aggregate_id = $1`, closed.BatchID); n != 1 {
		t.Fatalf("settlement.paid events for the batch = %d, want exactly 1", n)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM settlement_payout_disbursements WHERE settlement_batch_id = $1`, closed.BatchID); n != 1 {
		t.Fatalf("disbursement records for the batch = %d, want exactly 1 (written by PayoutBatch)", n)
	}
}
