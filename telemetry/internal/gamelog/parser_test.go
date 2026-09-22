package gamelog

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/compumark/verselink-telemetry/internal/telemetry"
)

func readParserFixture(t *testing.T, path string) string {
	t.Helper()
	content, err := os.ReadFile(filepath.Join(eventsRoot(t), filepath.FromSlash(path)))
	if err != nil {
		t.Fatal(err)
	}
	return string(content)
}

func readParserFixtureLines(t *testing.T, path string) []string {
	t.Helper()
	return strings.Split(strings.TrimRight(readParserFixture(t, path), "\r\n"), "\n")
}

func assertNoParserEvent(t *testing.T, event telemetry.TelemetryEvent, ok bool) {
	t.Helper()
	if ok || !reflect.DeepEqual(event, telemetry.TelemetryEvent{}) {
		t.Fatalf("unexpected event %#v, ok = %t", event, ok)
	}
}

func TestParserSessionFixtures(t *testing.T) {
	parser := NewParser()
	timestamp := time.Date(2026, time.September, 21, 10, 15, 30, 123000000, time.UTC)
	cases := []struct {
		name string
		path string
		event string
		data map[string]string
		time time.Time
	}{
		{"player login", "session/player_login.valid.log", "player_login", map[string]string{"handle": "TestPilot", "geid": "123456789"}, timestamp},
		{"server joined", "session/server_joined.valid.log", "server_joined", map[string]string{"shard": "pub_test_shard_001"}, timestamp.Add(time.Second)},
		{"player spawned", "session/player_spawned.valid.log", "player_spawned", map[string]string{}, timestamp.Add(2 * time.Second)},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			event, ok := parser.Parse(readParserFixture(t, test.path))
			if !ok {
				t.Fatal("expected event")
			}
			if event.Type != test.event || event.Source != "game_log" || !event.Timestamp.Equal(test.time) || !reflect.DeepEqual(event.Data, test.data) {
				t.Fatalf("event = %#v", event)
			}
			if test.event == "server_joined" && len(event.Data) != 1 {
				t.Fatalf("server_joined data = %#v, want one key", event.Data)
			}
			if test.event == "player_spawned" && (event.Data == nil || len(event.Data) != 0) {
				t.Fatalf("player_spawned data = %#v, want non-nil empty map", event.Data)
			}
			if _, found := event.Data["address"]; found {
				t.Fatal("address must not be exposed")
			}
			if _, found := event.Data["port"]; found {
				t.Fatal("port must not be exposed")
			}
			if _, found := event.Data["locationId"]; found {
				t.Fatal("locationId must not be exposed")
			}
		})
	}
}

func TestParserRejectsSessionNegativeFixtures(t *testing.T) {
	parser := NewParser()
	for _, path := range []string{
		"session/player_login.invalid.log",
		"session/server_joined.invalid.log",
		"session/player_spawned.invalid.log",
	} {
		t.Run(path, func(t *testing.T) {
			event, ok := parser.Parse(readParserFixture(t, path))
			if ok || !reflect.DeepEqual(event, telemetry.TelemetryEvent{}) {
				t.Fatalf("unexpected event %#v", event)
			}
		})
	}
}

func TestParserTimestampHandling(t *testing.T) {
	parser := NewParser()
	valid := `<2026-09-21T10:15:30.123456789Z> [Notice] nickname="TestPilot" playerGEID=123456789`
	missing := `[Notice] nickname="TestPilot" playerGEID=123456789`
	malformed := `<not-a-date> [Notice] nickname="TestPilot" playerGEID=123456789`

	for _, test := range []struct {
		name string
		line string
		zero bool
	}{
		{"rfc3339 nano", valid, false},
		{"missing", missing, true},
		{"malformed", malformed, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			event, ok := parser.Parse(test.line)
			if !ok || event.Type != "player_login" {
				t.Fatalf("event = %#v, ok = %t", event, ok)
			}
			if event.Timestamp.IsZero() != test.zero {
				t.Fatalf("timestamp = %s, zero = %t", event.Timestamp, event.Timestamp.IsZero())
			}
		})
	}
}

func TestParserRejectsMalformedAndLaterEvents(t *testing.T) {
	parser := NewParser()
	lines := []string{
		"totally unrelated line",
		`[Notice] nickname="" playerGEID=123456789`,
		`[Notice] nickname="TestPilot"`,
		"[Notice] playerGEID=123456789",
		`[Notice] nickname="TestPilot" playerGEID=not-a-number`,
		"[Notice] <Join PU> address[127.0.0.1] port[8000]",
		"[Notice] <Join PU> shard[] connection established",
		"[Notice] {Join PU} id[example] status[Queued] port[64090]",
		"[Notice] [CSessionManager::OnClientSpawned] preparing",
		readParserFixture(t, "reference/blueprint_received.valid.log"),
	}
	for _, line := range lines {
		event, ok := parser.Parse(line)
		if ok || !reflect.DeepEqual(event, telemetry.TelemetryEvent{}) {
			t.Fatalf("unexpected event for %q: %#v", line, event)
		}
	}
}

func TestParserPartyFixtures(t *testing.T) {
	cases := []struct {
		name      string
		path      string
		eventType string
		timestamp time.Time
	}{
		{"member joined", "party/party_member_joined.valid.log", "party_member_joined", time.Date(2026, time.September, 21, 10, 20, 0, 456000000, time.UTC)},
		{"member left", "party/party_member_left.valid.log", "party_member_left", time.Date(2026, time.September, 21, 10, 21, 0, 456000000, time.UTC)},
	}

	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			parser := NewParser()
			lines := readParserFixtureLines(t, test.path)
			if len(lines) != 2 {
				t.Fatalf("fixture lines = %d, want 2", len(lines))
			}
			header, headerOK := parser.Parse(lines[0])
			assertNoParserEvent(t, header, headerOK)
			event, ok := parser.Parse(lines[1])
			if !ok || event.Type != test.eventType || event.Source != "game_log" || !event.Timestamp.Equal(test.timestamp) || !reflect.DeepEqual(event.Data, map[string]string{"player": "CrewMate"}) {
				t.Fatalf("event = %#v, ok = %t", event, ok)
			}
			event, ok = parser.Parse(lines[1])
			assertNoParserEvent(t, event, ok)
		})
	}

	parser := NewParser()
	event, ok := parser.Parse(readParserFixture(t, "party/party_disbanded.valid.log"))
	if !ok || event.Type != "party_disbanded" || event.Source != "game_log" || !event.Timestamp.Equal(time.Date(2026, time.September, 21, 10, 22, 0, 123000000, time.UTC)) || event.Data == nil || len(event.Data) != 0 {
		t.Fatalf("event = %#v, ok = %t", event, ok)
	}

	event, ok = parser.Parse(readParserFixture(t, "party/party_disbanded.invalid.log"))
	assertNoParserEvent(t, event, ok)
}

func TestParserPartyNegativeAndStaleFixtures(t *testing.T) {
	for _, path := range []string{
		"party/party_member_joined.invalid.log",
		"party/party_member_left.invalid.log",
	} {
		t.Run(path, func(t *testing.T) {
			event, ok := NewParser().Parse(readParserFixture(t, path))
			assertNoParserEvent(t, event, ok)
		})
	}

	for _, line := range []string{
		`<2026-09-21T10:20:00.456Z> CrewMate has joined the party.`,
		`<2026-09-21T10:21:00.456Z> CrewMate has left the party.`,
	} {
		event, ok := NewParser().Parse(line)
		assertNoParserEvent(t, event, ok)
	}

	for _, test := range []struct {
		name string
		path string
	}{
		{"joined stale", "party/party_member_joined.stale.log"},
		{"left stale", "party/party_member_left.stale.log"},
	} {
		t.Run(test.name, func(t *testing.T) {
			parser := NewParser()
			lines := readParserFixtureLines(t, test.path)
			if len(lines) != 3 {
				t.Fatalf("fixture lines = %d, want 3", len(lines))
			}
			event, ok := parser.Parse(lines[0])
			assertNoParserEvent(t, event, ok)
			event, ok = parser.Parse(lines[1])
			if !ok || event.Type != "player_spawned" {
				t.Fatalf("stale invalidator event = %#v, ok = %t", event, ok)
			}
			event, ok = parser.Parse(lines[2])
			assertNoParserEvent(t, event, ok)
		})
	}

	for _, test := range []struct {
		name           string
		path           string
		laterOriginal  string
	}{
		{"joined wrong continuation", "party/party_member_joined.wrong-continuation.log", `<2026-09-21T10:20:01.456Z> CrewMate has joined the party.`},
		{"left wrong continuation", "party/party_member_left.wrong-continuation.log", `<2026-09-21T10:21:01.456Z> CrewMate has left the party.`},
	} {
		t.Run(test.name, func(t *testing.T) {
			parser := NewParser()
			lines := readParserFixtureLines(t, test.path)
			event, ok := parser.Parse(lines[0])
			assertNoParserEvent(t, event, ok)
			event, ok = parser.Parse(lines[1])
			assertNoParserEvent(t, event, ok)
			event, ok = parser.Parse(test.laterOriginal)
			assertNoParserEvent(t, event, ok)
		})
	}
}

func TestParserPartyStateTransitions(t *testing.T) {
	joinHeader := `<2026-09-21T10:20:00.123Z> [Notice] <SHUDEvent_OnNotification> Added notification "New Member Joined`
	leaveHeader := `<2026-09-21T10:21:00.123Z> [Notice] <SHUDEvent_OnNotification> Added notification "Member Left`
	joinContinuation := `<2026-09-21T10:20:00.456Z> CrewMate has joined the party.`
	leaveContinuation := `<2026-09-21T10:21:00.456Z> CrewMate has left the party.`

	t.Run("unmatched noise preserves pending", func(t *testing.T) {
		parser := NewParser()
		event, ok := parser.Parse(joinHeader)
		assertNoParserEvent(t, event, ok)
		event, ok = parser.Parse("unmatched noise")
		assertNoParserEvent(t, event, ok)
		event, ok = parser.Parse(joinContinuation)
		if !ok || event.Type != "party_member_joined" {
			t.Fatalf("event = %#v, ok = %t", event, ok)
		}
	})

	t.Run("new header replaces pending operation", func(t *testing.T) {
		for _, test := range []struct {
			first, second, continuation, eventType string
		}{
			{joinHeader, leaveHeader, leaveContinuation, "party_member_left"},
			{leaveHeader, joinHeader, joinContinuation, "party_member_joined"},
		} {
			parser := NewParser()
			event, ok := parser.Parse(test.first)
			assertNoParserEvent(t, event, ok)
			event, ok = parser.Parse(test.second)
			assertNoParserEvent(t, event, ok)
			event, ok = parser.Parse(test.continuation)
			if !ok || event.Type != test.eventType {
				t.Fatalf("event = %#v, ok = %t", event, ok)
			}
		}
	})

	t.Run("repeated headers replace rather than queue", func(t *testing.T) {
		for _, test := range []struct {
			header, continuation, eventType string
		}{
			{joinHeader, joinContinuation, "party_member_joined"},
			{leaveHeader, leaveContinuation, "party_member_left"},
		} {
			parser := NewParser()
			event, ok := parser.Parse(test.header)
			assertNoParserEvent(t, event, ok)
			event, ok = parser.Parse(test.header)
			assertNoParserEvent(t, event, ok)
			event, ok = parser.Parse(test.continuation)
			if !ok || event.Type != test.eventType {
				t.Fatalf("event = %#v, ok = %t", event, ok)
			}
			event, ok = parser.Parse(test.continuation)
			assertNoParserEvent(t, event, ok)
		}
	})

	t.Run("disband clears pending", func(t *testing.T) {
		for _, test := range []struct {
			header, continuation string
		}{
			{joinHeader, joinContinuation},
			{leaveHeader, leaveContinuation},
		} {
			parser := NewParser()
			event, ok := parser.Parse(test.header)
			assertNoParserEvent(t, event, ok)
			event, ok = parser.Parse(`<2026-09-21T10:22:00.123Z> [Notice] <SHUDEvent_OnNotification> Added notification "Party Disbanded`)
			if !ok || event.Type != "party_disbanded" || event.Data == nil || len(event.Data) != 0 {
				t.Fatalf("event = %#v, ok = %t", event, ok)
			}
			event, ok = parser.Parse(test.continuation)
			assertNoParserEvent(t, event, ok)
		}
	})

	t.Run("missing and malformed timestamps", func(t *testing.T) {
		parser := NewParser()
		event, ok := parser.Parse(joinHeader)
		assertNoParserEvent(t, event, ok)
		event, ok = parser.Parse("CrewMate has joined the party.")
		assertNoParserEvent(t, event, ok)
		event, ok = parser.Parse("CrewMate has left the party.")
		assertNoParserEvent(t, event, ok)
		event, ok = parser.Parse(`<not-a-date> CrewMate has joined the party.`)
		if !ok || event.Type != "party_member_joined" || !event.Timestamp.IsZero() {
			t.Fatalf("event = %#v, ok = %t", event, ok)
		}
	})
}

func TestParserPartyJoinChannelAndGroupForms(t *testing.T) {
	for _, test := range []struct {
		continuation string
		player       string
	}{
		{`<2026-09-21T10:20:00.456Z> ChannelMate has joined the channel 'Example'`, "ChannelMate"},
		{`<2026-09-21T10:20:00.456Z> GroupMate has joined the group 'Example'`, "GroupMate"},
	} {
		parser := NewParser()
		event, ok := parser.Parse(`<2026-09-21T10:20:00.123Z> [Notice] <SHUDEvent_OnNotification> Added notification "New Member Joined`)
		assertNoParserEvent(t, event, ok)
		event, ok = parser.Parse(test.continuation)
		if !ok || event.Type != "party_member_joined" || event.Source != "game_log" || !reflect.DeepEqual(event.Data, map[string]string{"player": test.player}) {
			t.Fatalf("event = %#v, ok = %t", event, ok)
		}
	}
}

func TestParserRecognizedEventsClearPartyPending(t *testing.T) {
	for _, path := range []string{
		"session/player_login.valid.log",
		"session/server_joined.valid.log",
		"session/player_spawned.valid.log",
		"location/location_change.valid.log",
		"location/jurisdiction_entered.valid.log",
		"ships/ship_boarded.valid.log",
		"ships/ship_exited.valid.log",
		"quantum/qt_target_selected.valid.log",
		"quantum/qt_fuel_requested.valid.log",
		"quantum/qt_arrived.valid.log",
	} {
		t.Run(path, func(t *testing.T) {
			parser := NewParser()
			event, ok := parser.Parse(`<2026-09-21T10:20:00.123Z> [Notice] <SHUDEvent_OnNotification> Added notification "New Member Joined`)
			assertNoParserEvent(t, event, ok)
			event, ok = parser.Parse(readParserFixture(t, path))
			if !ok {
				t.Fatalf("expected recognized event from %s", path)
			}
			event, ok = parser.Parse(`<2026-09-21T10:20:00.456Z> CrewMate has joined the party.`)
			assertNoParserEvent(t, event, ok)
		})
	}
}

func TestParserQuantumFixtures(t *testing.T) {
	parser := NewParser()
	cases := []struct {
		name      string
		path      string
		eventType string
		timestamp time.Time
		data      map[string]string
	}{
		{"target selected", "quantum/qt_target_selected.valid.log", "qt_target_selected", time.Date(2026, time.September, 21, 10, 19, 0, 123000000, time.UTC), map[string]string{"destination": "ARC-L1"}},
		{"fuel requested", "quantum/qt_fuel_requested.valid.log", "qt_fuel_requested", time.Date(2026, time.September, 21, 10, 19, 1, 123000000, time.UTC), map[string]string{"destination": "ARC-L1"}},
		{"arrived", "quantum/qt_arrived.valid.log", "qt_arrived", time.Date(2026, time.September, 21, 10, 19, 2, 123000000, time.UTC), map[string]string{}},
	}

	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			event, ok := parser.Parse(readParserFixture(t, test.path))
			if !ok || event.Type != test.eventType || event.Source != "game_log" || !event.Timestamp.Equal(test.timestamp) || !reflect.DeepEqual(event.Data, test.data) {
				t.Fatalf("event = %#v, ok = %t", event, ok)
			}
			if test.eventType == "qt_arrived" && (event.Data == nil || len(event.Data) != 0) {
				t.Fatalf("arrival data = %#v, want non-nil empty map", event.Data)
			}
		})
	}
}

func TestParserRejectsQuantumNegativeFixtures(t *testing.T) {
	parser := NewParser()
	for _, path := range []string{
		"quantum/qt_target_selected.invalid.log",
		"quantum/qt_fuel_requested.invalid.log",
		"quantum/qt_arrived.invalid.log",
	} {
		t.Run(path, func(t *testing.T) {
			event, ok := parser.Parse(readParserFixture(t, path))
			if ok || !reflect.DeepEqual(event, telemetry.TelemetryEvent{}) {
				t.Fatalf("unexpected event %#v", event)
			}
		})
	}
}

func TestParserQuantumRegressionCases(t *testing.T) {
	parser := NewParser()
	target := `[Notice] <Player Selected Quantum Target - Local> Player has selected point CRU-L5 as their destination`
	event, ok := parser.Parse(target)
	if !ok || event.Type != "qt_target_selected" || !reflect.DeepEqual(event.Data, map[string]string{"destination": "CRU-L5"}) {
		t.Fatalf("event = %#v, ok = %t", event, ok)
	}

	fuel := `[Notice] <Player Requested Fuel to Quantum Target - Local> Player has requested fuel calculation to destination CRU-L5`
	event, ok = parser.Parse(fuel)
	if !ok || event.Type != "qt_fuel_requested" || !reflect.DeepEqual(event.Data, map[string]string{"destination": "CRU-L5"}) {
		t.Fatalf("event = %#v, ok = %t", event, ok)
	}

	for _, line := range []string{
		`[Notice] Player has selected point as their destination`,
		`[Notice] Player has selected location ARC-L1 as their destination`,
		`[Notice] <Player Requested Fuel to Quantum Target - Local> Player has requested fuel calculation to destination`,
		`[Notice] Generic fuel calculation to destination CRU-L5`,
		`[Notice] Quantum Drive is arriving at final destination`,
		`[Notice] Quantum Travel arrival estimate updated`,
	} {
		event, ok := parser.Parse(line)
		if ok || !reflect.DeepEqual(event, telemetry.TelemetryEvent{}) {
			t.Fatalf("unexpected event for %q: %#v", line, event)
		}
	}
}

func TestParserQuantumArrivalDoesNotCorrelateDestination(t *testing.T) {
	parser := NewParser()
	target, ok := parser.Parse(`[Notice] <Player Selected Quantum Target - Local> Player has selected point ARC-L1 as their destination`)
	if !ok || target.Type != "qt_target_selected" || !reflect.DeepEqual(target.Data, map[string]string{"destination": "ARC-L1"}) {
		t.Fatalf("target = %#v, ok = %t", target, ok)
	}
	arrived, ok := parser.Parse(`[Notice] Quantum Drive has arrived at final destination`)
	assertArrivalHasNoDestination(t, arrived, ok)

	fuel, ok := parser.Parse(`[Notice] <Player Requested Fuel to Quantum Target - Local> Player has requested fuel calculation to destination CRU-L5`)
	if !ok || fuel.Type != "qt_fuel_requested" || !reflect.DeepEqual(fuel.Data, map[string]string{"destination": "CRU-L5"}) {
		t.Fatalf("fuel = %#v, ok = %t", fuel, ok)
	}
	arrived, ok = parser.Parse(`[Notice] Quantum Drive has arrived at final destination`)
	assertArrivalHasNoDestination(t, arrived, ok)
}

func assertArrivalHasNoDestination(t *testing.T, event telemetry.TelemetryEvent, ok bool) {
	t.Helper()
	if !ok || event.Type != "qt_arrived" || event.Data == nil || len(event.Data) != 0 {
		t.Fatalf("arrival event = %#v, ok = %t", event, ok)
	}
	if _, exists := event.Data["destination"]; exists {
		t.Fatalf("arrival must not contain destination: %#v", event.Data)
	}
}

func TestParserQuantumTimestampHandling(t *testing.T) {
	parser := NewParser()
	for _, line := range []string{
		`[Notice] Player has selected point ARC-L1 as their destination`,
		`<not-a-date> [Notice] Player has selected point ARC-L1 as their destination`,
		`prefix <2026-09-21T10:19:00.123Z> [Notice] Player has selected point ARC-L1 as their destination`,
	} {
		event, ok := parser.Parse(line)
		if !ok || event.Type != "qt_target_selected" || !event.Timestamp.IsZero() {
			t.Fatalf("event = %#v, ok = %t", event, ok)
		}
	}
}

func TestParserShipFixtures(t *testing.T) {
	parser := NewParser()
	cases := []struct {
		name      string
		path      string
		eventType string
		timestamp time.Time
	}{
		{"ship boarded", "ships/ship_boarded.valid.log", "ship_boarded", time.Date(2026, time.September, 21, 10, 17, 0, 123000000, time.UTC)},
		{"ship exited", "ships/ship_exited.valid.log", "ship_exited", time.Date(2026, time.September, 21, 10, 18, 0, 123000000, time.UTC)},
	}
	wantData := map[string]string{"ship": "RSI_Hermes", "owner": "TestOwner", "raw": "@vehicle_NameRSI_Hermes : TestOwner"}

	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			event, ok := parser.Parse(readParserFixture(t, test.path))
			if !ok || event.Type != test.eventType || event.Source != "game_log" || !event.Timestamp.Equal(test.timestamp) || !reflect.DeepEqual(event.Data, wantData) || len(event.Data) != 3 {
				t.Fatalf("event = %#v, ok = %t", event, ok)
			}
		})
	}
}

func TestParserRejectsShipNegativeFixtures(t *testing.T) {
	parser := NewParser()
	for _, path := range []string{
		"ships/ship_boarded.invalid.log",
		"ships/ship_exited.invalid.log",
	} {
		t.Run(path, func(t *testing.T) {
			event, ok := parser.Parse(readParserFixture(t, path))
			if ok || !reflect.DeepEqual(event, telemetry.TelemetryEvent{}) {
				t.Fatalf("unexpected event %#v", event)
			}
		})
	}
}

func TestParserShipChannelRegressionCases(t *testing.T) {
	parser := NewParser()
	boarded := `<2026-09-21T10:17:01.123Z> [Notice] <SHUDEvent_OnNotification> Added notification "You have joined channel '@vehicle_NameAnvil_Carrack : Example Owner'.`
	event, ok := parser.Parse(boarded)
	wantData := map[string]string{"ship": "Anvil_Carrack", "owner": "Example Owner", "raw": "@vehicle_NameAnvil_Carrack : Example Owner"}
	if !ok || event.Type != "ship_boarded" || !reflect.DeepEqual(event.Data, wantData) || len(event.Data) != 3 {
		t.Fatalf("event = %#v, ok = %t", event, ok)
	}

	withoutPrefix := `[Notice] <SHUDEvent_OnNotification> Added notification "You have joined channel 'RSI_Hermes : TestOwner'.`
	event, ok = parser.Parse(withoutPrefix)
	if !ok || event.Type != "ship_boarded" || event.Data["ship"] != "RSI_Hermes" || event.Data["raw"] != "RSI_Hermes : TestOwner" {
		t.Fatalf("event = %#v, ok = %t", event, ok)
	}
	middlePrefix := `[Notice] <SHUDEvent_OnNotification> Added notification "You have joined channel 'Fictional@vehicle_NameShip : TestOwner'.`
	event, ok = parser.Parse(middlePrefix)
	if !ok || event.Data["ship"] != "Fictional@vehicle_NameShip" {
		t.Fatalf("event = %#v, ok = %t", event, ok)
	}
	withoutSeparator := `[Notice] <SHUDEvent_OnNotification> Added notification "You have joined channel '@vehicle_NameRSI_Hermes'.`
	event, ok = parser.Parse(withoutSeparator)
	if !ok || event.Type != "ship_boarded" || !reflect.DeepEqual(event.Data, map[string]string{"ship": "RSI_Hermes", "owner": "", "raw": "@vehicle_NameRSI_Hermes"}) {
		t.Fatalf("event = %#v, ok = %t", event, ok)
	}
	plainColon := `[Notice] <SHUDEvent_OnNotification> Added notification "You have joined channel '@vehicle_NameExample:Variant'.`
	event, ok = parser.Parse(plainColon)
	if !ok || event.Type != "ship_boarded" || !reflect.DeepEqual(event.Data, map[string]string{"ship": "Example:Variant", "owner": "", "raw": "@vehicle_NameExample:Variant"}) {
		t.Fatalf("event = %#v, ok = %t", event, ok)
	}

	for _, line := range []string{
		`[Notice] <SHUDEvent_OnNotification> Added notification "You have joined party '@vehicle_NameRSI_Hermes : TestOwner'.`,
		`[Notice] <SHUDEvent_OnNotification> Added notification "You have left party '@vehicle_NameRSI_Hermes : TestOwner'.`,
		`[Notice] Vehicle channel @vehicle_NameRSI_Hermes : TestOwner`,
		`[Notice] <SHUDEvent_OnNotification> Added notification "You have joined channel '@vehicle_Name : TestOwner'.`,
	} {
		event, ok := parser.Parse(line)
		if ok || !reflect.DeepEqual(event, telemetry.TelemetryEvent{}) {
			t.Fatalf("unexpected event for %q: %#v", line, event)
		}
	}

	exited := `[Notice] <SHUDEvent_OnNotification> Added notification "You have left the channel '@vehicle_NameRSI_Hermes : TestOwner'.`
	event, ok = parser.Parse(exited)
	if !ok || event.Type != "ship_exited" || event.Data["ship"] != "RSI_Hermes" {
		t.Fatalf("event = %#v, ok = %t", event, ok)
	}
}

func TestParserShipTimestampHandling(t *testing.T) {
	parser := NewParser()
	for _, line := range []string{
		`[Notice] <SHUDEvent_OnNotification> Added notification "You have joined channel '@vehicle_NameRSI_Hermes : TestOwner'.`,
		`<not-a-date> [Notice] <SHUDEvent_OnNotification> Added notification "You have joined channel '@vehicle_NameRSI_Hermes : TestOwner'.`,
		`prefix <2026-09-21T10:17:00.123Z> [Notice] <SHUDEvent_OnNotification> Added notification "You have joined channel '@vehicle_NameRSI_Hermes : TestOwner'.`,
	} {
		event, ok := parser.Parse(line)
		if !ok || event.Type != "ship_boarded" || !event.Timestamp.IsZero() {
			t.Fatalf("event = %#v, ok = %t", event, ok)
		}
	}
}

func TestParserLocationFixtures(t *testing.T) {
	parser := NewParser()
	cases := []struct {
		name      string
		path      string
		eventType string
		timestamp time.Time
		data      map[string]string
	}{
		{
			name:      "location change",
			path:      "location/location_change.valid.log",
			eventType: "location_change",
			timestamp: time.Date(2026, time.September, 21, 10, 16, 0, 123000000, time.UTC),
			data:      map[string]string{"player": "TestPilot", "location": "RR_CRU_L1"},
		},
		{
			name:      "jurisdiction entered",
			path:      "location/jurisdiction_entered.valid.log",
			eventType: "jurisdiction_entered",
			timestamp: time.Date(2026, time.September, 21, 10, 16, 1, 123000000, time.UTC),
			data:      map[string]string{"jurisdiction": "Stanton"},
		},
	}

	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			event, ok := parser.Parse(readParserFixture(t, test.path))
			if !ok || event.Type != test.eventType || event.Source != "game_log" || !event.Timestamp.Equal(test.timestamp) || !reflect.DeepEqual(event.Data, test.data) {
				t.Fatalf("event = %#v, ok = %t", event, ok)
			}
		})
	}
}

func TestParserRejectsLocationNegativeFixtures(t *testing.T) {
	parser := NewParser()
	for _, path := range []string{
		"location/location_change.invalid.log",
		"location/jurisdiction_entered.invalid.log",
	} {
		t.Run(path, func(t *testing.T) {
			event, ok := parser.Parse(readParserFixture(t, path))
			if ok || !reflect.DeepEqual(event, telemetry.TelemetryEvent{}) {
				t.Fatalf("unexpected event %#v", event)
			}
		})
	}
}

func TestParserLocationChangeRegressionCases(t *testing.T) {
	parser := NewParser()
	valid := `<2026-09-21T10:16:02.123Z> [Notice] <RequestLocationInventory> Player[TestPilot] requested inventory for Location[OOC_Stanton_2c]`
	event, ok := parser.Parse(valid)
	if !ok || event.Type != "location_change" || event.Data["location"] != "OOC_Stanton_2c" || len(event.Data) != 2 {
		t.Fatalf("event = %#v, ok = %t", event, ok)
	}

	for _, line := range []string{
		`[Notice] <RequestLocationInventory> Player[] requested inventory for Location[RR_CRU_L1]`,
		`[Notice] <RequestLocationInventory> Player[TestPilot] requested inventory for Location[]`,
		`[Notice] <RequestLocationInventory> Player[TestPilot requested inventory for Location[RR_CRU_L1]`,
	} {
		event, ok := parser.Parse(line)
		if ok || !reflect.DeepEqual(event, telemetry.TelemetryEvent{}) {
			t.Fatalf("unexpected event for %q: %#v", line, event)
		}
	}
}

func TestParserJurisdictionRegressionCases(t *testing.T) {
	parser := NewParser()
	event, ok := parser.Parse(`<2026-09-21T10:16:03.123Z> [Notice] <SHUDEvent_OnNotification> Added notification "Entered Example Zone Jurisdiction: "`)
	if !ok || event.Type != "jurisdiction_entered" || !reflect.DeepEqual(event.Data, map[string]string{"jurisdiction": "Example Zone"}) {
		t.Fatalf("event = %#v, ok = %t", event, ok)
	}

	for _, line := range []string{
		`[Notice] <SHUDEvent_OnNotification> Added notification "Entered  Jurisdiction: "`,
		`[Notice] <SHUDEvent_OnNotification> Added notification "Leaving Stanton Jurisdiction: "`,
		`[Notice] <SHUDEvent_OnNotification> Added notification "Exited Stanton Jurisdiction: "`,
	} {
		event, ok := parser.Parse(line)
		if ok || !reflect.DeepEqual(event, telemetry.TelemetryEvent{}) {
			t.Fatalf("unexpected event for %q: %#v", line, event)
		}
	}
}

func TestParserLocationChangeWithoutTimestampHasZeroObservationTime(t *testing.T) {
	parser := NewParser()
	event, ok := parser.Parse(`[Notice] <RequestLocationInventory> Player[TestPilot] requested inventory for Location[RR_CRU_L1]`)
	if !ok || event.Type != "location_change" || !event.Timestamp.IsZero() {
		t.Fatalf("event = %#v, ok = %t", event, ok)
	}
}

func TestParserTimestampMustStartLineAndSupportsOffset(t *testing.T) {
	parser := NewParser()
	notAtStart := `prefix <2026-09-21T10:15:30.123Z> [Notice] nickname="TestPilot" playerGEID=123456789`
	offset := `<2026-09-21T12:15:30.123+02:00> [Notice] nickname="TestPilot" playerGEID=123456789`

	event, ok := parser.Parse(notAtStart)
	if !ok || !event.Timestamp.IsZero() {
		t.Fatalf("not-at-start event = %#v, ok = %t", event, ok)
	}
	event, ok = parser.Parse(offset)
	if !ok || event.Timestamp.IsZero() {
		t.Fatalf("offset event = %#v, ok = %t", event, ok)
	}
}

func TestParserReturnsFreshDataMaps(t *testing.T) {
	parser := NewParser()
	first, firstOK := parser.Parse(readParserFixture(t, "session/player_login.valid.log"))
	second, secondOK := parser.Parse(readParserFixture(t, "session/player_login.valid.log"))
	if !firstOK || !secondOK {
		t.Fatal("expected events")
	}
	first.Data["handle"] = "Changed"
	if second.Data["handle"] != "TestPilot" {
		t.Fatalf("events shared Data map: %#v", second.Data)
	}
}
