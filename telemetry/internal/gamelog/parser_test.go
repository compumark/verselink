package gamelog

import (
	"os"
	"path/filepath"
	"reflect"
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
		readParserFixture(t, "ships/ship_boarded.valid.log"),
	}
	for _, line := range lines {
		event, ok := parser.Parse(line)
		if ok || !reflect.DeepEqual(event, telemetry.TelemetryEvent{}) {
			t.Fatalf("unexpected event for %q: %#v", line, event)
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
