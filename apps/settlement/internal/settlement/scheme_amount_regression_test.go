package settlement

import (
	"context"
	"testing"
	"time"

	"github.com/filspay/settlement/internal/money"
)

// TestCloseBatch_SchemeAmountMatchesTruncatedFils is the regression test for
// "scheme statement always a few fils over". scheme_export_lines.amount is
// NUMERIC(10,2); CloseBatch used to write the *untruncated* gross into it,
// and Postgres rounds half-up on assignment, so 4.755 BD was exported as
// 4.76 while amount_fils (and our ledger) said 4.750. The exported amount
// must always be exactly amount_fils / 1000 and never exceed the capture.
func TestCloseBatch_SchemeAmountMatchesTruncatedFils(t *testing.T) {
	pool := mustPool(t)
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	businessDate := time.Date(2026, 3, 25, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)

	// gross -> expected scheme amount. Every case with a third digit >= 5
	// was rounded UP by the old code (4755 -> "4.76", 4995 -> "5.00").
	cases := map[money.Fils]string{
		4755:  "4.75",
		4995:  "4.99",
		1005:  "1.00",
		4747:  "4.74",
		12344: "12.34",
		4740:  "4.74",
	}
	i := 0
	for gross := range cases {
		i++
		insertCaptureEvent(t, pool, merchantID, mdrBps, gross, start.Add(time.Duration(i)*time.Minute))
	}

	result, err := CloseBatch(context.Background(), pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}

	rows, err := pool.Query(context.Background(), `
		SELECT t.captured_fils, sel.amount_fils, sel.amount::text
		  FROM scheme_export_lines sel
		  JOIN transactions t ON t.id = sel.transaction_id
		 WHERE sel.settlement_batch_id = $1
	`, result.BatchID)
	if err != nil {
		t.Fatalf("query scheme_export_lines: %v", err)
	}
	defer rows.Close()

	seen := 0
	for rows.Next() {
		var gross, amountFils int64
		var amount string
		if err := rows.Scan(&gross, &amountFils, &amount); err != nil {
			t.Fatalf("scan: %v", err)
		}
		seen++
		if want := cases[money.Fils(gross)]; amount != want {
			t.Errorf("gross %d fils: scheme amount = %q, want %q (truncated, never rounded up)", gross, amount, want)
		}
		if want := formatFilsAsTwoDecimalString(money.Fils(amountFils)); amount != want {
			t.Errorf("gross %d fils: amount %q disagrees with amount_fils %d (%q)", gross, amount, amountFils, want)
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate: %v", err)
	}
	if seen != len(cases) {
		t.Fatalf("expected %d scheme lines, got %d", len(cases), seen)
	}
}
