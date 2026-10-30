// Package scheduler — status.go. Lightweight operational logging only:
// estimates, for an operator tailing the daemon's logs, roughly when the
// next check-in will happen. This is informational — it has no bearing
// on runIfDue's actual decision (settlement.BusinessDayWindow, in
// internal/settlement/window.go, remains the sole authority on whether a
// business day has completed) — added purely so the daemon's own log
// output says something more useful than "checked, nothing due yet" on
// every tick.
package scheduler

import (
	"log"
	"os"
	"time"

	"github.com/filspay/settlement/internal/settlement"
)

// schedulingLocation is the zone this log estimate renders in. Reads the
// process's TZ setting (the same convention every other timestamp this
// service logs already follows via Go's default time formatting), falling
// back to the container's local zone when TZ is unset — kept independent
// of internal/settlement's own businessDayLocation, which is a private
// var of that package and not reachable from here.
// FH: reads TZ, container has TZ unset, so these log lines say UTC. confusing but log-only
// MK: DO NOT use this for anything but logs.
func schedulingLocation() *time.Location {
	if tz := os.Getenv("TZ"); tz != "" {
		if loc, err := time.LoadLocation(tz); err == nil {
			return loc
		}
	}
	return time.Local
}

// estimateNextRunAt gives the log-only time of the daemon's next daily
// close: the next Asia/Bahrain midnight plus the run delay that runIfDue
// itself waits for, rendered in schedulingLocation(). It is never consulted
// by runIfDue. It used to print "last check + 24 h", so a daemon started at
// 15:23 announced its next run for 15:23 tomorrow although the close really
// runs at 00:15 Bahrain.
func estimateNextRunAt(lastCheckedAt time.Time, runDelayMinutes int) time.Time {
	todayStart, _ := settlement.BusinessDayWindow(settlement.BusinessDateAt(lastCheckedAt))
	next := todayStart.Add(time.Duration(runDelayMinutes) * time.Minute)
	if !next.After(lastCheckedAt) {
		next = next.AddDate(0, 0, 1)
	}
	return next.In(schedulingLocation())
}

// logNextRunEstimate writes the estimate to the daemon's log, alongside
// the outcome of the check that just ran.
func logNextRunEstimate(lastCheckedAt time.Time, runDelayMinutes int) {
	log.Printf("settlement daemon: next daily close ~%s", estimateNextRunAt(lastCheckedAt, runDelayMinutes).Format(time.RFC3339))
}
