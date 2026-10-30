package splits

import (
	"sort"

	"github.com/filspay/settlement/internal/money"
)

// ChildWeight is one sub-merchant's configured share of a parent's payout.
type ChildWeight struct {
	WeightBps int64
}

// ChildShares distributes netPayout across children by their weights so
// that the shares always sum to exactly netPayout (largest-remainder
// method). Rounding each share on its own (the previous ApplyRateFils per
// child) does not: three equal thirds of 10000 fils came out 3333 each, and
// the 1 fil left over was never paid to anyone.
//
// Each child first gets floor(net * weight / totalWeight); the fils still
// unallocated (always fewer than len(children)) go one each to the children
// with the largest dropped fractions, ties broken by position, so the result
// is deterministic for a given input order.
func ChildShares(netPayout money.Fils, children []ChildWeight) []money.Fils {
	out := make([]money.Fils, len(children))
	var totalWeight int64
	for _, c := range children {
		totalWeight += c.WeightBps
	}
	if len(children) == 0 || totalWeight <= 0 || netPayout <= 0 {
		return out
	}

	remainders := make([]int64, len(children))
	var allocated money.Fils
	for i, c := range children {
		product := int64(netPayout) * c.WeightBps
		out[i] = money.Fils(product / totalWeight)
		remainders[i] = product % totalWeight
		allocated += out[i]
	}

	order := make([]int, len(children))
	for i := range order {
		order[i] = i
	}
	sort.SliceStable(order, func(a, b int) bool { return remainders[order[a]] > remainders[order[b]] })
	for k := 0; allocated < netPayout; k++ {
		out[order[k%len(order)]]++
		allocated++
	}
	return out
}

// TotalWeightBps sums the configured weights; a parent's children must sum
// to exactly 10000 (100%) for a split payout to be valid.
func TotalWeightBps(children []ChildWeight) int64 {
	var total int64
	for _, c := range children {
		total += c.WeightBps
	}
	return total
}
