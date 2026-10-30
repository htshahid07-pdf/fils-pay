package settlement

import (
	"testing"
	"time"
)

// TestBusinessDateAt_UsesBahrainCalendar is the regression test for "the
// daily close is running at 3am local, not midnight". The daemon passed a
// UTC instant to BusinessDayWindow, which takes the argument's own calendar
// date, so between 00:00 and 03:00 Bahrain it still saw yesterday.
func TestBusinessDateAt_UsesBahrainCalendar(t *testing.T) {
	cases := []struct {
		instantUTC time.Time
		want       string
	}{
		// 00:15 Bahrain on 2026-09-10 is 21:15 UTC on 2026-09-09.
		{time.Date(2026, 9, 9, 21, 15, 0, 0, time.UTC), "2026-09-10"},
		// 23:59 Bahrain is 20:59 UTC, same date.
		{time.Date(2026, 9, 10, 20, 59, 0, 0, time.UTC), "2026-09-10"},
		// 02:59 Bahrain (23:59 UTC the previous day): still the new day.
		{time.Date(2026, 12, 31, 23, 59, 0, 0, time.UTC), "2027-01-01"},
	}
	for _, tc := range cases {
		if got := BusinessDateAt(tc.instantUTC).Format("2006-01-02"); got != tc.want {
			t.Errorf("BusinessDateAt(%s) = %s, want %s", tc.instantUTC, got, tc.want)
		}
	}

	// At 00:15 Bahrain, "today" must already be the new business day, so the
	// completed day (yesterday) is closable after the grace period.
	now := time.Date(2026, 9, 9, 21, 15, 0, 0, time.UTC)
	todayStart, _ := BusinessDayWindow(BusinessDateAt(now))
	if want := time.Date(2026, 9, 9, 21, 0, 0, 0, time.UTC); !todayStart.Equal(want) {
		t.Fatalf("today's Bahrain midnight = %s, want %s", todayStart.UTC(), want)
	}
}
