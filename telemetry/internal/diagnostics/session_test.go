package diagnostics

import (
	"strings"
	"testing"
	"time"

	"github.com/compumark/verselink-telemetry/internal/gamelog"
	"github.com/compumark/verselink-telemetry/internal/telemetry"
)

func TestFormatSessionPopulatedState(t *testing.T) {
	locationAt := time.Date(2026, 9, 22, 12, 0, 3, 123456789, time.UTC)
	lastEventAt := time.Date(2026, 9, 22, 12, 0, 14, 0, time.UTC)
	snapshot := gamelog.SessionDiagnostics{
		LogPath:          `C:\Games\StarCitizen\LIVE\Game.log`,
		LinesProcessed:   15,
		ParserEventCount: 13,
		SourceResetCount: 2,
		State: telemetry.TelemetryState{
			SessionActive: true,
			PlayerHandle:  "TestPilot",
			Shard:         "pub_test_shard_001",
			Location:      &telemetry.LocationState{Raw: "RR_CRU_L1", ObservedAt: locationAt, Source: "game_log"},
			Jurisdiction:  "Stanton",
			Ship:          &telemetry.ShipState{Name: "RSI_Hermes", Owner: "TestOwner"},
			Quantum:       &telemetry.QuantumState{Destination: "ARC-L1", State: telemetry.QuantumStateArrived},
			Party:         []string{"CrewMate", "SecondMate"},
			LastEventAt:   lastEventAt,
		},
	}

	want := strings.Join([]string{
		`Log path: C:\Games\StarCitizen\LIVE\Game.log`,
		"Lines processed: 15",
		"Parser events: 13",
		"Source resets: 2",
		"Session active: true",
		"Player handle: TestPilot",
		"Shard: pub_test_shard_001",
		"Last location: RR_CRU_L1",
		"Location observed: 2026-09-22T12:00:03.123456789Z",
		"Jurisdiction: Stanton",
		"Current ship: RSI_Hermes (owner: TestOwner)",
		"QT destination: ARC-L1",
		"QT state: arrived",
		"Party members: 2",
		"Last event: 2026-09-22T12:00:14Z",
	}, "\n")
	if got := FormatSession(snapshot); got != want {
		t.Fatalf("FormatSession() =\n%s\nwant:\n%s", got, want)
	}
	for _, forbidden := range []string{"GEID_SECRET_SENTINEL", "RAW_GAME_LOG_SECRET_SENTINEL", "GEID", "playerGEID", "map[", "CrewMate", "SecondMate"} {
		if strings.Contains(FormatSession(snapshot), forbidden) {
			t.Fatalf("formatted diagnostics contain forbidden value %q", forbidden)
		}
	}
}

func TestFormatSessionZeroState(t *testing.T) {
	want := strings.Join([]string{
		"Log path: -",
		"Lines processed: 0",
		"Parser events: 0",
		"Source resets: 0",
		"Session active: false",
		"Player handle: -",
		"Shard: -",
		"Last location: -",
		"Location observed: -",
		"Jurisdiction: -",
		"Current ship: -",
		"QT destination: -",
		"QT state: -",
		"Party members: 0",
		"Last event: -",
	}, "\n")
	if got := FormatSession(gamelog.SessionDiagnostics{}); got != want {
		t.Fatalf("FormatSession() =\n%s\nwant:\n%s", got, want)
	}
}

func TestFormatSessionHandlesPresentDomainsWithEmptyValues(t *testing.T) {
	snapshot := gamelog.SessionDiagnostics{State: telemetry.TelemetryState{
		Location: &telemetry.LocationState{},
		Ship:     &telemetry.ShipState{Name: "Anvil_Carrack"},
		Quantum:  &telemetry.QuantumState{State: telemetry.QuantumStateArrived},
	}}
	got := FormatSession(snapshot)
	for _, want := range []string{
		"Last location: -",
		"Location observed: -",
		"Current ship: Anvil_Carrack",
		"QT destination: -",
		"QT state: arrived",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("FormatSession() missing %q:\n%s", want, got)
		}
	}
}
