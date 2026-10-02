package main

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/compumark/verselink-telemetry/internal/connection"
	"github.com/compumark/verselink-telemetry/internal/diagnostics"
	"github.com/compumark/verselink-telemetry/internal/gamelog"
	"github.com/compumark/verselink-telemetry/internal/runtimehost"
	"github.com/compumark/verselink-telemetry/internal/settings"
	"github.com/compumark/verselink-telemetry/internal/telemetry"
	"github.com/compumark/verselink-telemetry/internal/updatecheck"
)

func TestUpdateIndicatorTransitionsAndNotifiesOnlyOnce(t *testing.T) {
	var indicator updateIndicator
	if indicator.apply(updatecheck.Result{InstalledVersion: "v1.2.3", AvailableVersion: "v1.2.3"}) || indicator.available() {
		t.Fatal("current version activated update indicator")
	}
	if indicator.apply(updatecheck.Result{InstalledVersion: "dev", AvailableVersion: "v9.0.0"}) || indicator.available() {
		t.Fatal("invalid installed metadata activated update indicator")
	}
	result := updatecheck.Result{InstalledVersion: "v1.9.9", AvailableVersion: "v1.10.0"}
	if !indicator.apply(result) || !indicator.available() {
		t.Fatal("newer version did not activate update indicator")
	}
	if got := indicator.tooltip(); !strings.Contains(got, "Update available: v1.10.0") {
		t.Fatalf("update tooltip=%q", got)
	}
	text := indicator.notificationText()
	if !strings.Contains(text, "v1.9.9") || !strings.Contains(text, "v1.10.0") {
		t.Fatalf("notification does not contain both versions: %q", text)
	}
	if indicator.apply(result) {
		t.Fatal("duplicate update result triggered a second notification")
	}
}

func TestReleasePageURLIsFixed(t *testing.T) {
	if releasePageURL != "https://github.com/compumark/verselink/releases" {
		t.Fatalf("releasePageURL=%q", releasePageURL)
	}
}

func TestStatusStoreKeepsOnlyPrivacySafePartyCount(t *testing.T) {
	store := &statusStore{}
	store.OnRuntimeStatus(runtimehost.Status{
		Phase:          runtimehost.PhaseSessionActive,
		Message:        "Session active",
		HasDiagnostics: true,
		Diagnostics: gamelog.SessionDiagnostics{
			State: telemetry.TelemetryState{
				SessionActive: true,
				Party: []string{
					"CrewMate",
					"SecondMate",
					"GEID_SECRET_SENTINEL",
					"RAW_GAME_LOG_SECRET_SENTINEL",
				},
			},
		},
	})

	text := diagnosticsText(store.Current())
	for _, expected := range []string{"Version: ", "Commit: ", "Platform: ", "Go: "} {
		if !strings.Contains(text, expected) {
			t.Errorf("diagnostics missing build information %q", expected)
		}
	}
	if !strings.Contains(text, "Party members: 4") {
		t.Fatalf("diagnostics = %q, want Party count", text)
	}
	for _, forbidden := range []string{"CrewMate", "SecondMate", "GEID_SECRET_SENTINEL", "RAW_GAME_LOG_SECRET_SENTINEL", "map["} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("diagnostics contain forbidden value %q", forbidden)
		}
	}
}

func TestStatusStoreRecordsOnlyFixedApplicationLogCategories(t *testing.T) {
	store := &statusStore{}
	store.OnRuntimeStatus(runtimehost.Status{
		Phase: runtimehost.PhaseWarning, Message: "PRIVATE_ERROR_SENTINEL",
		Path:          `C:\Users\PrivatePilot\Game.log`,
		Configuration: runtimehost.ConfigurationStatus{Warning: "PRIVATE_WARNING_SENTINEL"},
	})
	store.RecordLifecycle("autostart_error")
	store.RecordLifecycle("C:\\Private\\Game.log SECRET_SENTINEL")
	entries := store.ApplicationLogs()
	if len(entries) != 2 {
		t.Fatalf("application log entries=%d, want 2", len(entries))
	}
	if entries[0].Severity != diagnostics.SeverityWarning || entries[0].EventCode != diagnostics.LogRuntimeWarning {
		t.Fatalf("runtime log entry=%#v", entries[0])
	}
	if entries[1].Severity != diagnostics.SeverityError || entries[1].EventCode != diagnostics.LogAutostartError {
		t.Fatalf("lifecycle log entry=%#v", entries[1])
	}
	for _, entry := range entries {
		if strings.Contains(string(entry.EventCode), "PRIVATE") || strings.Contains(string(entry.EventCode), "Game.log") {
			t.Fatalf("untrusted value reached application log: %#v", entry)
		}
	}
}

func TestUnexpectedTrayExitCancelsAndDrainsPairingWithoutUIPost(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	gate := &pairingPostGate{}
	done := make(chan struct{})
	results := make(chan []byte, 1)
	posted := false
	credential := []byte("vlt_test-secret-buffer")

	go func() {
		defer close(done)
		<-ctx.Done()
		results <- credential
		gate.postIfActive(func() { posted = true })
	}()

	gate.stop() // run() has returned; no further window-message posts are allowed.
	stopPairingWorker(cancel, done, func() {
		select {
		case secret := <-results:
			clear(secret)
		default:
		}
	})
	if posted {
		t.Fatal("pairing worker posted into UI processing after tray shutdown")
	}
	if !allBytesZero(credential) {
		t.Fatal("drained pairing credential was not cleared")
	}
}

func allBytesZero(value []byte) bool {
	for _, b := range value {
		if b != 0 {
			return false
		}
	}
	return true
}

func TestDiagnosticsExposeConfigurationAndFallbackWarning(t *testing.T) {
	status := runtimehost.Status{
		Phase:   runtimehost.PhaseSessionActive,
		Message: "Session active",
		Configuration: runtimehost.ConfigurationStatus{
			ConfiguredMode:       settings.ModeManual,
			ConfiguredManualPath: `D:\Missing\Game.log`,
			EffectivePath:        `O:\Roberts Space Industries\StarCitizen\LIVE\Game.log`,
			EffectiveStrategy:    gamelog.StrategyKnownLocation,
			Channel:              "LIVE",
			Warning:              "Configured manual Game.log is unavailable or invalid; using automatic discovery",
		},
	}
	formatted := diagnosticsText(status)
	for _, expected := range []string{"Configured mode: manual", `D:\Missing\Game.log`, `O:\Roberts Space Industries\StarCitizen\LIVE\Game.log`, "known_location", "Channel: LIVE", "using automatic discovery"} {
		if !strings.Contains(formatted, expected) {
			t.Errorf("diagnostics = %q, missing %q", formatted, expected)
		}
	}
	if got := statusText(status); !strings.Contains(got, "Warning:") {
		t.Fatalf("tray status text = %q, want visible warning", got)
	}
}

func TestSettingsDraftCancelDiscardsUnsavedChanges(t *testing.T) {
	saved := settings.Settings{Version: settings.CurrentVersion, GameLog: settings.GameLogConfig{Mode: settings.ModeManual, ManualPath: `O:\SC\LIVE\Game.log`}}
	draft := newSettingsDraft(saved)
	draft.setMode(settings.ModeAuto)
	draft.setManualPath(`D:\Other\PTU\Game.log`)
	if got := draft.value(); got.GameLog.Mode != settings.ModeAuto {
		t.Fatalf("draft value before cancel = %#v, want automatic", got)
	}
	draft.reset(saved)
	if got := draft.value(); got != saved {
		t.Fatalf("draft after cancel = %#v, want saved value %#v", got, saved)
	}
}

func TestSettingsDraftSaveUsesSelectedModeAndPath(t *testing.T) {
	draft := newSettingsDraft(settings.Defaults())
	draft.setMode(settings.ModeManual)
	draft.setManualPath(`O:\StarCitizen\LIVE\Game.log`)
	want := settings.Settings{Version: settings.CurrentVersion, GameLog: settings.GameLogConfig{Mode: settings.ModeManual, ManualPath: `O:\StarCitizen\LIVE\Game.log`}}
	if got := draft.value(); got != want {
		t.Fatalf("draft value = %#v, want %#v", got, want)
	}
	draft.setMode(settings.ModeAuto)
	if got := draft.value(); got.GameLog.Mode != settings.ModeAuto || got.GameLog.ManualPath != "" {
		t.Fatalf("automatic draft = %#v, want automatic mode with no manual path", got)
	}
}

func TestCurrentConfigurationPresentationIsReadableAndPrivacySafe(t *testing.T) {
	value := settings.Settings{Version: 1, GameLog: settings.GameLogConfig{Mode: settings.ModeManual, ManualPath: `D:\Missing\Game.log`}}
	config := runtimehost.ConfigurationStatus{
		ConfiguredMode:       settings.ModeManual,
		ConfiguredManualPath: value.GameLog.ManualPath,
		EffectivePath:        `O:\Roberts Space Industries\StarCitizen\LIVE\Game.log`,
		EffectiveStrategy:    gamelog.StrategyLauncherLog,
		Channel:              "LIVE",
		Warning:              "internal warning with RAW_GAME_LOG_SECRET_SENTINEL",
		ManualPathInvalid:    true,
	}
	got := presentConfiguration(value, config, "")
	if got.mode != "Manual" || got.source != "RSI Launcher log" || got.channel != "LIVE" || got.path != config.EffectivePath {
		t.Fatalf("configuration presentation = %#v", got)
	}
	if !strings.Contains(got.warning, "manual Game.log is unavailable") || !strings.Contains(got.warning, "automatic discovery") {
		t.Fatalf("warning = %q", got.warning)
	}
	if strings.Contains(got.warning, "RAW_GAME_LOG_SECRET_SENTINEL") || strings.Contains(got.warning, "internal warning") {
		t.Fatalf("warning exposed internal detail: %q", got.warning)
	}
	automatic := presentConfiguration(settings.Defaults(), runtimehost.ConfigurationStatus{}, "")
	if automatic.mode != "Automatic" || automatic.warning != "" {
		t.Fatalf("automatic configuration presentation = %#v", automatic)
	}
}

func TestConfigurationWarningDescribesActualFallback(t *testing.T) {
	t.Run("invalid environment uses saved manual setting", func(t *testing.T) {
		got := configurationWarning(runtimehost.ConfigurationStatus{
			ConfiguredMode:     settings.ModeManual,
			EffectiveStrategy:  gamelog.StrategyManual,
			EnvironmentInvalid: true,
		}, "")
		if !strings.Contains(got, "saved manual Game.log setting") || strings.Contains(got, "automatic discovery") || strings.Contains(got, "manual Game.log is unavailable") {
			t.Fatalf("configuration warning = %q", got)
		}
	})

	t.Run("invalid environment uses automatic discovery", func(t *testing.T) {
		got := configurationWarning(runtimehost.ConfigurationStatus{EnvironmentInvalid: true}, "")
		if !strings.Contains(got, "automatic discovery") || strings.Contains(got, "settings could not be loaded") {
			t.Fatalf("configuration warning = %q", got)
		}
	})

	t.Run("invalid manual setting uses automatic discovery", func(t *testing.T) {
		got := configurationWarning(runtimehost.ConfigurationStatus{ConfiguredMode: settings.ModeManual, ManualPathInvalid: true}, "")
		if !strings.Contains(got, "manual Game.log is unavailable") || !strings.Contains(got, "automatic discovery") {
			t.Fatalf("configuration warning = %q", got)
		}
	})
}

func TestShutdownControllerCancelsAndWaitsBeforeClosing(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	runtimeDone := make(chan struct{})
	closed := make(chan struct{})
	controller := newShutdownController(cancel, runtimeDone, nil, nil, nil, time.Second)

	controller.Request(func() { close(closed) })
	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("Exit did not cancel the runtime")
	}
	select {
	case <-closed:
		t.Fatal("tray closed before runtime stopped")
	default:
	}
	close(runtimeDone)
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("tray did not close after runtime stopped")
	}
	if err := controller.Wait(); err != nil {
		t.Fatalf("shutdown wait error = %v", err)
	}
}

func TestShutdownControllerUsesOneBudgetAndDoesNotReleaseOnTimeout(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	workersDone := make(chan struct{})
	var events []string
	cleaned := false
	controller := newShutdownController(cancel, workersDone, func() {}, func(event string) { events = append(events, event) }, func() {}, 10*time.Millisecond)
	err := runTrayLifecycle(trayLifecycle{run: func() error { return nil }, shutdown: controller, cleanup: func() { cleaned = true }})
	if err != errApplicationShutdownTimeout {
		t.Fatalf("shutdown error = %v, want timeout", err)
	}
	if cleaned {
		t.Fatal("cleanup released resources while workers were still running")
	}
	select {
	case <-ctx.Done():
	default:
		t.Fatal("timeout path did not cancel workers")
	}
	if len(events) != 2 || events[0] != "shutdown_started" || events[1] != "shutdown_timeout" {
		t.Fatalf("lifecycle events = %v", events)
	}
}

func TestShutdownControllerRequestIsIdempotent(t *testing.T) {
	_, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	started, exits := 0, 0
	controller := newShutdownController(cancel, done, func() { started++ }, nil, nil, time.Second)
	controller.Request(func() { exits++ })
	controller.Request(func() { exits += 100 })
	close(done)
	if err := controller.Wait(); err != nil {
		t.Fatal(err)
	}
	if started != 1 || exits != 1 {
		t.Fatalf("shutdown calls: started=%d exit=%d", started, exits)
	}
}

func TestWindowsSessionEndOnlyStartsShutdownWhenConfirmed(t *testing.T) {
	shutdowns := 0
	callback := func() { shutdowns++ }
	if result := respondToSessionQuery(); result != 1 || shutdowns != 0 {
		t.Fatalf("query response=%d shutdowns=%d; query must be affirmative without starting shutdown", result, shutdowns)
	}
	handleSessionEnd(false, callback)
	if shutdowns != 0 {
		t.Fatal("aborted Windows session end started shutdown")
	}
	handleSessionEnd(true, callback)
	if shutdowns != 1 {
		t.Fatalf("confirmed session end shutdown calls=%d, want 1", shutdowns)
	}
}

func TestStatusStoreWakeIsCalled(t *testing.T) {
	store := &statusStore{}
	woke := make(chan struct{}, 1)
	store.SetWake(func() { woke <- struct{}{} })
	store.OnRuntimeStatus(runtimehost.Status{Phase: runtimehost.PhaseSearching})
	select {
	case <-woke:
	case <-time.After(time.Second):
		t.Fatal("status update did not wake native tray")
	}
}

func TestLiveTelemetryPresentationIncludesCurrentStructuredState(t *testing.T) {
	status := runtimehost.Status{
		Phase: runtimehost.PhaseSessionActive, Message: "Session active", Path: `O:\SC\LIVE\Game.log`,
		Strategy: gamelog.StrategyManual, HasDiagnostics: true,
		Configuration: runtimehost.ConfigurationStatus{EffectivePath: `O:\SC\LIVE\Game.log`, Channel: "LIVE", EffectiveStrategy: gamelog.StrategyManual},
		Diagnostics: gamelog.SessionDiagnostics{LinesProcessed: 125, ParserEventCount: 8, SourceResetCount: 1, State: telemetry.TelemetryState{
			SessionActive: true, PlayerHandle: "PilotOne", Shard: "pu-test-01",
			LastEventAt:  time.Date(2026, 9, 24, 10, 11, 12, 123456789, time.UTC),
			Location:     &telemetry.LocationState{Raw: "Area 18", ObservedAt: time.Date(2026, 9, 24, 10, 10, 0, 0, time.UTC)},
			Jurisdiction: "ArcCorp", Ship: &telemetry.ShipState{Name: "Anvil_Carrack", Owner: "PilotOne"},
			Quantum: &telemetry.QuantumState{Destination: "Baijini Point", State: "traveling"}, Party: []string{"PrivatePartyMember"},
		}},
	}
	p := presentLiveTelemetry(status)
	want := strings.Join([]string{
		"VerseLink Telemetry — Live Monitor",
		"Status: Session active",
		"Channel: LIVE",
		"Discovery strategy: Manual path",
		`Game.log: O:\SC\LIVE\Game.log`,
		"Lines processed: 125",
		"Parser events: 8",
		"Source resets: 1",
		"Session: Active",
		"Player: PilotOne",
		"Shard: pu-test-01",
		"Last event: 2026-09-24T10:11:12.123456789Z",
		"Location: Area 18",
		"Location observed: 2026-09-24T10:10:00Z",
		"Jurisdiction: ArcCorp",
		"Ship: Anvil_Carrack",
		"Ship owner: PilotOne",
		"Quantum destination: Baijini Point",
		"Quantum state: traveling",
		"Party members: 1",
		"Connection: Not connected",
	}, "\n")
	if got := formatLiveTelemetry(p); got != want {
		t.Errorf("live text mismatch\n got: %q\nwant: %q", got, want)
	}
	formatted := formatLiveTelemetry(p)
	for _, forbidden := range []string{"PrivatePartyMember", "GEID_SECRET_SENTINEL", "RAW_GAME_LOG_SECRET_SENTINEL", "AUTH_TOKEN_SECRET_SENTINEL", "map["} {
		if strings.Contains(formatted, forbidden) {
			t.Errorf("live text contains forbidden %q", forbidden)
		}
	}
}

func TestLiveTelemetryPresentationUsesUnknownForUnavailableValues(t *testing.T) {
	p := presentLiveTelemetry(runtimehost.Status{Phase: runtimehost.PhaseSearching, Message: "Searching for Game.log"})
	if p.status != "Searching for Game.log" || p.channel != "Unknown" || p.path != "Unknown" || p.lines != "Unknown" || p.player != "Unknown" || p.shard != "Unknown" || p.lastEvent != "Unknown" || p.locationAt != "Unknown" || p.partyCount != "Unknown" {
		t.Fatalf("startup presentation = %#v", p)
	}
	status := runtimehost.Status{Phase: runtimehost.PhaseMonitoring, Message: "RAW_GAME_LOG_SECRET_SENTINEL GEID_SECRET_SENTINEL AUTH_TOKEN_SECRET_SENTINEL", HasDiagnostics: true}
	p = presentLiveTelemetry(status)
	if p.status != "Monitoring Game.log" || p.lastEvent != "Unknown" || p.locationAt != "Unknown" || p.ship != "Unknown" || p.quantumDestination != "Unknown" || p.partyCount != "0" || p.lines != "0" {
		t.Fatalf("empty diagnostics presentation = %#v", p)
	}
	formatted := formatLiveTelemetry(p)
	for _, forbidden := range []string{"RAW_GAME_LOG_SECRET_SENTINEL", "GEID_SECRET_SENTINEL", "AUTH_TOKEN_SECRET_SENTINEL"} {
		if strings.Contains(formatted, forbidden) {
			t.Errorf("live text exposed untrusted runtime message %q", forbidden)
		}
	}
}

func TestConnectionHealthIsObservableInExistingLocalSurfaces(t *testing.T) {
	store := &statusStore{}
	lastSuccess := time.Date(2026, 9, 27, 10, 11, 12, 0, time.UTC)
	store.OnConnectionHealth(connection.HealthStatus{State: connection.HealthTemporarilyOffline, DeviceID: "device-id", LastSuccess: lastSuccess, Error: "server_unavailable"})
	if got := store.CurrentHealth(); got.State != connection.HealthTemporarilyOffline || got.DeviceID != "device-id" || !got.LastSuccess.Equal(lastSuccess) {
		t.Fatalf("connection health = %#v", got)
	}
	presentation := store.CurrentLivePresentation()
	if !strings.Contains(presentation.connection, "Temporarily offline") || !strings.Contains(presentation.connection, lastSuccess.Format(time.RFC3339)) || !strings.Contains(presentation.connection, "server_unavailable") {
		t.Fatalf("connection presentation = %q", presentation.connection)
	}
}

func TestLiveSnapshotWakeTracksPresentationOnlyWhileVisible(t *testing.T) {
	store := &statusStore{}
	store.SetLiveVisible(true)
	wakes := 0
	store.SetLiveWake(func() { wakes++ })
	status := runtimehost.Status{Phase: runtimehost.PhaseMonitoring, Message: "Monitoring Game.log", HasDiagnostics: true, Diagnostics: gamelog.SessionDiagnostics{LinesProcessed: 1}}
	store.OnLiveSnapshot(status)
	store.OnLiveSnapshot(status)
	if wakes != 1 {
		t.Fatalf("wake count after duplicate snapshots = %d, want 1", wakes)
	}
	status.Diagnostics.LinesProcessed++
	store.OnLiveSnapshot(status)
	if wakes != 2 {
		t.Fatalf("wake count after visible counter update = %d, want 2", wakes)
	}
	store.SetLiveVisible(false)
	status.Diagnostics.LinesProcessed++
	store.OnLiveSnapshot(status)
	if wakes != 2 {
		t.Fatalf("hidden monitor caused wake, count = %d", wakes)
	}
}

func TestLiveSnapshotPublishesLatestPresenceWithoutPartyIdentities(t *testing.T) {
	snapshots := make(chan connection.PresenceSnapshot, 1)
	store := &statusStore{presenceSnapshots: snapshots}
	store.OnLiveSnapshot(runtimehost.Status{HasDiagnostics: true, Diagnostics: gamelog.SessionDiagnostics{State: telemetry.TelemetryState{
		SessionActive: true, PlayerHandle: "PRIVATE_HANDLE", Party: []string{"CrewMate", "SecondMate"},
	}}})
	first := <-snapshots
	if !first.Available || !first.State.SessionActive || len(first.State.Party) != 2 {
		t.Fatalf("presence snapshot lost current fields: %#v", first)
	}
	for _, name := range first.State.Party {
		if name != "" {
			t.Fatalf("Party identity passed to uploader: %q", name)
		}
	}
	store.OnLiveSnapshot(runtimehost.Status{HasDiagnostics: false})
	latest := <-snapshots
	if latest.Available || latest.State.PlayerHandle != "" {
		t.Fatalf("latest snapshot was not detached: %#v", latest)
	}
}
