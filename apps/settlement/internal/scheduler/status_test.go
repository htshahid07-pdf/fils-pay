package scheduler

import (
	"testing"
	"time"
)

func TestEstimateNextRunAt(t *testing.T) {
	t.Setenv("TZ", "UTC")

	// 21:15Z = 00:15 Bahrain on 15 May, exactly when the close runs, so
	// the next one is 00:15 Bahrain on 16 May = 21:15Z on 15 May.
	lastCheckedAt := time.Date(2026, 5, 14, 21, 15, 0, 0, time.UTC)
	got := estimateNextRunAt(lastCheckedAt, 15)
	want := time.Date(2026, 5, 15, 21, 15, 0, 0, time.UTC)

	if !got.Equal(want) {
		t.Fatalf("estimateNextRunAt(%s) = %s, want %s", lastCheckedAt.Format(time.RFC3339), got.Format(time.RFC3339), want.Format(time.RFC3339))
	}
}

func TestSchedulingLocationUsesTZ(t *testing.T) {
	t.Setenv("TZ", "UTC")

	if got := schedulingLocation().String(); got != "UTC" {
		t.Fatalf("schedulingLocation() = %q, want %q", got, "UTC")
	}
}

// A daemon started mid-afternoon must announce tonight's 00:15 Bahrain
// close, not "same time tomorrow" (the old last-check + 24 h estimate).
func TestEstimateNextRunAt_MidDayPointsAtNextBahrainMidnightPlusDelay(t *testing.T) {
	t.Setenv("TZ", "UTC")

	lastCheckedAt := time.Date(2026, 10, 30, 12, 23, 0, 0, time.UTC) // 15:23 Bahrain
	got := estimateNextRunAt(lastCheckedAt, 15)
	want := time.Date(2026, 10, 30, 21, 15, 0, 0, time.UTC) // 00:15 Bahrain, 31 Oct

	if !got.Equal(want) {
		t.Fatalf("estimateNextRunAt(%s) = %s, want %s", lastCheckedAt.Format(time.RFC3339), got.Format(time.RFC3339), want.Format(time.RFC3339))
	}
}
