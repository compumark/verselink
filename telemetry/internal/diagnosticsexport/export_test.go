package diagnosticsexport

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/compumark/verselink-telemetry/internal/connection"
	"github.com/compumark/verselink-telemetry/internal/diagnostics"
	"github.com/compumark/verselink-telemetry/internal/gamelog"
	"github.com/compumark/verselink-telemetry/internal/runtimehost"
	"github.com/compumark/verselink-telemetry/internal/telemetry"
)

func TestMarshalIsStableBoundedAndAllowlisted(t *testing.T) {
	status := runtimehost.Status{
		Phase:    runtimehost.PhaseSessionActive,
		Path:     `C:\Users\PrivatePilot\Game.log`,
		Message:  "RAW_ERROR_SECRET_SENTINEL",
		Strategy: gamelog.StrategyRegistry,
		Configuration: runtimehost.ConfigurationStatus{
			EffectivePath:     `C:\Users\PrivatePilot\Game.log`,
			EffectiveStrategy: gamelog.StrategyManual,
			Channel:           "LIVE",
			Warning:           "PRIVATE_WARNING_SENTINEL",
		},
		HasDiagnostics: true,
		Diagnostics: gamelog.SessionDiagnostics{
			LogPath:        `C:\Users\PrivatePilot\Game.log`,
			LinesProcessed: 12, ParserEventCount: 4, SourceResetCount: 1,
			State: telemetry.TelemetryState{
				SessionActive: true, PlayerHandle: "PLAYER_HANDLE_SENTINEL", Shard: "PRIVATE_SHARD_SENTINEL",
				Location:     &telemetry.LocationState{Raw: "PRIVATE_LOCATION_SENTINEL"},
				Jurisdiction: "PRIVATE_JURISDICTION_SENTINEL",
				Ship:         &telemetry.ShipState{Name: "PRIVATE_SHIP_SENTINEL", Owner: "PRIVATE_OWNER_SENTINEL"},
				Quantum:      &telemetry.QuantumState{Destination: "PRIVATE_DESTINATION_SENTINEL", State: "arrived"},
				Party:        []string{"CrewMate", "SecondMate"},
			},
		},
	}
	snapshot := Snapshot{
		Status:    status,
		Health:    connection.HealthStatus{State: connection.HealthConnected, DeviceID: "DEVICE_SECRET_SENTINEL", Error: "PRIVATE_HTTP_ERROR"},
		Lifecycle: []string{"start_manual", "UNKNOWN_SECRET_EVENT", strings.Repeat("x", 100000)},
		ApplicationLogs: []diagnostics.ApplicationLogEntry{
			{Timestamp: time.Date(2026, 10, 1, 9, 30, 0, 0, time.UTC), Severity: diagnostics.SeverityWarning, EventCode: diagnostics.LogGameLogUnavailable},
			{Timestamp: time.Now(), Severity: diagnostics.SeverityError, EventCode: diagnostics.LogEventCode("RAW_SECRET_SENTINEL")},
		},
	}
	first, err := Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	second, err := Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(first, second) {
		t.Fatal("same snapshot did not produce identical bytes")
	}
	if len(first) > MaxBytes {
		t.Fatalf("export size = %d, limit %d", len(first), MaxBytes)
	}

	text := string(first)
	for _, expected := range []string{
		`"schema_version": 1`, `"phase": "session_active"`, `"discovery_strategy": "manual"`,
		`"channel": "LIVE"`, `"lines_processed": 12`, `"parser_event_count": 4`,
		`"source_reset_count": 1`, `"party_count": 2`, `"state": "connected"`,
		"\"recent_lifecycle_events\": [\n    \"start_manual\"",
		`"event_code": "game_log_unavailable"`,
		`"severity": "warning"`,
		`"timestamp": "2026-10-01T09:30:00Z"`,
	} {
		if !strings.Contains(text, expected) {
			t.Errorf("export missing %q", expected)
		}
	}
	for _, forbidden := range []string{
		`C:\Users\PrivatePilot`, "Game.log", "PLAYER_HANDLE_SENTINEL", "PRIVATE_SHARD_SENTINEL",
		"PRIVATE_LOCATION_SENTINEL", "PRIVATE_JURISDICTION_SENTINEL", "PRIVATE_SHIP_SENTINEL",
		"PRIVATE_OWNER_SENTINEL", "PRIVATE_DESTINATION_SENTINEL", "CrewMate", "SecondMate",
		"DEVICE_SECRET_SENTINEL", "PRIVATE_HTTP_ERROR", "RAW_ERROR_SECRET_SENTINEL",
		"PRIVATE_WARNING_SENTINEL", "UNKNOWN_SECRET_EVENT", "map[",
		"RAW_SECRET_SENTINEL", "Game.log path",
	} {
		if strings.Contains(text, forbidden) {
			t.Errorf("export contains forbidden value %q", forbidden)
		}
	}
}

func TestBuildInfoUsesReleaseMetadataAndKeepsDevelopmentFallbacks(t *testing.T) {
	oldVersion, oldCommit := ReleaseVersion, ReleaseCommit
	t.Cleanup(func() { ReleaseVersion, ReleaseCommit = oldVersion, oldCommit })
	ReleaseVersion, ReleaseCommit = "v2.4.6", "0123456789abcdef0123456789abcdef01234567"
	version, commit := BuildInfo()
	if version != ReleaseVersion || commit != ReleaseCommit {
		t.Fatalf("BuildInfo() = %q, %q; want release linker values", version, commit)
	}
	ReleaseVersion, ReleaseCommit = "invalid-version", "not-a-revision"
	version, commit = BuildInfo()
	if version == "invalid-version" || commit == "not-a-revision" {
		t.Fatalf("BuildInfo accepted malformed linker values: %q, %q", version, commit)
	}
}

func TestMarshalRejectsOversizedJSONWithoutReturningTruncatedData(t *testing.T) {
	input := map[string]string{"diagnostic": strings.Repeat("x", 256)}
	data, err := encodeBounded(input, 64)
	if err == nil {
		t.Fatal("oversized JSON unexpectedly succeeded")
	}
	if data != nil {
		t.Fatalf("oversized JSON returned partial data: %q", data)
	}
	valid, err := encodeBounded(map[string]string{"ok": "yes"}, 64)
	if err != nil {
		t.Fatalf("under-limit JSON rejected: %v", err)
	}
	if !json.Valid(valid) {
		t.Fatalf("success returned invalid JSON: %q", valid)
	}
}

func TestApplicationLogsUseAllowlistAndStayWithinCountAndByteBounds(t *testing.T) {
	entries := make([]diagnostics.ApplicationLogEntry, MaxApplicationLogs+20)
	for i := range entries {
		entries[i] = diagnostics.ApplicationLogEntry{
			Timestamp: time.Date(2026, 10, 1, 9, 30, 0, i*int(time.Millisecond), time.UTC),
			Severity:  diagnostics.SeverityInfo, EventCode: diagnostics.LogRuntimeSearching,
		}
	}
	entries[len(entries)-1].EventCode = diagnostics.LogEventCode("C:\\Users\\Private\\Game.log SECRET_SENTINEL")
	logs := applicationLogs(entries)
	if len(logs) != MaxApplicationLogs-1 {
		t.Fatalf("logs=%d, want %d after dropping the unknown final code", len(logs), MaxApplicationLogs-1)
	}
	encoded, err := json.Marshal(logs)
	if err != nil {
		t.Fatal(err)
	}
	if len(encoded) > MaxApplicationLogBytes {
		t.Fatalf("logs bytes=%d, maximum=%d", len(encoded), MaxApplicationLogBytes)
	}
	if strings.Contains(string(encoded), "SECRET_SENTINEL") || strings.Contains(string(encoded), "Game.log") {
		t.Fatalf("untrusted log field leaked: %s", encoded)
	}
}

func TestMarshalUnknownValuesBecomeSafeCategories(t *testing.T) {
	data, err := Marshal(Snapshot{
		Status: runtimehost.Status{
			Phase:          "user-controlled-phase",
			Strategy:       "user-controlled-strategy",
			Configuration:  runtimehost.ConfigurationStatus{Channel: "PrivateChannelName"},
			HasDiagnostics: true,
			Diagnostics: gamelog.SessionDiagnostics{State: telemetry.TelemetryState{
				Quantum: &telemetry.QuantumState{State: "private future state"},
			}},
		},
		Health: connection.HealthStatus{State: "private error with token"},
	})
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	for _, expected := range []string{`"phase": "unknown"`, `"discovery_strategy": "unknown"`, `"channel": "other_or_unknown"`, `"quantum_state": "other_or_unknown"`, `"state": "unknown"`} {
		if !strings.Contains(text, expected) {
			t.Errorf("export missing %q", expected)
		}
	}
	if strings.Contains(text, "PrivateChannelName") || strings.Contains(text, "private error") {
		t.Fatalf("unrecognized value leaked: %s", text)
	}
}

func TestLifecycleIsBoundedAndDropsUnknownEvents(t *testing.T) {
	events := make([]string, MaxLifecycle+3)
	for i := range events {
		events[i] = "autostart_error"
	}
	events[0] = "older_event"
	events[len(events)-1] = "secret-value"
	got := lifecycle(events)
	if len(got) != MaxLifecycle-1 {
		t.Fatalf("allowed lifecycle count = %d, want %d", len(got), MaxLifecycle-1)
	}
	for _, event := range got {
		if event != "autostart_error" {
			t.Errorf("unexpected event %q", event)
		}
	}
}
