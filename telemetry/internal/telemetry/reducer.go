package telemetry

import "sort"

const (
	QuantumStateTargetSelected = "target_selected"
	QuantumStateFuelRequested  = "fuel_requested"
	QuantumStateArrived        = "arrived"
)

// Reduce applies one supported telemetry event to state. It is stateless: all
// retained information belongs to TelemetryState. A nil state is a safe no-op.
func Reduce(state *TelemetryState, event TelemetryEvent) {
	if state == nil || !isSupportedEvent(event.Type) {
		return
	}

	switch event.Type {
	case "player_login":
		if handle := event.Data["handle"]; handle != "" {
			state.PlayerHandle = handle
		}
	case "server_joined":
		if shard := event.Data["shard"]; shard != "" {
			state.Shard = shard
		}
	case "player_spawned":
		state.SessionActive = true
	case "location_change":
		if location := event.Data["location"]; location != "" {
			state.Location = &LocationState{
				Raw:        location,
				ObservedAt: event.Timestamp,
				Source:     event.Source,
			}
		}
	case "jurisdiction_entered":
		if jurisdiction := event.Data["jurisdiction"]; jurisdiction != "" {
			state.Jurisdiction = jurisdiction
		}
	case "ship_boarded":
		if ship := event.Data["ship"]; ship != "" {
			state.Ship = &ShipState{Name: ship, Owner: event.Data["owner"]}
		}
	case "ship_exited":
		reduceShipExited(state, event)
	case "qt_target_selected":
		if destination := event.Data["destination"]; destination != "" {
			state.Quantum = &QuantumState{Destination: destination, State: QuantumStateTargetSelected}
		}
	case "qt_fuel_requested":
		if destination := event.Data["destination"]; destination != "" {
			state.Quantum = &QuantumState{Destination: destination, State: QuantumStateFuelRequested}
		}
	case "qt_arrived":
		if state.Quantum == nil {
			state.Quantum = &QuantumState{State: QuantumStateArrived}
		} else {
			state.Quantum.State = QuantumStateArrived
		}
	case "party_member_joined":
		if player := event.Data["player"]; player != "" {
			addPartyMember(state, player)
		}
	case "party_member_left":
		if player := event.Data["player"]; player != "" {
			removePartyMember(state, player)
		}
	case "party_disbanded":
		state.Party = []string{}
	}

	if !event.Timestamp.IsZero() {
		state.LastEventAt = event.Timestamp
	}
}

func isSupportedEvent(eventType string) bool {
	switch eventType {
	case "player_login", "server_joined", "player_spawned", "location_change", "jurisdiction_entered",
		"ship_boarded", "ship_exited", "qt_target_selected", "qt_fuel_requested", "qt_arrived",
		"party_member_joined", "party_member_left", "party_disbanded":
		return true
	default:
		return false
	}
}

func reduceShipExited(state *TelemetryState, event TelemetryEvent) {
	ship := event.Data["ship"]
	if state.Ship == nil || ship == "" || state.Ship.Name != ship {
		return
	}

	owner := event.Data["owner"]
	if state.Ship.Owner != "" && owner != "" && state.Ship.Owner != owner {
		return
	}

	state.Ship = nil
}

func addPartyMember(state *TelemetryState, player string) {
	for _, member := range state.Party {
		if member == player {
			return
		}
	}
	state.Party = append(state.Party, player)
	sort.Strings(state.Party)
}

func removePartyMember(state *TelemetryState, player string) {
	for index, member := range state.Party {
		if member == player {
			state.Party = append(state.Party[:index], state.Party[index+1:]...)
			return
		}
	}
}
