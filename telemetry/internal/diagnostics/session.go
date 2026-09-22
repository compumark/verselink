package diagnostics

import (
	"fmt"
	"strings"
	"time"

	"github.com/compumark/verselink-telemetry/internal/gamelog"
	"github.com/compumark/verselink-telemetry/internal/telemetry"
)

// FormatSession returns a deterministic local diagnostics summary. It includes
// only aggregate counters and current structured state, never raw log lines,
// GEIDs, or event data maps.
func FormatSession(snapshot gamelog.SessionDiagnostics) string {
	state := snapshot.State
	return strings.Join([]string{
		fmt.Sprintf("Log path: %s", valueOrDash(snapshot.LogPath)),
		fmt.Sprintf("Lines processed: %d", snapshot.LinesProcessed),
		fmt.Sprintf("Parser events: %d", snapshot.ParserEventCount),
		fmt.Sprintf("Source resets: %d", snapshot.SourceResetCount),
		fmt.Sprintf("Session active: %t", state.SessionActive),
		fmt.Sprintf("Player handle: %s", valueOrDash(state.PlayerHandle)),
		fmt.Sprintf("Shard: %s", valueOrDash(state.Shard)),
		fmt.Sprintf("Last location: %s", locationValue(state.Location)),
		fmt.Sprintf("Location observed: %s", locationTimestamp(state.Location)),
		fmt.Sprintf("Jurisdiction: %s", valueOrDash(state.Jurisdiction)),
		fmt.Sprintf("Current ship: %s", shipValue(state.Ship)),
		fmt.Sprintf("QT destination: %s", quantumDestination(state.Quantum)),
		fmt.Sprintf("QT state: %s", quantumState(state.Quantum)),
		fmt.Sprintf("Party members: %d", len(state.Party)),
		fmt.Sprintf("Last event: %s", timestamp(state.LastEventAt)),
	}, "\n")
}

func valueOrDash(value string) string {
	if value == "" {
		return "-"
	}
	return value
}

func timestamp(value time.Time) string {
	if value.IsZero() {
		return "-"
	}
	return value.Format(time.RFC3339Nano)
}

func locationValue(location *telemetry.LocationState) string {
	if location == nil {
		return "-"
	}
	return valueOrDash(location.Raw)
}

func locationTimestamp(location *telemetry.LocationState) string {
	if location == nil {
		return "-"
	}
	return timestamp(location.ObservedAt)
}

func shipValue(ship *telemetry.ShipState) string {
	if ship == nil || ship.Name == "" {
		return "-"
	}
	if ship.Owner == "" {
		return ship.Name
	}
	return fmt.Sprintf("%s (owner: %s)", ship.Name, ship.Owner)
}

func quantumDestination(quantum *telemetry.QuantumState) string {
	if quantum == nil {
		return "-"
	}
	return valueOrDash(quantum.Destination)
}

func quantumState(quantum *telemetry.QuantumState) string {
	if quantum == nil {
		return "-"
	}
	return valueOrDash(quantum.State)
}
