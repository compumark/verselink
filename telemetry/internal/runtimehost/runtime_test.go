package runtimehost

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/compumark/verselink-telemetry/internal/diagnostics"
	"github.com/compumark/verselink-telemetry/internal/gamelog"
	"github.com/compumark/verselink-telemetry/internal/telemetry"
)

type scriptedLocator struct {
	mu      sync.Mutex
	results []gamelog.LocateResult
	calls   int
}

func (l *scriptedLocator) Locate() gamelog.LocateResult {
	l.mu.Lock()
	defer l.mu.Unlock()
	index := l.calls
	if index >= len(l.results) {
		index = len(l.results) - 1
	}
	l.calls++
	return l.results[index]
}

type fakeSession struct {
	mu          sync.Mutex
	diagnostics gamelog.SessionDiagnostics
	started     chan struct{}
	runError    error
	startOnce   sync.Once
}

func (s *fakeSession) Run(ctx context.Context) error {
	s.startOnce.Do(func() {
		if s.started != nil {
			close(s.started)
		}
	})
	if s.runError != nil {
		return s.runError
	}
	<-ctx.Done()
	return nil
}

func (s *fakeSession) Diagnostics() gamelog.SessionDiagnostics {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.diagnostics
}

func (s *fakeSession) setDiagnostics(snapshot gamelog.SessionDiagnostics) {
	s.mu.Lock()
	s.diagnostics = snapshot
	s.mu.Unlock()
}

type recordingObserver struct {
	mu       sync.Mutex
	statuses []Status
	updates  chan Status
}

func newRecordingObserver() *recordingObserver {
	return &recordingObserver{updates: make(chan Status, 32)}
}

func (o *recordingObserver) OnRuntimeStatus(status Status) {
	o.mu.Lock()
	o.statuses = append(o.statuses, status)
	o.mu.Unlock()
	o.updates <- status
}

func (o *recordingObserver) snapshot() []Status {
	o.mu.Lock()
	defer o.mu.Unlock()
	return append([]Status(nil), o.statuses...)
}

func TestRunTransitionsFromStartingToActiveSession(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	observer := newRecordingObserver()
	session := &fakeSession{
		started: make(chan struct{}),
		diagnostics: gamelog.SessionDiagnostics{
			LogPath: `C:\Game.log`,
			State:   telemetry.TelemetryState{SessionActive: true},
		},
	}
	done := make(chan error, 1)
	go func() {
		done <- Run(ctx, Config{
			Locator:     &scriptedLocator{results: []gamelog.LocateResult{{Path: `C:\Game.log`, Strategy: gamelog.StrategyManual}}},
			NewSession:  sessionFactory(session, gamelog.RestoreInfo{BoundaryFound: true}),
			Observer:    observer,
			StatusTicks: make(chan time.Time),
		})
	}()

	waitForPhase(t, observer.updates, PhaseSessionActive)
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("Run() error = %v", err)
	}

	phases := phases(observer.snapshot())
	want := []Phase{PhaseStarting, PhaseSearching, PhaseMonitoring, PhaseSessionActive}
	if !containsOrdered(phases, want) {
		t.Fatalf("phases = %v, want ordered %v", phases, want)
	}
}

func TestRunUnavailableRemainsRecoverableAndRediscovers(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	observer := newRecordingObserver()
	rediscovery := make(chan time.Time, 1)
	session := &fakeSession{started: make(chan struct{})}
	locator := &scriptedLocator{results: []gamelog.LocateResult{
		{},
		{Path: `D:\StarCitizen\LIVE\Game.log`, Strategy: gamelog.StrategyKnownLocation},
	}}
	done := make(chan error, 1)
	go func() {
		done <- Run(ctx, Config{
			Locator:          locator,
			NewSession:       sessionFactory(session, gamelog.RestoreInfo{}),
			Observer:         observer,
			RetryUnavailable: true,
			RediscoveryTicks: rediscovery,
			StatusTicks:      make(chan time.Time),
		})
	}()

	waitForPhase(t, observer.updates, PhaseGameLogUnavailable)
	rediscovery <- time.Now()
	waitForPhase(t, observer.updates, PhaseMonitoring)
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if locator.calls != 2 {
		t.Fatalf("Locate calls = %d, want 2", locator.calls)
	}
}

func TestRunSurfacesFatalInitializationAndSessionErrors(t *testing.T) {
	result := gamelog.LocateResult{Path: `C:\Game.log`, Strategy: gamelog.StrategyManual}
	t.Run("initialization", func(t *testing.T) {
		observer := newRecordingObserver()
		err := Run(context.Background(), Config{
			Locator: &scriptedLocator{results: []gamelog.LocateResult{result}},
			NewSession: func(gamelog.SessionConfig) (Session, gamelog.RestoreInfo, error) {
				return nil, gamelog.RestoreInfo{}, errors.New("sentinel")
			},
			Observer: observer,
		})
		if !IsError(err, ErrorSessionInitialize) {
			t.Fatalf("Run() error = %v, want session initialization error", err)
		}
		assertLastPhase(t, observer.snapshot(), PhaseFatal)
	})

	t.Run("session run", func(t *testing.T) {
		observer := newRecordingObserver()
		err := Run(context.Background(), Config{
			Locator:     &scriptedLocator{results: []gamelog.LocateResult{result}},
			NewSession:  sessionFactory(&fakeSession{runError: errors.New("sentinel")}, gamelog.RestoreInfo{}),
			Observer:    observer,
			StatusTicks: make(chan time.Time),
		})
		if !IsError(err, ErrorSessionRun) {
			t.Fatalf("Run() error = %v, want session run error", err)
		}
		assertLastPhase(t, observer.snapshot(), PhaseFatal)
	})
}

func TestRunCancellationStopsSession(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	observer := newRecordingObserver()
	session := &fakeSession{started: make(chan struct{})}
	done := make(chan error, 1)
	go func() {
		done <- Run(ctx, Config{
			Locator:     &scriptedLocator{results: []gamelog.LocateResult{{Path: `C:\Game.log`, Strategy: gamelog.StrategyManual}}},
			NewSession:  sessionFactory(session, gamelog.RestoreInfo{}),
			Observer:    observer,
			StatusTicks: make(chan time.Time),
		})
	}()
	<-session.started
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("Run() error = %v", err)
	}
}

func TestStatusEmitterSuppressesCounterNoiseButEmitsSourceReset(t *testing.T) {
	observer := newRecordingObserver()
	emitter := newStatusEmitter(observer)
	base := gamelog.SessionDiagnostics{
		LinesProcessed:   10,
		ParserEventCount: 2,
		State: telemetry.TelemetryState{
			SessionActive: true,
			LastEventAt:   time.Date(2026, 9, 22, 12, 0, 0, 0, time.UTC),
		},
	}
	status := Status{Phase: PhaseSessionActive, Message: "Session active", HasDiagnostics: true, Diagnostics: base}
	if !emitter.Emit(status) {
		t.Fatal("first status was suppressed")
	}
	if emitter.Emit(status) {
		t.Fatal("unchanged status was emitted")
	}
	status.Diagnostics.LinesProcessed++
	if emitter.Emit(status) {
		t.Fatal("LinesProcessed-only status was emitted")
	}
	status.Diagnostics.ParserEventCount++
	if emitter.Emit(status) {
		t.Fatal("ParserEventCount-only status was emitted")
	}
	status.Diagnostics.State.LastEventAt = time.Date(2026, 9, 22, 12, 0, 1, 0, time.UTC)
	if emitter.Emit(status) {
		t.Fatal("LastEventAt-only status was emitted")
	}
	status.Diagnostics.SourceResetCount++
	if !emitter.Emit(status) {
		t.Fatal("SourceResetCount change was suppressed")
	}
	if got := len(observer.snapshot()); got != 2 {
		t.Fatalf("observer updates = %d, want 2", got)
	}
}

func TestStatusEmitterIgnoresOneTimeRestoreMetadataAfterInitialDelivery(t *testing.T) {
	observer := newRecordingObserver()
	emitter := newStatusEmitter(observer)
	status := Status{
		Phase:          PhaseSessionActive,
		Message:        "Session active",
		HasRestore:     true,
		Restore:        gamelog.RestoreInfo{BoundaryFound: true, ReplayedLines: 12, ResumeOffset: 42},
		HasDiagnostics: true,
		Diagnostics:    gamelog.SessionDiagnostics{State: telemetry.TelemetryState{SessionActive: true}},
	}
	if !emitter.Emit(status) {
		t.Fatal("initial restore status was suppressed")
	}
	status.HasRestore = false
	status.Restore = gamelog.RestoreInfo{}
	if emitter.Emit(status) {
		t.Fatal("unchanged status was emitted only because restore metadata was one-time")
	}
	if got := len(observer.snapshot()); got != 1 {
		t.Fatalf("observer updates = %d, want 1", got)
	}
}

func TestStatusDiagnosticsArePrivacySafe(t *testing.T) {
	observer := newRecordingObserver()
	emitter := newStatusEmitter(observer)
	snapshot := gamelog.SessionDiagnostics{
		LogPath: `C:\Game.log`,
		State: telemetry.TelemetryState{
			SessionActive: true,
			PlayerHandle:  "TestPilot",
			Party: []string{
				"CrewMate",
				"SecondMate",
				"GEID_SECRET_SENTINEL",
				"RAW_GAME_LOG_SECRET_SENTINEL",
			},
		},
	}
	emitter.Emit(Status{Phase: PhaseSessionActive, HasDiagnostics: true, Diagnostics: snapshot})
	received := observer.snapshot()[0].Diagnostics
	if len(received.State.Party) != 4 {
		t.Fatalf("Party count = %d, want 4", len(received.State.Party))
	}
	formatted := diagnostics.FormatSession(received)
	for _, forbidden := range []string{"CrewMate", "SecondMate", "GEID_SECRET_SENTINEL", "RAW_GAME_LOG_SECRET_SENTINEL", "map["} {
		if strings.Contains(formatted, forbidden) {
			t.Fatalf("privacy-safe diagnostics contain %q", forbidden)
		}
	}
	if !strings.Contains(formatted, "Party members: 4") {
		t.Fatalf("formatted diagnostics = %q, want Party count", formatted)
	}
}

func sessionFactory(session Session, restore gamelog.RestoreInfo) SessionFactory {
	return func(gamelog.SessionConfig) (Session, gamelog.RestoreInfo, error) {
		return session, restore, nil
	}
}

func waitForPhase(t *testing.T, updates <-chan Status, want Phase) Status {
	t.Helper()
	for {
		select {
		case status := <-updates:
			if status.Phase == want {
				return status
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("timed out waiting for phase %s", want)
		}
	}
}

func phases(statuses []Status) []Phase {
	result := make([]Phase, 0, len(statuses))
	for _, status := range statuses {
		result = append(result, status.Phase)
	}
	return result
}

func containsOrdered(got, want []Phase) bool {
	index := 0
	for _, phase := range got {
		if index < len(want) && phase == want[index] {
			index++
		}
	}
	return index == len(want)
}

func assertLastPhase(t *testing.T, statuses []Status, want Phase) {
	t.Helper()
	if len(statuses) == 0 || statuses[len(statuses)-1].Phase != want {
		t.Fatalf("last status = %v, want %s", statuses, want)
	}
}
