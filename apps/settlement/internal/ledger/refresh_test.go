package ledger

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func insertClosedBatchWithLine(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID, batchDate string, amountFils int64, lineSequence int) uuid.UUID {
	t.Helper()
	ctx := context.Background()

	var batchID uuid.UUID
	err := pool.QueryRow(ctx, `
		INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, closed_at)
		VALUES ($1, $2, 'closed', $3, 0, $3, now())
		RETURNING id
	`, merchantID, batchDate, amountFils).Scan(&batchID)
	if err != nil {
		t.Fatalf("insertClosedBatchWithLine: insert batch: %v", err)
	}

	_, err = pool.Exec(ctx, `
		INSERT INTO scheme_export_lines (settlement_batch_id, amount_fils, line_sequence)
		VALUES ($1, $2, $3)
	`, batchID, amountFils, lineSequence)
	if err != nil {
		t.Fatalf("insertClosedBatchWithLine: insert export line: %v", err)
	}

	// The merchant's payable lives in the ledger. This fixture used to write
	// only the scheme export line, and RefreshBalanceCache read the balance
	// from scheme lines (the 135K -> 7K bug); post the balanced capture group
	// a real close is preceded by, so the expected figure comes from the ledger.
	_, err = pool.Exec(ctx, `
		INSERT INTO ledger_entries (entry_group_id, merchant_id, settlement_batch_id, account_id, direction, amount_fils, occurred_at, description)
		SELECT g, $1, $2, a, d, $3, now(), 'refresh_test fixture'
		  FROM (SELECT gen_random_uuid() AS g) x,
		       (VALUES ('card_scheme_clearing', 'debit'), ('merchant_payable', 'credit')) v(a, d)
	`, merchantID, batchID, amountFils)
	if err != nil {
		t.Fatalf("insertClosedBatchWithLine: insert ledger group: %v", err)
	}

	return batchID
}

func TestRefreshBalanceCache_OverwritesDriftedCache(t *testing.T) {
	pool := mustPool(t)
	lockBalanceTests(t, pool)
	merchantID := insertActiveMerchant(t, pool)

	insertClosedBatchWithLine(t, pool, merchantID, "2026-06-10", 25000, 1)
	want := int64(25000)

	_, err := pool.Exec(context.Background(), `
		INSERT INTO merchant_balances (merchant_id, cached_payable_fils, updated_at)
		VALUES ($1, 888888, now())
	`, merchantID)
	if err != nil {
		t.Fatalf("seed drifted cache: %v", err)
	}

	diffs, err := RefreshBalanceCache(context.Background(), pool)
	if err != nil {
		t.Fatalf("RefreshBalanceCache: %v", err)
	}

	diff, ok := diffs[merchantID]
	if !ok {
		t.Fatalf("RefreshBalanceCache did not return a diff for merchant %s", merchantID)
	}
	if diff.CachedBefore != 888888 {
		t.Errorf("diff.CachedBefore = %d, want 888888", diff.CachedBefore)
	}
	if int64(diff.Rebuilt) != want {
		t.Errorf("diff.Rebuilt = %d, want %d", diff.Rebuilt, want)
	}
	if !diff.Changed() {
		t.Error("diff.Changed() = false, want true")
	}

	var persisted int64
	err = pool.QueryRow(context.Background(), `SELECT cached_payable_fils FROM merchant_balances WHERE merchant_id = $1`, merchantID).Scan(&persisted)
	if err != nil {
		t.Fatalf("query persisted balance: %v", err)
	}
	if persisted != want {
		t.Errorf("persisted cached_payable_fils = %d, want %d", persisted, want)
	}
}

func TestRefreshBalanceCache_SumsAcrossBatches(t *testing.T) {
	pool := mustPool(t)
	lockBalanceTests(t, pool)
	merchantID := insertActiveMerchant(t, pool)

	insertClosedBatchWithLine(t, pool, merchantID, "2026-06-11", 15000, 1)
	insertClosedBatchWithLine(t, pool, merchantID, "2026-06-12", 6000, 1)

	want := int64(15000 + 6000)

	diffs, err := RefreshBalanceCache(context.Background(), pool)
	if err != nil {
		t.Fatalf("RefreshBalanceCache: %v", err)
	}

	diff, ok := diffs[merchantID]
	if !ok {
		t.Fatalf("RefreshBalanceCache did not return a diff for merchant %s", merchantID)
	}
	if int64(diff.Rebuilt) != want {
		t.Errorf("diff.Rebuilt = %d, want %d", diff.Rebuilt, want)
	}
}
