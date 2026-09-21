package telemetry

import "time"

// TelemetryEvent is one allowlisted observation parsed from a local source.
// It intentionally contains only structured event data, never a raw log line.
type TelemetryEvent struct {
	Type      string            `json:"type"`
	Source    string            `json:"source"`
	Timestamp time.Time         `json:"timestamp"`
	Data      map[string]string `json:"data"`
}
