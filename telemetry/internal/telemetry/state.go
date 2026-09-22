package telemetry

import "time"

// TelemetryState is the current local state derived from allowlisted telemetry
// events. It contains no hidden reducer state and is safe to use as a zero value.
type TelemetryState struct {
	SessionActive bool           `json:"sessionActive"`
	PlayerHandle  string         `json:"playerHandle"`
	Shard         string         `json:"shard"`
	Location      *LocationState `json:"location"`
	Jurisdiction  string         `json:"jurisdiction"`
	Ship          *ShipState     `json:"ship"`
	Quantum       *QuantumState  `json:"quantum"`
	Party         []string       `json:"party"`
	LastEventAt   time.Time      `json:"lastEventAt"`
}

// LocationState records the last observed raw location and its source timestamp.
type LocationState struct {
	Raw        string    `json:"raw"`
	ObservedAt time.Time `json:"observedAt"`
	Source     string    `json:"source"`
}

// ShipState records the current observed ship channel.
type ShipState struct {
	Name  string `json:"name"`
	Owner string `json:"owner"`
}

// QuantumState records the current observed quantum destination and state.
type QuantumState struct {
	Destination string `json:"destination"`
	State       string `json:"state"`
}
