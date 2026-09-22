package main

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/compumark/verselink-telemetry/internal/gamelog"
	"github.com/compumark/verselink-telemetry/internal/telemetry"
)

type fakeLocator struct{ result gamelog.LocateResult }

func (f fakeLocator) Locate() gamelog.LocateResult { return f.result }

type fakeSession struct {
	mu      sync.RWMutex
	diag    gamelog.SessionDiagnostics
	runErr  error
	started chan struct{}
}

func (f *fakeSession) Run(ctx context.Context) error {
	if f.started != nil {
		close(f.started)
	}
	if f.runErr != nil {
		return f.runErr
	}
	<-ctx.Done()
	return nil
}

func (f *fakeSession) Diagnostics() gamelog.SessionDiagnostics {
	f.mu.RLock()
	defer f.mu.RUnlock()
	return f.diag
}

func (f *fakeSession) setDiagnostics(diag gamelog.SessionDiagnostics) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.diag = diag
}

func TestRunDiscoverySuccessAndStartupDiagnostics(t *testing.T) {
	session := &fakeSession{started: make(chan struct{}), diag: populatedDiagnostics()}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var out lockedBuffer
	done := make(chan error, 1)
	go func() { done <- Run(ctx, &out, testConfig(session)) }()
	<-session.started
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	got := out.String()
	for _, want := range []string{"VerseLink Telemetry", "Game.log found: C:\\Games\\StarCitizen\\LIVE\\Game.log", "Discovery strategy: known_location", "Restore boundary found: true", "Restore replayed lines: 7", "Resume offset: 42", "Diagnostics:"} {
		if !strings.Contains(got, want) {
			t.Errorf("Run() output missing %q:\n%s", want, got)
		}
	}
	for _, forbidden := range []string{"CrewMate", "SecondMate", "RAW_GAME_LOG_SECRET_SENTINEL", "<SHUDEvent_OnNotification>", "GEID"} {
		if strings.Contains(got, forbidden) {
			t.Errorf("Run() output exposed %q:\n%s", forbidden, got)
		}
	}
	if strings.Contains(got, "<SHUDEvent_OnNotification>") {
		t.Fatalf("Run() output contained raw log content")
	}
}

func TestRunDiscoveryFailures(t *testing.T) {
	for name, test := range map[string]struct {
		result gamelog.LocateResult
		want   runtimeErrorKind
	}{
		"unsupported platform": {gamelog.LocateResult{PlatformUnsupported: true}, runtimeUnsupportedPlatform},
		"not found":             {gamelog.LocateResult{}, runtimeGameLogNotFound},
	} {
		t.Run(name, func(t *testing.T) {
			err := Run(context.Background(), ioDiscard{}, RuntimeConfig{Locator: fakeLocator{result: test.result}})
			if !isRuntimeError(err, test.want) {
				t.Fatalf("Run() error = %v, want %s", err, test.want)
			}
		})
	}
}

func TestRunSessionInitializationFailure(t *testing.T) {
	err := Run(context.Background(), ioDiscard{}, RuntimeConfig{
		Locator: fakeLocator{result: foundResult()},
		NewSession: func(gamelog.SessionConfig) (runtimeSession, gamelog.RestoreInfo, error) {
			return nil, gamelog.RestoreInfo{}, errors.New("test initialization failure")
		},
	})
	if !isRuntimeError(err, runtimeSessionInitialize) {
		t.Fatalf("Run() error = %v, want session initialization failure", err)
	}
}

func TestRunNormalCancellationAndRuntimeFailure(t *testing.T) {
	t.Run("normal cancellation", func(t *testing.T) {
		session := &fakeSession{started: make(chan struct{}), diag: populatedDiagnostics()}
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan error, 1)
		go func() { done <- Run(ctx, ioDiscard{}, testConfig(session)) }()
		<-session.started
		cancel()
		if err := <-done; err != nil {
			t.Fatalf("Run() error = %v", err)
		}
	})
	t.Run("runtime failure", func(t *testing.T) {
		session := &fakeSession{diag: populatedDiagnostics(), runErr: errors.New("test runtime failure")}
		err := Run(context.Background(), ioDiscard{}, testConfig(session))
		if !isRuntimeError(err, runtimeSessionRun) {
			t.Fatalf("Run() error = %v, want runtime failure", err)
		}
	})
}

func TestDiagnosticsEmissionFiltersCounterNoiseAndTracksMeaningfulChanges(t *testing.T) {
	base := populatedDiagnostics()
	previous := diagnosticsState(base)
	var out lockedBuffer

	linesOnly := base
	linesOnly.LinesProcessed++
	if _, emitted := writeDiagnosticsIfChanged(&out, linesOnly, previous); emitted {
		t.Fatal("LinesProcessed-only change emitted diagnostics")
	}
	parserEventsOnly := base
	parserEventsOnly.ParserEventCount++
	if _, emitted := writeDiagnosticsIfChanged(&out, parserEventsOnly, previous); emitted {
		t.Fatal("ParserEventCount-only change emitted diagnostics")
	}
	if got := out.String(); got != "" {
		t.Fatalf("counter-only changes wrote diagnostics:\n%s", got)
	}

	changed := base
	changed.State.Ship = &telemetry.ShipState{Name: "Anvil_Carrack", Owner: "TestOwner"}
	var emitted bool
	previous, emitted = writeDiagnosticsIfChanged(&out, changed, previous)
	if !emitted {
		t.Fatal("ship change did not emit diagnostics")
	}
	if count := strings.Count(out.String(), "Diagnostics:\n"); count != 1 {
		t.Fatalf("diagnostics count = %d, want 1", count)
	}
	if _, emitted := writeDiagnosticsIfChanged(&out, changed, previous); emitted {
		t.Fatal("unchanged state emitted duplicate diagnostics")
	}

	changed.SourceResetCount++
	if _, emitted := writeDiagnosticsIfChanged(&out, changed, previous); !emitted {
		t.Fatal("SourceResetCount change did not emit diagnostics")
	}
}

func testConfig(session runtimeSession) RuntimeConfig {
	return RuntimeConfig{
		Locator: fakeLocator{result: foundResult()},
		NewSession: func(gamelog.SessionConfig) (runtimeSession, gamelog.RestoreInfo, error) {
			return session, gamelog.RestoreInfo{BoundaryFound: true, ReplayedLines: 7, ResumeOffset: 42}, nil
		},
		StatusInterval: time.Hour,
	}
}

func foundResult() gamelog.LocateResult {
	return gamelog.LocateResult{Path: `C:\Games\StarCitizen\LIVE\Game.log`, Strategy: gamelog.StrategyKnownLocation}
}

func populatedDiagnostics() gamelog.SessionDiagnostics {
	return gamelog.SessionDiagnostics{
		LogPath:          `C:\Games\StarCitizen\LIVE\Game.log`,
		LinesProcessed:   15,
		ParserEventCount: 13,
		SourceResetCount: 1,
		State: telemetry.TelemetryState{
			SessionActive: true,
			PlayerHandle:  "TestPilot",
			Shard:         "test_shard",
			Location:      &telemetry.LocationState{Raw: "RR_CRU_L1"},
			Jurisdiction:  "Stanton",
			Ship:          &telemetry.ShipState{Name: "RSI_Hermes", Owner: "TestOwner"},
			Quantum:       &telemetry.QuantumState{Destination: "ARC-L1", State: telemetry.QuantumStateArrived},
			Party:         []string{"CrewMate", "SecondMate"},
		},
	}
}

type ioDiscard struct{}

func (ioDiscard) Write(value []byte) (int, error) { return len(value), nil }

type lockedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (b *lockedBuffer) Write(value []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.Write(value)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.String()
}
