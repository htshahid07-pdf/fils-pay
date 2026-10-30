package ledger

import (
	"context"
	"testing"
)

// TestRefreshBalanceCache_UsesLedgerNotSchemeLines is the regression test for
// "Recalculate cached balances: Alpha Retail went from 135K to 7K". When the
// ledger and the scheme export lines disagree (they always do: the ledger
// has refunds, fees, credits, payouts; scheme lines have only gross
// captures), the cached balance must equal the ledger — same as the CLI.
func TestRefreshBalanceCache_UsesLedgerNotSchemeLines(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool)

	// Scheme line says 7,000 fils; the ledger says 135,000 fils.
	insertClosedBatchWithLine(t, pool, merchantID, "2026-06-20", 7000, 1)
	_, err := pool.Exec(ctx, `
		INSERT INTO ledger_entries (entry_group_id, merchant_id, account_id, direction, amount_fils, occurred_at, description)
		SELECT g, $1, a, d, 128000, now(), 'manual credit fixture'
		  FROM (SELECT gen_random_uuid() AS g) x,
		       (VALUES ('platform_cash', 'debit'), ('merchant_payable', 'credit')) v(a, d)
	`, merchantID)
	if err != nil {
		t.Fatalf("insert ledger credit: %v", err)
	}

	refreshed, err := RefreshBalanceCache(ctx, pool)
	if err != nil {
		t.Fatalf("RefreshBalanceCache: %v", err)
	}
	rebuilt, err := RebuildMerchantBalance(ctx, pool, merchantID)
	if err != nil {
		t.Fatalf("RebuildMerchantBalance: %v", err)
	}
	if rebuilt != 135000 {
		t.Fatalf("ledger balance = %d, want 135000", rebuilt)
	}
	if got := refreshed[merchantID].Rebuilt; got != rebuilt {
		t.Fatalf("button path = %d, CLI path = %d: they must agree (ledger)", got, rebuilt)
	}
}
