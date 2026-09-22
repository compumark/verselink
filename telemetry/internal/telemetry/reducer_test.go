package telemetry

import (
	"reflect"
	"testing"
	"time"
)

func TestReduceSessionSequence(t *testing.T) {
	var state TelemetryState
	Reduce(&state, event("player_login", "", time.Time{}, map[string]string{"handle": "TestPilot", "geid": "ignored"}))
	Reduce(&state, event("server_joined", "", time.Time{}, map[string]string{"shard": "pub_test_shard_001"}))
	Reduce(&state, event("player_spawned", "", time.Time{}, nil))

	if !state.SessionActive || state.PlayerHandle != "TestPilot" || state.Shard != "pub_test_shard_001" {
		t.Fatalf("state = %#v", state)
	}
}

func TestReduceSessionEventsDoNotResetOtherDomains(t *testing.T) {
	observedAt := at(9, 0)
	state := TelemetryState{
		Location:     &LocationState{Raw: "Location", ObservedAt: observedAt, Source: "game_log"},
		Jurisdiction: "Stanton",
		Ship:         &ShipState{Name: "Ship", Owner: "Owner"},
		Quantum:      &QuantumState{Destination: "ARC-L1", State: QuantumStateArrived},
		Party:        []string{"Alpha"},
	}
	Reduce(&state, event("player_login", "", at(10, 0), map[string]string{"handle": "Pilot"}))
	Reduce(&state, event("server_joined", "", at(10, 1), map[string]string{"shard": "Shard"}))
	Reduce(&state, event("player_spawned", "", at(10, 2), nil))

	if state.Location == nil || state.Location.Raw != "Location" || state.Jurisdiction != "Stanton" || state.Ship == nil || state.Ship.Name != "Ship" || state.Quantum == nil || state.Quantum.Destination != "ARC-L1" || !reflect.DeepEqual(state.Party, []string{"Alpha"}) {
		t.Fatalf("session events reset unrelated state: %#v", state)
	}
}

func TestReduceLocationObservationTimeIsIndependent(t *testing.T) {
	locationAt := at(10, 0)
	shipAt := at(10, 1)
	quantumAt := at(10, 2)
	partyAt := at(10, 3)
	state := TelemetryState{PlayerHandle: "ExistingPilot"}
	Reduce(&state, event("location_change", "game_log", locationAt, map[string]string{"player": "OtherPilot", "location": "RR_CRU_L1"}))
	Reduce(&state, event("ship_boarded", "game_log", shipAt, map[string]string{"ship": "RSI_Hermes", "owner": "TestOwner"}))
	Reduce(&state, event("qt_target_selected", "game_log", quantumAt, map[string]string{"destination": "ARC-L1"}))
	Reduce(&state, event("party_member_joined", "game_log", partyAt, map[string]string{"player": "CrewMate"}))

	if state.Location == nil || state.Location.Raw != "RR_CRU_L1" || !state.Location.ObservedAt.Equal(locationAt) || state.Location.Source != "game_log" {
		t.Fatalf("location = %#v", state.Location)
	}
	if state.PlayerHandle != "ExistingPilot" {
		t.Fatalf("location player changed PlayerHandle = %q", state.PlayerHandle)
	}
	if !state.LastEventAt.Equal(partyAt) {
		t.Fatalf("LastEventAt = %s, want %s", state.LastEventAt, partyAt)
	}
}

func TestReduceLocationWithZeroTimestampReplacesObservationButNotLastEvent(t *testing.T) {
	previous := at(10, 0)
	state := TelemetryState{LastEventAt: previous}
	Reduce(&state, event("location_change", "fixture", previous, map[string]string{"location": "A"}))
	Reduce(&state, event("location_change", "fixture", time.Time{}, map[string]string{"location": "B"}))

	if state.Location == nil || state.Location.Raw != "B" || !state.Location.ObservedAt.IsZero() || state.Location.Source != "fixture" {
		t.Fatalf("location = %#v", state.Location)
	}
	if !state.LastEventAt.Equal(previous) {
		t.Fatalf("LastEventAt = %s, want %s", state.LastEventAt, previous)
	}
}

func TestReduceShipExitOnlyClearsMatchingCurrentShip(t *testing.T) {
	var state TelemetryState
	Reduce(&state, event("ship_exited", "", at(9, 59), map[string]string{"ship": "ShipA", "owner": "OwnerA"}))
	if state.Ship != nil {
		t.Fatalf("exit without current ship created state: %#v", state.Ship)
	}
	Reduce(&state, event("ship_boarded", "", at(10, 0), map[string]string{"ship": "ShipA", "owner": "OwnerA"}))
	Reduce(&state, event("ship_boarded", "", at(10, 1), map[string]string{"ship": "ShipB", "owner": "OwnerB"}))
	Reduce(&state, event("ship_exited", "", at(10, 2), map[string]string{"ship": "ShipA", "owner": "OwnerA"}))
	if state.Ship == nil || state.Ship.Name != "ShipB" {
		t.Fatalf("stale exit changed ship: %#v", state.Ship)
	}
	Reduce(&state, event("ship_exited", "", at(10, 3), map[string]string{"ship": "ShipB", "owner": "OtherOwner"}))
	if state.Ship == nil {
		t.Fatal("owner mismatch cleared current ship")
	}
	Reduce(&state, event("ship_exited", "", at(10, 4), map[string]string{"ship": "ShipB", "owner": "OwnerB"}))
	if state.Ship != nil {
		t.Fatalf("matching exit did not clear ship: %#v", state.Ship)
	}
}

func TestReduceShipExitOwnerAndMissingNameRules(t *testing.T) {
	for _, test := range []struct {
		name         string
		currentOwner string
		exitOwner    string
		wantCleared  bool
	}{
		{name: "matching owners", currentOwner: "Owner", exitOwner: "Owner", wantCleared: true},
		{name: "different non-empty owners", currentOwner: "Owner", exitOwner: "Other", wantCleared: false},
		{name: "empty current owner", currentOwner: "", exitOwner: "Owner", wantCleared: true},
		{name: "empty exit owner", currentOwner: "Owner", exitOwner: "", wantCleared: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			state := TelemetryState{Ship: &ShipState{Name: "Ship", Owner: test.currentOwner}}
			Reduce(&state, event("ship_exited", "", at(10, 0), map[string]string{"ship": "Ship", "owner": test.exitOwner}))
			if (state.Ship == nil) != test.wantCleared {
				t.Fatalf("Ship = %#v, wantCleared = %t", state.Ship, test.wantCleared)
			}
		})
	}

	state := TelemetryState{Ship: &ShipState{Name: "Ship", Owner: "Owner"}}
	Reduce(&state, event("ship_exited", "", at(10, 1), map[string]string{"owner": "Owner"}))
	if state.Ship == nil {
		t.Fatal("missing ship name cleared current ship")
	}
}

func TestReduceQuantumSequences(t *testing.T) {
	var state TelemetryState
	Reduce(&state, event("qt_target_selected", "", at(10, 0), map[string]string{"destination": "ARC-L1"}))
	Reduce(&state, event("qt_fuel_requested", "", at(10, 1), map[string]string{"destination": "HUR-L2"}))
	Reduce(&state, event("qt_arrived", "", at(10, 2), nil))
	if state.Quantum == nil || state.Quantum.Destination != "HUR-L2" || state.Quantum.State != QuantumStateArrived {
		t.Fatalf("quantum = %#v", state.Quantum)
	}
	Reduce(&state, event("qt_target_selected", "", at(10, 3), map[string]string{"destination": "HUR-L2"}))
	if state.Quantum.Destination != "HUR-L2" || state.Quantum.State != QuantumStateTargetSelected {
		t.Fatalf("replacement quantum = %#v", state.Quantum)
	}

	var unknownArrival TelemetryState
	Reduce(&unknownArrival, event("qt_arrived", "", at(11, 0), nil))
	if unknownArrival.Quantum == nil || unknownArrival.Quantum.Destination != "" || unknownArrival.Quantum.State != QuantumStateArrived {
		t.Fatalf("unknown arrival = %#v", unknownArrival.Quantum)
	}
}

func TestReduceEmptyQuantumDestinationPreservesState(t *testing.T) {
	state := TelemetryState{Quantum: &QuantumState{Destination: "ARC-L1", State: QuantumStateTargetSelected}}
	for _, eventType := range []string{"qt_target_selected", "qt_fuel_requested"} {
		Reduce(&state, event(eventType, "", at(10, 0), nil))
		if state.Quantum == nil || state.Quantum.Destination != "ARC-L1" || state.Quantum.State != QuantumStateTargetSelected {
			t.Fatalf("%s corrupted Quantum: %#v", eventType, state.Quantum)
		}
	}
}

func TestReducePartySetSemantics(t *testing.T) {
	var state TelemetryState
	for _, player := range []string{"Bravo", "Alpha", "Bravo"} {
		Reduce(&state, event("party_member_joined", "", at(10, 0), map[string]string{"player": player}))
	}
	Reduce(&state, event("party_member_left", "", at(10, 1), map[string]string{"player": "Nobody"}))
	if want := []string{"Alpha", "Bravo"}; !reflect.DeepEqual(state.Party, want) {
		t.Fatalf("Party = %#v, want %#v", state.Party, want)
	}
	Reduce(&state, event("party_member_left", "", at(10, 2), map[string]string{"player": "Alpha"}))
	if want := []string{"Bravo"}; !reflect.DeepEqual(state.Party, want) {
		t.Fatalf("Party = %#v, want %#v", state.Party, want)
	}
	Reduce(&state, event("party_member_joined", "", at(10, 2), nil))
	Reduce(&state, event("party_member_left", "", at(10, 2), nil))
	if want := []string{"Bravo"}; !reflect.DeepEqual(state.Party, want) {
		t.Fatalf("empty player changed Party = %#v, want %#v", state.Party, want)
	}
	Reduce(&state, event("party_disbanded", "", at(10, 3), nil))
	if state.Party == nil || len(state.Party) != 0 {
		t.Fatalf("Party = %#v, want non-nil empty", state.Party)
	}
}

func TestReducePartyDisbandOnlyClearsParty(t *testing.T) {
	observedAt := at(9, 0)
	state := TelemetryState{
		SessionActive: true,
		PlayerHandle:  "Pilot",
		Shard:         "Shard",
		Location:      &LocationState{Raw: "Location", ObservedAt: observedAt, Source: "game_log"},
		Jurisdiction:  "Stanton",
		Ship:          &ShipState{Name: "Ship", Owner: "Owner"},
		Quantum:       &QuantumState{Destination: "ARC-L1", State: QuantumStateArrived},
		Party:         []string{"Alpha", "Bravo"},
	}
	Reduce(&state, event("party_disbanded", "game_log", at(10, 0), nil))
	if !state.SessionActive || state.PlayerHandle != "Pilot" || state.Shard != "Shard" || state.Location == nil || state.Location.Raw != "Location" || state.Jurisdiction != "Stanton" || state.Ship == nil || state.Ship.Name != "Ship" || state.Quantum == nil || state.Quantum.Destination != "ARC-L1" {
		t.Fatalf("disband changed unrelated state: %#v", state)
	}
	if state.Party == nil || len(state.Party) != 0 {
		t.Fatalf("Party = %#v, want non-nil empty", state.Party)
	}
}

func TestReduceCombinedMultiDomainSequence(t *testing.T) {
	var state TelemetryState
	events := []TelemetryEvent{
		event("player_login", "game_log", at(10, 0), map[string]string{"handle": "TestPilot"}),
		event("server_joined", "game_log", at(10, 1), map[string]string{"shard": "pub_test"}),
		event("player_spawned", "game_log", at(10, 2), nil),
		event("location_change", "game_log", at(10, 3), map[string]string{"location": "RR_CRU_L1"}),
		event("jurisdiction_entered", "game_log", at(10, 4), map[string]string{"jurisdiction": "Stanton"}),
		event("ship_boarded", "game_log", at(10, 5), map[string]string{"ship": "RSI_Hermes", "owner": "TestPilot"}),
		event("qt_target_selected", "game_log", at(10, 6), map[string]string{"destination": "ARC-L1"}),
		event("qt_fuel_requested", "game_log", at(10, 7), map[string]string{"destination": "ARC-L1"}),
		event("party_member_joined", "game_log", at(10, 8), map[string]string{"player": "Bravo"}),
		event("party_member_joined", "game_log", at(10, 9), map[string]string{"player": "Alpha"}),
		event("qt_arrived", "game_log", at(10, 10), nil),
		event("party_member_left", "game_log", at(10, 11), map[string]string{"player": "Alpha"}),
		event("ship_exited", "game_log", at(10, 12), map[string]string{"ship": "RSI_Hermes", "owner": "TestPilot"}),
	}
	for _, event := range events {
		Reduce(&state, event)
	}

	if !state.SessionActive || state.PlayerHandle != "TestPilot" || state.Shard != "pub_test" || state.Jurisdiction != "Stanton" || state.Ship != nil {
		t.Fatalf("state = %#v", state)
	}
	if state.Location == nil || state.Location.Raw != "RR_CRU_L1" || !state.Location.ObservedAt.Equal(at(10, 3)) {
		t.Fatalf("location = %#v", state.Location)
	}
	if state.Quantum == nil || state.Quantum.Destination != "ARC-L1" || state.Quantum.State != QuantumStateArrived {
		t.Fatalf("quantum = %#v", state.Quantum)
	}
	if want := []string{"Bravo"}; !reflect.DeepEqual(state.Party, want) {
		t.Fatalf("Party = %#v, want %#v", state.Party, want)
	}
	if !state.LastEventAt.Equal(at(10, 12)) {
		t.Fatalf("LastEventAt = %s", state.LastEventAt)
	}
}

func TestReduceNoOpsAndLastEventProcessingOrder(t *testing.T) {
	first := at(10, 5)
	second := at(10, 4)
	state := TelemetryState{PlayerHandle: "Existing"}
	Reduce(nil, event("player_spawned", "", first, nil))
	Reduce(&state, event("player_spawned", "", first, nil))
	Reduce(&state, event("server_joined", "", second, map[string]string{"shard": "Shard"}))
	if !state.LastEventAt.Equal(second) {
		t.Fatalf("LastEventAt = %s, want processing-order timestamp %s", state.LastEventAt, second)
	}
	for _, eventType := range []string{"blueprint_received", "refinery_complete"} {
		before := state
		Reduce(&state, event(eventType, "", at(11, 0), map[string]string{"name": "Ignored"}))
		if !reflect.DeepEqual(state, before) {
			t.Fatalf("unsupported %s event changed state: %#v", eventType, state)
		}
	}
	Reduce(&state, event("player_login", "", time.Time{}, nil))
	if state.PlayerHandle != "Existing" || !state.LastEventAt.Equal(second) {
		t.Fatalf("missing data corrupted state: %#v", state)
	}
}

func TestReduceCopiesScalarValuesFromEventData(t *testing.T) {
	data := map[string]string{
		"handle":      "Pilot",
		"location":    "RR_CRU_L1",
		"ship":        "Ship",
		"owner":       "Owner",
		"destination": "ARC-L1",
		"player":      "CrewMate",
	}
	var state TelemetryState
	Reduce(&state, event("player_login", "", at(10, 0), data))
	Reduce(&state, event("location_change", "game_log", at(10, 1), data))
	Reduce(&state, event("ship_boarded", "", at(10, 2), data))
	Reduce(&state, event("qt_target_selected", "", at(10, 3), data))
	Reduce(&state, event("party_member_joined", "", at(10, 4), data))

	for key := range data {
		data[key] = "changed"
	}
	if state.PlayerHandle != "Pilot" || state.Location == nil || state.Location.Raw != "RR_CRU_L1" || state.Ship == nil || state.Ship.Name != "Ship" || state.Ship.Owner != "Owner" || state.Quantum == nil || state.Quantum.Destination != "ARC-L1" || !reflect.DeepEqual(state.Party, []string{"CrewMate"}) {
		t.Fatalf("state retained event data map: %#v", state)
	}
}

func TestReduceMissingRequiredDataPreservesDomains(t *testing.T) {
	locationAt := at(9, 0)
	state := TelemetryState{
		PlayerHandle: "Pilot",
		Shard:        "Shard",
		Location:      &LocationState{Raw: "Location", ObservedAt: locationAt, Source: "game_log"},
		Jurisdiction:  "Stanton",
		Ship:          &ShipState{Name: "Ship", Owner: "Owner"},
		Quantum:       &QuantumState{Destination: "ARC-L1", State: QuantumStateTargetSelected},
		Party:         []string{"Alpha"},
		LastEventAt:   locationAt,
	}
	for index, eventType := range []string{
		"player_login", "server_joined", "location_change", "jurisdiction_entered", "ship_boarded",
		"ship_exited", "qt_target_selected", "qt_fuel_requested", "party_member_joined", "party_member_left",
	} {
		timestamp := at(11, index)
		Reduce(&state, event(eventType, "other_source", timestamp, nil))
		if state.PlayerHandle != "Pilot" || state.Shard != "Shard" || state.Location == nil || state.Location.Raw != "Location" || state.Jurisdiction != "Stanton" || state.Ship == nil || state.Ship.Name != "Ship" || state.Quantum == nil || state.Quantum.Destination != "ARC-L1" || !reflect.DeepEqual(state.Party, []string{"Alpha"}) {
			t.Fatalf("%s corrupted state: %#v", eventType, state)
		}
		if !state.LastEventAt.Equal(timestamp) {
			t.Fatalf("%s LastEventAt = %s, want %s", eventType, state.LastEventAt, timestamp)
		}
	}
}

func event(eventType, source string, timestamp time.Time, data map[string]string) TelemetryEvent {
	return TelemetryEvent{Type: eventType, Source: source, Timestamp: timestamp, Data: data}
}

func at(hour, minute int) time.Time {
	return time.Date(2026, time.September, 22, hour, minute, 0, 0, time.UTC)
}
