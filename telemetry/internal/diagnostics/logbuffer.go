package diagnostics

import (
	"sync"
	"time"
)

const ApplicationLogCapacity = 64

type LogSeverity string

const (
	SeverityInfo    LogSeverity = "info"
	SeverityWarning LogSeverity = "warning"
	SeverityError   LogSeverity = "error"
)

type LogEventCode string

const (
	LogAppStarted         LogEventCode = "app_started"
	LogRuntimeSearching   LogEventCode = "runtime_searching"
	LogGameLogUnavailable LogEventCode = "game_log_unavailable"
	LogGameLogMonitoring  LogEventCode = "game_log_monitoring"
	LogSessionActive      LogEventCode = "session_active"
	LogRuntimeWarning     LogEventCode = "runtime_warning"
	LogRuntimeError       LogEventCode = "runtime_error"
	LogAutostartEnabled   LogEventCode = "autostart_enabled"
	LogAutostartDisabled  LogEventCode = "autostart_disabled"
	LogAutostartRepaired  LogEventCode = "autostart_repaired"
	LogAutostartError     LogEventCode = "autostart_error"
	LogAutostartReadError LogEventCode = "autostart_read_error"
	LogShutdownTimeout    LogEventCode = "shutdown_timeout"
)

type ApplicationLogEntry struct {
	Timestamp time.Time
	Severity  LogSeverity
	EventCode LogEventCode
}

// LogBuffer stores only timestamped, allowlisted event categories. It has no
// API for messages, paths, values, or raw log content.
type LogBuffer struct {
	mu      sync.RWMutex
	entries [ApplicationLogCapacity]ApplicationLogEntry
	next    int
	count   int
}

func (b *LogBuffer) Record(severity LogSeverity, event LogEventCode) bool {
	if !validSeverity(severity) || !validEvent(event) {
		return false
	}
	b.mu.Lock()
	b.entries[b.next] = ApplicationLogEntry{
		Timestamp: time.Now().UTC().Truncate(time.Millisecond),
		Severity:  severity,
		EventCode: event,
	}
	b.next = (b.next + 1) % len(b.entries)
	if b.count < len(b.entries) {
		b.count++
	}
	b.mu.Unlock()
	return true
}

func (b *LogBuffer) Snapshot() []ApplicationLogEntry {
	b.mu.RLock()
	defer b.mu.RUnlock()
	result := make([]ApplicationLogEntry, 0, b.count)
	start := (b.next - b.count + len(b.entries)) % len(b.entries)
	for i := 0; i < b.count; i++ {
		result = append(result, b.entries[(start+i)%len(b.entries)])
	}
	return result
}

func validSeverity(value LogSeverity) bool {
	switch value {
	case SeverityInfo, SeverityWarning, SeverityError:
		return true
	default:
		return false
	}
}

func validEvent(value LogEventCode) bool {
	switch value {
	case LogAppStarted, LogRuntimeSearching, LogGameLogUnavailable, LogGameLogMonitoring,
		LogSessionActive, LogRuntimeWarning, LogRuntimeError, LogAutostartEnabled,
		LogAutostartDisabled, LogAutostartRepaired, LogAutostartError, LogAutostartReadError,
		LogShutdownTimeout:
		return true
	default:
		return false
	}
}
