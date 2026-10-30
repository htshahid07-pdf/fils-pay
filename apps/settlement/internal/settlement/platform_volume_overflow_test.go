package settlement

import (
	"context"
	"testing"
)

// TestRecordPlatformProcessedVolume_PastInt32 is the regression test for the
// platform volume counter overflowing just past the volume-tier threshold:
// with INTEGER/int32 this either errored ("integer out of range") or wrapped
// negative, and every CloseBatch after that point failed.
func TestRecordPlatformProcessedVolume_PastInt32(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	resetPlatformStats(t, pool)

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	const start int64 = 2_100_000_000 // above the tier threshold, near int32 max
	if err := RecordPlatformProcessedVolume(ctx, tx, start, 0); err != nil {
		t.Fatalf("seed counter: %v", err)
	}
	current, err := ReadAndLockPlatformProcessedFils(ctx, tx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if err := RecordPlatformProcessedVolume(ctx, tx, current, 100_000_000); err != nil {
		t.Fatalf("RecordPlatformProcessedVolume past int32 max: %v", err)
	}
	got, err := ReadAndLockPlatformProcessedFils(ctx, tx)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if got != 2_200_000_000 {
		t.Fatalf("total = %d, want 2200000000", got)
	}
	if VolumeTierMdrBonusBps(got) != 15 {
		t.Fatalf("tier bonus must still apply above int32 max")
	}
}
