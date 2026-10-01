// Package diagnosticsexport creates a bounded, privacy-filtered local support
// snapshot. It deliberately accepts structured snapshots instead of formatted
// diagnostics text so private identifiers cannot flow through accidentally.
package diagnosticsexport

import (
	"encoding/json"
	"fmt"
	"runtime"
	"runtime/debug"
	"strconv"
	"strings"
	"time"

	"github.com/compumark/verselink-telemetry/internal/connection"
	"github.com/compumark/verselink-telemetry/internal/diagnostics"
	"github.com/compumark/verselink-telemetry/internal/gamelog"
	"github.com/compumark/verselink-telemetry/internal/runtimehost"
	"github.com/compumark/verselink-telemetry/internal/telemetry"
)

const (
	SchemaVersion          = 1
	MaxBytes               = 16 * 1024
	MaxLifecycle           = 12
	MaxApplicationLogs     = 24
	MaxApplicationLogBytes = 4 * 1024
)

// ReleaseVersion and ReleaseCommit are set by the Windows release build.
// Empty values deliberately preserve useful source-build metadata fallbacks.
var (
	ReleaseVersion = ""
	ReleaseCommit  = ""
)

type lifecycleCode string

const (
	lifecycleStartManual      lifecycleCode = "start_manual"
	lifecycleStartAutostart   lifecycleCode = "start_autostart"
	lifecycleAutostartEnabled lifecycleCode = "autostart_enabled"
	lifecycleAutostartDisable lifecycleCode = "autostart_disabled"
	lifecycleAutostartRepair  lifecycleCode = "autostart_repaired"
	lifecycleAutostartError   lifecycleCode = "autostart_error"
	lifecycleAutostartReadErr lifecycleCode = "autostart_read_error"
)

// Snapshot is the input boundary. No arbitrary messages, paths, or raw state
// values are serialized from it.
type Snapshot struct {
	Status          runtimehost.Status
	Health          connection.HealthStatus
	Lifecycle       []string
	ApplicationLogs []diagnostics.ApplicationLogEntry
}

type exportDocument struct {
	SchemaVersion   int              `json:"schema_version"`
	Application     applicationInfo  `json:"application"`
	Runtime         runtimeInfo      `json:"runtime"`
	Counters        counters         `json:"counters"`
	Connection      connectionInfo   `json:"connection"`
	Lifecycle       []string         `json:"recent_lifecycle_events"`
	ApplicationLogs []applicationLog `json:"application_logs"`
}

type applicationInfo struct {
	Name         string `json:"name"`
	Version      string `json:"version"`
	Commit       string `json:"commit"`
	GoVersion    string `json:"go_version"`
	OS           string `json:"os"`
	Architecture string `json:"architecture"`
}

type runtimeInfo struct {
	Phase             string `json:"phase"`
	DiscoveryStrategy string `json:"discovery_strategy"`
	GameLogAvailable  bool   `json:"game_log_available"`
	Channel           string `json:"channel"`
	SessionActive     bool   `json:"session_active"`
	LocationKnown     bool   `json:"location_known"`
	JurisdictionKnown bool   `json:"jurisdiction_known"`
	ShipKnown         bool   `json:"ship_known"`
	QuantumState      string `json:"quantum_state"`
	PartyCount        int    `json:"party_count"`
}

type counters struct {
	LinesProcessed   uint64 `json:"lines_processed"`
	ParserEventCount uint64 `json:"parser_event_count"`
	SourceResetCount uint64 `json:"source_reset_count"`
}

type connectionInfo struct {
	State string `json:"state"`
}

type applicationLog struct {
	Timestamp string `json:"timestamp"`
	Severity  string `json:"severity"`
	EventCode string `json:"event_code"`
}

// Marshal returns stable, indented JSON for the same input. Field ordering is
// fixed by the structs, and lifecycle values are filtered through an allowlist.
func Marshal(snapshot Snapshot) ([]byte, error) {
	state := snapshot.Status.Diagnostics.State
	version, commit := buildMetadata()
	phase := enum(string(snapshot.Status.Phase), map[string]string{
		"starting": "starting", "searching": "searching", "monitoring": "monitoring",
		"session_active": "session_active", "game_log_unavailable": "game_log_unavailable",
		"warning": "warning", "fatal": "fatal",
	}, "unknown")
	doc := exportDocument{
		SchemaVersion: SchemaVersion,
		Application: applicationInfo{
			Name: "VerseLink Telemetry", Version: version, Commit: commit,
			GoVersion: runtime.Version(), OS: runtime.GOOS, Architecture: runtime.GOARCH,
		},
		Runtime: runtimeInfo{
			Phase:             phase,
			DiscoveryStrategy: strategy(snapshot.Status.Configuration.EffectiveStrategy, snapshot.Status.Strategy),
			GameLogAvailable:  snapshot.Status.Path != "" || snapshot.Status.Configuration.EffectivePath != "",
			Channel:           channel(snapshot.Status.Configuration.Channel),
			SessionActive:     snapshot.Status.HasDiagnostics && state.SessionActive,
			LocationKnown:     snapshot.Status.HasDiagnostics && state.Location != nil,
			JurisdictionKnown: snapshot.Status.HasDiagnostics && state.Jurisdiction != "",
			ShipKnown:         snapshot.Status.HasDiagnostics && state.Ship != nil && state.Ship.Name != "",
			QuantumState:      quantumState(state.Quantum, snapshot.Status.HasDiagnostics),
			PartyCount:        partyCount(snapshot.Status.Diagnostics, snapshot.Status.HasDiagnostics),
		},
		Counters:        counters{},
		Connection:      connectionInfo{State: connectionState(snapshot.Health.State)},
		Lifecycle:       lifecycle(snapshot.Lifecycle),
		ApplicationLogs: applicationLogs(snapshot.ApplicationLogs),
	}
	if snapshot.Status.HasDiagnostics {
		doc.Counters = counters{
			LinesProcessed:   snapshot.Status.Diagnostics.LinesProcessed,
			ParserEventCount: snapshot.Status.Diagnostics.ParserEventCount,
			SourceResetCount: snapshot.Status.Diagnostics.SourceResetCount,
		}
	}
	return encodeBounded(doc, MaxBytes)
}

func encodeBounded(value any, limit int) ([]byte, error) {
	if limit < 1 {
		return nil, fmt.Errorf("invalid diagnostics export limit")
	}
	encoded, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("encode diagnostics export: %w", err)
	}
	encoded = append(encoded, '\n')
	if len(encoded) > limit {
		return nil, fmt.Errorf("diagnostics export exceeds %d-byte limit", limit)
	}
	return encoded, nil
}

func applicationLogs(entries []diagnostics.ApplicationLogEntry) []applicationLog {
	start := len(entries) - MaxApplicationLogs
	if start < 0 {
		start = 0
	}
	result := make([]applicationLog, 0, len(entries)-start)
	for _, entry := range entries[start:] {
		severity := enum(string(entry.Severity), map[string]string{
			string(diagnostics.SeverityInfo):    "info",
			string(diagnostics.SeverityWarning): "warning",
			string(diagnostics.SeverityError):   "error",
		}, "")
		event := allowedLogEvent(entry.EventCode)
		if severity == "" || event == "" || entry.Timestamp.IsZero() {
			continue
		}
		timestamp := entry.Timestamp.UTC().Format(time.RFC3339Nano)
		if len(timestamp) > 40 {
			continue
		}
		candidate := append(result, applicationLog{Timestamp: timestamp, Severity: severity, EventCode: event})
		encoded, _ := json.MarshalIndent(candidate, "", "    ")
		if len(encoded) > MaxApplicationLogBytes {
			break
		}
		result = candidate
	}
	return result
}

func allowedLogEvent(value diagnostics.LogEventCode) string {
	switch value {
	case diagnostics.LogAppStarted:
		return "app_started"
	case diagnostics.LogRuntimeSearching:
		return "runtime_searching"
	case diagnostics.LogGameLogUnavailable:
		return "game_log_unavailable"
	case diagnostics.LogGameLogMonitoring:
		return "game_log_monitoring"
	case diagnostics.LogSessionActive:
		return "session_active"
	case diagnostics.LogRuntimeWarning:
		return "runtime_warning"
	case diagnostics.LogRuntimeError:
		return "runtime_error"
	case diagnostics.LogAutostartEnabled:
		return "autostart_enabled"
	case diagnostics.LogAutostartDisabled:
		return "autostart_disabled"
	case diagnostics.LogAutostartRepaired:
		return "autostart_repaired"
	case diagnostics.LogAutostartError:
		return "autostart_error"
	case diagnostics.LogAutostartReadError:
		return "autostart_read_error"
	case diagnostics.LogShutdownTimeout:
		return "shutdown_timeout"
	default:
		return ""
	}
}

func BuildInfo() (version, commit string) {
	version, commit = "dev", "unknown"
	if StableBuildVersion(ReleaseVersion) {
		version = ReleaseVersion
	}
	if isHexRevision(ReleaseCommit) {
		commit = strings.ToLower(ReleaseCommit)
	}
	info, ok := debug.ReadBuildInfo()
	if !ok || info == nil {
		return version, commit
	}
	if ReleaseVersion == "" && info.Main.Version != "" && info.Main.Version != "(devel)" {
		version = info.Main.Version
	}
	for _, setting := range info.Settings {
		if ReleaseCommit == "" && setting.Key == "vcs.revision" && isHexRevision(setting.Value) {
			commit = setting.Value
		}
	}
	return version, commit
}

func StableBuildVersion(value string) bool {
	if len(value) < 6 || value[0] != 'v' {
		return false
	}
	parts := strings.Split(value[1:], ".")
	if len(parts) != 3 {
		return false
	}
	for _, part := range parts {
		if part == "" || (len(part) > 1 && part[0] == '0') {
			return false
		}
		for _, char := range part {
			if char < '0' || char > '9' {
				return false
			}
		}
	}
	return true
}

var buildMetadata = BuildInfo

func enum(value string, allowed map[string]string, fallback string) string {
	if mapped, ok := allowed[value]; ok {
		return mapped
	}
	return fallback
}

func strategy(primary, fallback gamelog.DiscoveryStrategy) string {
	allowed := map[string]string{
		string(gamelog.StrategyLauncherLog):    "launcher_log",
		string(gamelog.StrategyRunningProcess): "running_process",
		string(gamelog.StrategyKnownLocation):  "known_location",
		string(gamelog.StrategyRegistry):       "registry",
		string(gamelog.StrategyManual):         "manual",
	}
	if _, ok := allowed[string(primary)]; !ok {
		primary = fallback
	}
	return enum(string(primary), allowed, "unknown")
}

func channel(value string) string {
	return enum(strings.ToUpper(strings.TrimSpace(value)), map[string]string{
		"LIVE": "LIVE", "PTU": "PTU", "EPTU": "EPTU",
	}, "other_or_unknown")
}

func quantumState(value *telemetry.QuantumState, available bool) string {
	if !available || value == nil {
		return "unknown"
	}
	return enum(strings.ToLower(strings.TrimSpace(value.State)), map[string]string{
		"target_selected": "target_selected", "fuel_requested": "fuel_requested",
		"arrived": "arrived",
	}, "other_or_unknown")
}

func partyCount(snapshot gamelog.SessionDiagnostics, available bool) int {
	if !available {
		return 0
	}
	return len(snapshot.State.Party)
}

func lifecycle(events []string) []string {
	allowed := map[string]lifecycleCode{
		"start_manual": lifecycleStartManual, "start_autostart": lifecycleStartAutostart,
		"autostart_enabled": lifecycleAutostartEnabled, "autostart_disabled": lifecycleAutostartDisable,
		"autostart_repaired": lifecycleAutostartRepair, "autostart_error": lifecycleAutostartError,
		"autostart_read_error": lifecycleAutostartReadErr,
	}
	start := len(events) - MaxLifecycle
	if start < 0 {
		start = 0
	}
	result := make([]string, 0, len(events)-start)
	for _, event := range events[start:] {
		if value, ok := allowed[event]; ok {
			result = append(result, string(value))
		}
	}
	return result
}

func connectionState(value connection.HealthState) string {
	return enum(string(value), map[string]string{
		string(connection.HealthNotConnected):         "not_connected",
		string(connection.HealthConnecting):           "connecting",
		string(connection.HealthConnected):            "connected",
		string(connection.HealthTemporarilyOffline):   "temporarily_offline",
		string(connection.HealthAuthenticationFailed): "authentication_failed",
		string(connection.HealthDeviceRevoked):        "device_revoked",
	}, "unknown")
}

func isHexRevision(value string) bool {
	if len(value) < 7 || len(value) > 64 {
		return false
	}
	_, err := strconv.ParseUint(value[:min(16, len(value))], 16, 64)
	if err != nil {
		return false
	}
	for _, char := range value {
		if !(char >= '0' && char <= '9' || char >= 'a' && char <= 'f' || char >= 'A' && char <= 'F') {
			return false
		}
	}
	return true
}
