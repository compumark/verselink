package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/compumark/verselink-telemetry/internal/diagnostics"
	"github.com/compumark/verselink-telemetry/internal/gamelog"
	"github.com/compumark/verselink-telemetry/internal/telemetry"
)

const defaultStatusInterval = time.Second

type logLocator interface {
	Locate() gamelog.LocateResult
}

type runtimeSession interface {
	Run(context.Context) error
	Diagnostics() gamelog.SessionDiagnostics
}

type sessionFactory func(gamelog.SessionConfig) (runtimeSession, gamelog.RestoreInfo, error)

// RuntimeConfig contains the small set of command-layer seams used by tests.
// Nil dependencies use the local Windows defaults.
type RuntimeConfig struct {
	BuildMetadata  diagnostics.BuildMetadata
	Locator        logLocator
	NewSession     sessionFactory
	PollInterval   time.Duration
	StatusInterval time.Duration
}

type runtimeErrorKind string

const (
	runtimeUnsupportedPlatform runtimeErrorKind = "unsupported_platform"
	runtimeGameLogNotFound     runtimeErrorKind = "game_log_not_found"
	runtimeSessionInitialize   runtimeErrorKind = "session_initialize"
	runtimeSessionRun          runtimeErrorKind = "session_run"
)

type runtimeError struct {
	kind runtimeErrorKind
}

func (e *runtimeError) Error() string {
	switch e.kind {
	case runtimeUnsupportedPlatform:
		return "Windows Game.log discovery is unsupported on this platform"
	case runtimeGameLogNotFound:
		return "Game.log was not found; start Star Citizen or set VERSELINK_GAME_LOG_PATH to a readable Game.log"
	case runtimeSessionInitialize:
		return "Game.log was found but the telemetry session could not be initialized"
	case runtimeSessionRun:
		return "the live Game.log session stopped unexpectedly"
	default:
		return "telemetry runtime failed"
	}
}

// Run wires the existing locator, Session, parser, reducer, and diagnostics
// into the foreground executable. It never reads or prints raw Game.log lines.
func Run(ctx context.Context, out io.Writer, config RuntimeConfig) error {
	if out == nil {
		out = io.Discard
	}
	locator := config.Locator
	if locator == nil {
		locator = gamelog.NewLocator(gamelog.Config{ManualPath: os.Getenv("VERSELINK_GAME_LOG_PATH")})
	}
	newSession := config.NewSession
	if newSession == nil {
		newSession = func(sessionConfig gamelog.SessionConfig) (runtimeSession, gamelog.RestoreInfo, error) {
			session, restore, err := gamelog.NewSession(sessionConfig)
			return session, restore, err
		}
	}
	pollInterval := config.PollInterval
	if pollInterval <= 0 {
		pollInterval = gamelog.DefaultTailerPollInterval
	}
	statusInterval := config.StatusInterval
	if statusInterval <= 0 {
		statusInterval = defaultStatusInterval
	}

	fmt.Fprintln(out, diagnostics.Banner(config.BuildMetadata))
	result := locator.Locate()
	if result.PlatformUnsupported {
		return &runtimeError{kind: runtimeUnsupportedPlatform}
	}
	if !result.Found() {
		return &runtimeError{kind: runtimeGameLogNotFound}
	}

	fmt.Fprintf(out, "Game.log found: %s\nDiscovery strategy: %s\n", result.Path, result.Strategy)
	session, restore, err := newSession(gamelog.SessionConfig{Path: result.Path, PollInterval: pollInterval})
	if err != nil || session == nil {
		return &runtimeError{kind: runtimeSessionInitialize}
	}
	fmt.Fprintf(out, "Restore boundary found: %t\nRestore replayed lines: %d\nResume offset: %d\n", restore.BoundaryFound, restore.ReplayedLines, restore.ResumeOffset)

	previous := session.Diagnostics()
	writeDiagnostics(out, previous)
	return monitorSession(ctx, out, session, previous, statusInterval)
}

func monitorSession(ctx context.Context, out io.Writer, session runtimeSession, previous gamelog.SessionDiagnostics, interval time.Duration) error {
	last := diagnosticsState(previous)
	runDone := make(chan error, 1)
	go func() { runDone <- session.Run(ctx) }()

	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case err := <-runDone:
			if ctx.Err() != nil && err == nil {
				return nil
			}
			return &runtimeError{kind: runtimeSessionRun}
		case <-ctx.Done():
			err := <-runDone
			if err != nil {
				return &runtimeError{kind: runtimeSessionRun}
			}
			return nil
		case <-ticker.C:
			next := session.Diagnostics()
			last, _ = writeDiagnosticsIfChanged(out, next, last)
		}
	}
}

func writeDiagnostics(out io.Writer, snapshot gamelog.SessionDiagnostics) {
	fmt.Fprintf(out, "Diagnostics:\n%s\n", diagnostics.FormatSession(snapshot))
}

func writeDiagnosticsIfChanged(out io.Writer, snapshot gamelog.SessionDiagnostics, previous diagnosticState) (diagnosticState, bool) {
	next := diagnosticsState(snapshot)
	if next == previous {
		return previous, false
	}
	writeDiagnostics(out, snapshot)
	return next, true
}

// diagnosticState contains only values that are meaningful to a local user.
// It deliberately uses Party count rather than member names and does not retain
// raw lines, event data, or pointer identities.
type diagnosticState struct {
	SessionActive    bool
	PlayerHandle     string
	Shard            string
	Location         string
	LocationObserved time.Time
	Jurisdiction     string
	ShipName         string
	ShipOwner        string
	QuantumTarget    string
	QuantumState     string
	PartyCount       int
	SourceResets     uint64
}

func diagnosticsState(snapshot gamelog.SessionDiagnostics) diagnosticState {
	state := snapshot.State
	result := diagnosticState{
		SessionActive: state.SessionActive,
		PlayerHandle:  state.PlayerHandle,
		Shard:         state.Shard,
		Jurisdiction:  state.Jurisdiction,
		PartyCount:    len(state.Party),
		SourceResets:  snapshot.SourceResetCount,
	}
	copyLocation(&result, state.Location)
	copyShip(&result, state.Ship)
	copyQuantum(&result, state.Quantum)
	return result
}

func copyLocation(result *diagnosticState, location *telemetry.LocationState) {
	if location == nil {
		return
	}
	result.Location = location.Raw
	result.LocationObserved = location.ObservedAt
}

func copyShip(result *diagnosticState, ship *telemetry.ShipState) {
	if ship == nil {
		return
	}
	result.ShipName = ship.Name
	result.ShipOwner = ship.Owner
}

func copyQuantum(result *diagnosticState, quantum *telemetry.QuantumState) {
	if quantum == nil {
		return
	}
	result.QuantumTarget = quantum.Destination
	result.QuantumState = quantum.State
}

func isRuntimeError(err error, kind runtimeErrorKind) bool {
	var runtimeErr *runtimeError
	return errors.As(err, &runtimeErr) && runtimeErr.kind == kind
}
