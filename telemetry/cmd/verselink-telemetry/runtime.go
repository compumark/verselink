package main

import (
	"context"
	"fmt"
	"io"
	"time"

	"github.com/compumark/verselink-telemetry/internal/diagnostics"
	"github.com/compumark/verselink-telemetry/internal/gamelog"
	"github.com/compumark/verselink-telemetry/internal/runtimehost"
)

const defaultStatusInterval = runtimehost.DefaultStatusInterval

type logLocator = runtimehost.Locator
type runtimeSession = runtimehost.Session
type sessionFactory = runtimehost.SessionFactory

// RuntimeConfig contains the small set of command-layer seams used by tests.
// Nil dependencies use the local Windows defaults.
type RuntimeConfig struct {
	BuildMetadata  diagnostics.BuildMetadata
	Locator        logLocator
	NewSession     sessionFactory
	PollInterval   time.Duration
	StatusInterval time.Duration
}

type runtimeErrorKind = runtimehost.ErrorKind

const (
	runtimeUnsupportedPlatform = runtimehost.ErrorUnsupportedPlatform
	runtimeGameLogNotFound     = runtimehost.ErrorGameLogNotFound
	runtimeSessionInitialize   = runtimehost.ErrorSessionInitialize
	runtimeSessionRun          = runtimehost.ErrorSessionRun
)

// Run preserves the B1 foreground console while delegating all locator,
// Session, parser, reducer, and status behavior to the shared runtime host.
func Run(ctx context.Context, out io.Writer, config RuntimeConfig) error {
	if out == nil {
		out = io.Discard
	}
	fmt.Fprintln(out, diagnostics.Banner(config.BuildMetadata))
	observer := &consoleObserver{out: out}
	return runtimehost.Run(ctx, runtimehost.Config{
		Locator:        config.Locator,
		NewSession:     config.NewSession,
		Observer:       observer,
		PollInterval:   config.PollInterval,
		StatusInterval: config.StatusInterval,
	})
}

type consoleObserver struct {
	out             io.Writer
	pathReported    bool
	restoreReported bool
}

func (o *consoleObserver) OnRuntimeStatus(status runtimehost.Status) {
	if status.Path != "" && !o.pathReported {
		fmt.Fprintf(o.out, "Game.log found: %s\nDiscovery strategy: %s\n", status.Path, status.Strategy)
		o.pathReported = true
	}
	if status.HasRestore && !o.restoreReported {
		fmt.Fprintf(o.out, "Restore boundary found: %t\nRestore replayed lines: %d\nResume offset: %d\n", status.Restore.BoundaryFound, status.Restore.ReplayedLines, status.Restore.ResumeOffset)
		o.restoreReported = true
	}
	if status.HasDiagnostics {
		writeDiagnostics(o.out, status.Diagnostics)
	}
}

func writeDiagnostics(out io.Writer, snapshot gamelog.SessionDiagnostics) {
	fmt.Fprintf(out, "Diagnostics:\n%s\n", diagnostics.FormatSession(snapshot))
}

type diagnosticState = runtimehost.DiagnosticState

func diagnosticsState(snapshot gamelog.SessionDiagnostics) diagnosticState {
	return runtimehost.DiagnosticsState(snapshot)
}

func writeDiagnosticsIfChanged(out io.Writer, snapshot gamelog.SessionDiagnostics, previous diagnosticState) (diagnosticState, bool) {
	next := diagnosticsState(snapshot)
	if next == previous {
		return previous, false
	}
	writeDiagnostics(out, snapshot)
	return next, true
}

func isRuntimeError(err error, kind runtimeErrorKind) bool {
	return runtimehost.IsError(err, kind)
}
