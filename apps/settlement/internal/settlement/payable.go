package settlement

import (
	"github.com/filspay/settlement/internal/money"
)

// NetPayableFils derives the net payout from frozen gross and fee totals.
// Plain int64 subtraction of whole fils (ADR-0001). It used to convert both
// to float32 BD and back: float32 has a 24-bit mantissa, so above ~16,777 BD
// the result was off by several fils (135,000.123 - 3,375.003 came out as
// 131,625.125 instead of 131,625.120) — on the real payout figure.
func NetPayableFils(grossFils, feeFils money.Fils) money.Fils {
	return grossFils - feeFils
}
