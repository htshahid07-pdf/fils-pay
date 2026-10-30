package splits

import (
	"testing"

	"github.com/filspay/settlement/internal/money"
)

// TestChildShares_NeverLosesAFils is the regression test for "split payouts
// for Delta Marketplace don't add up to the parent's total". Rounding each
// child independently lost (or invented) fils whenever the split did not
// divide evenly; the shares must now always sum to exactly the net payout.
func TestChildShares_NeverLosesAFils(t *testing.T) {
	cases := []struct {
		name      string
		netPayout money.Fils
		weights   []int64
		want      []money.Fils
	}{
		{"three equal thirds", 10_000, []int64{3334, 3333, 3333}, []money.Fils{3334, 3333, 3333}},
		// old per-child rounding: 3333+3333+3334 = 10000, 1 fil never paid
		{"uneven 1 fil short before", 10_001, []int64{3333, 3333, 3334}, []money.Fils{3333, 3333, 3335}},
		// old per-child rounding: 4+2+2 = 8, paid out 1 fil MORE than net
		{"tiny batch", 7, []int64{5000, 2500, 2500}, []money.Fils{3, 2, 2}},
		{"large odd net", 123_456_789, []int64{1, 9_999}, []money.Fils{12_346, 123_444_443}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			children := make([]ChildWeight, len(tc.weights))
			for i, w := range tc.weights {
				children[i] = ChildWeight{WeightBps: w}
			}
			got := ChildShares(tc.netPayout, children)
			var sum money.Fils
			for i, s := range got {
				sum += s
				if s != tc.want[i] {
					t.Errorf("share[%d] = %d, want %d", i, s, tc.want[i])
				}
			}
			if sum != tc.netPayout {
				t.Fatalf("shares sum to %d, want exactly %d", sum, tc.netPayout)
			}
		})
	}

	// Exhaustive property check: no net amount loses or invents a fil.
	children := []ChildWeight{{3333}, {3333}, {3334}}
	for net := money.Fils(0); net <= 20_000; net++ {
		var sum money.Fils
		for _, s := range ChildShares(net, children) {
			sum += s
		}
		if sum != net {
			t.Fatalf("net %d: shares sum to %d", net, sum)
		}
	}
}
