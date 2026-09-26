package main

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/compumark/verselink-telemetry/internal/diagnostics"
	"github.com/compumark/verselink-telemetry/internal/gamelog"
	"github.com/compumark/verselink-telemetry/internal/runtimehost"
	"github.com/compumark/verselink-telemetry/internal/settings"
)

type statusStore struct {
	mu          sync.RWMutex
	status      runtimehost.Status
	wake        func()
	liveStatus  runtimehost.Status
	liveWake    func()
	liveVisible bool
	liveLast    liveTelemetryPresentation
	hasLiveLast bool
}

func (s *statusStore) OnLiveSnapshot(status runtimehost.Status) {
	status.Diagnostics = runtimehost.SafeDiagnostics(status.Diagnostics)
	presentation := presentLiveTelemetry(status)
	s.mu.Lock()
	s.liveStatus = status
	changed := !s.hasLiveLast || s.liveLast != presentation
	s.liveLast, s.hasLiveLast = presentation, true
	wake := s.liveWake
	visible := s.liveVisible
	s.mu.Unlock()
	if changed && visible && wake != nil {
		wake()
	}
}

func (s *statusStore) OnRuntimeStatus(status runtimehost.Status) {
	status.Diagnostics = runtimehost.SafeDiagnostics(status.Diagnostics)
	s.mu.Lock()
	s.status = status
	wake := s.wake
	s.mu.Unlock()
	if wake != nil {
		wake()
	}
}

func (s *statusStore) SetWake(wake func()) {
	s.mu.Lock()
	s.wake = wake
	s.mu.Unlock()
}

func (s *statusStore) SetLiveWake(wake func()) {
	s.mu.Lock()
	s.liveWake = wake
	s.mu.Unlock()
}

func (s *statusStore) SetLiveVisible(visible bool) {
	s.mu.Lock()
	s.liveVisible = visible
	s.mu.Unlock()
}

func (s *statusStore) CurrentLivePresentation() liveTelemetryPresentation {
	s.mu.RLock()
	status := s.liveStatus
	s.mu.RUnlock()
	return presentLiveTelemetry(status)
}

func (s *statusStore) Current() runtimehost.Status {
	s.mu.RLock()
	defer s.mu.RUnlock()
	status := s.status
	status.Diagnostics = runtimehost.SafeDiagnostics(status.Diagnostics)
	return status
}

func statusText(status runtimehost.Status) string {
	if status.Configuration.Warning != "" {
		return "Warning: Game.log configuration"
	}
	if status.Message != "" {
		return status.Message
	}
	if status.Phase == "" {
		return "Starting"
	}
	return string(status.Phase)
}

func diagnosticsText(status runtimehost.Status) string {
	header := fmt.Sprintf("VerseLink Telemetry\n\nStatus: %s\n\n%s", statusText(status), configurationText(status.Configuration))
	if !status.HasDiagnostics {
		if status.Path != "" {
			return fmt.Sprintf("%s\nGame.log: %s", header, status.Path)
		}
		return header + "\n\nSession diagnostics are not available yet."
	}
	return fmt.Sprintf("%s\n\n%s", header, diagnostics.FormatSession(runtimehost.SafeDiagnostics(status.Diagnostics)))
}

type shutdownController struct {
	once   sync.Once
	cancel context.CancelFunc
	done   <-chan struct{}
}

func newShutdownController(cancel context.CancelFunc, done <-chan struct{}) *shutdownController {
	return &shutdownController{cancel: cancel, done: done}
}

// trayLifecycle is the shared post-message-loop shutdown sequence. The
// Windows entry point supplies the native tray operations; tests supply the
// same production orchestration with controlled run and shutdown boundaries.
type trayLifecycle struct {
	run         func() error
	stopPairing func()
	cancel      context.CancelFunc
	runtimeDone <-chan struct{}
	waitExit    func()
	cleanup     func()
}

func runTrayLifecycle(lifecycle trayLifecycle) error {
	err, runPanic, runPanicked := callTrayRun(lifecycle.run)
	var cleanupPanic any
	cleanupPanicked := false
	runCleanup := func(cleanup func()) {
		panicValue, panicked := callTrayCleanup(cleanup)
		if panicked && !cleanupPanicked {
			cleanupPanic, cleanupPanicked = panicValue, true
		}
	}
	runCleanup(lifecycle.stopPairing)
	runCleanup(lifecycle.cancel)
	if lifecycle.runtimeDone != nil {
		runCleanup(func() { <-lifecycle.runtimeDone })
	}
	runCleanup(lifecycle.waitExit)
	runCleanup(lifecycle.cleanup)
	if runPanicked {
		panic(runPanic)
	}
	if err != nil {
		return err
	}
	if cleanupPanicked {
		panic(cleanupPanic)
	}
	return nil
}

func callTrayRun(run func() error) (err error, panicValue any, panicked bool) {
	completed := false
	defer func() {
		if !completed {
			panicValue, panicked = recover(), true
		}
	}()
	if run != nil {
		err = run()
	}
	completed = true
	return err, nil, false
}

func callTrayCleanup(cleanup func()) (panicValue any, panicked bool) {
	if cleanup == nil {
		return nil, false
	}
	completed := false
	defer func() {
		if !completed {
			panicValue, panicked = recover(), true
		}
	}()
	cleanup()
	completed = true
	return nil, false
}

func (s *shutdownController) Request(after func()) {
	s.once.Do(func() {
		s.cancel()
		go func() {
			<-s.done
			if after != nil {
				after()
			}
		}()
	})
}

func runTelemetry(ctx context.Context, observer runtimehost.Observer) error {
	return runtimehost.Run(ctx, runtimehost.Config{
		Observer:         observer,
		RetryUnavailable: true,
	})
}

func runTelemetryWithSettings(ctx context.Context, observer runtimehost.Observer, liveObserver runtimehost.LiveSnapshotObserver, value settings.Settings, warning string) error {
	return runtimehost.Run(ctx, runtimehost.Config{
		Observer:         observer,
		LiveObserver:     liveObserver,
		RetryUnavailable: true,
		GameLogSettings:  value,
		SettingsWarning:  warning,
	})
}

type liveTelemetryPresentation struct {
	status, channel, strategy, path  string
	lines, events, resets            string
	session, player, shard           string
	lastEvent                        string
	location, locationAt, zone       string
	ship, owner                      string
	quantumDestination, quantumState string
	partyCount                       string
}

func presentLiveTelemetry(status runtimehost.Status) liveTelemetryPresentation {
	p := liveTelemetryPresentation{
		status: liveRuntimeStatus(status), channel: "Unknown", strategy: "Unknown", path: "Unknown",
		lines: "Unknown", events: "Unknown", resets: "Unknown", session: "Inactive",
		player: "Unknown", shard: "Unknown", lastEvent: "Unknown", location: "Unknown",
		locationAt: "Unknown", zone: "Unknown", ship: "Unknown", owner: "Unknown",
		quantumDestination: "Unknown", quantumState: "Unknown", partyCount: "Unknown",
	}
	configuration := status.Configuration
	if configuration.Channel != "" {
		p.channel = configuration.Channel
	}
	if configuration.EffectiveStrategy != "" {
		p.strategy = presentDiscoveryStrategy(configuration.EffectiveStrategy)
	} else if status.Strategy != "" {
		p.strategy = presentDiscoveryStrategy(status.Strategy)
	}
	path := configuration.EffectivePath
	if path == "" {
		path = status.Path
	}
	if path != "" {
		p.path = singleLine(path)
	}
	if !status.HasDiagnostics {
		return p
	}
	diagnostics := status.Diagnostics
	state := diagnostics.State
	p.lines = fmt.Sprint(diagnostics.LinesProcessed)
	p.events = fmt.Sprint(diagnostics.ParserEventCount)
	p.resets = fmt.Sprint(diagnostics.SourceResetCount)
	p.partyCount = fmt.Sprint(len(state.Party))
	if state.SessionActive {
		p.session = "Active"
	}
	p.player = valueOrUnknown(state.PlayerHandle)
	p.shard = valueOrUnknown(state.Shard)
	p.lastEvent = formatTime(state.LastEventAt)
	if state.Location != nil {
		p.location = valueOrUnknown(state.Location.Raw)
		p.locationAt = formatTime(state.Location.ObservedAt)
	}
	p.zone = valueOrUnknown(state.Jurisdiction)
	if state.Ship != nil {
		p.ship = valueOrUnknown(state.Ship.Name)
		p.owner = valueOrUnknown(state.Ship.Owner)
	}
	if state.Quantum != nil {
		p.quantumDestination = valueOrUnknown(state.Quantum.Destination)
		p.quantumState = valueOrUnknown(state.Quantum.State)
	}
	return p
}

func liveRuntimeStatus(status runtimehost.Status) string {
	if status.Configuration.Warning != "" {
		return "Warning: Game.log configuration"
	}
	switch status.Phase {
	case runtimehost.PhaseStarting:
		return "Starting"
	case runtimehost.PhaseSearching:
		return "Searching for Game.log"
	case runtimehost.PhaseMonitoring:
		return "Monitoring Game.log"
	case runtimehost.PhaseSessionActive:
		return "Session active"
	case runtimehost.PhaseGameLogUnavailable:
		return "Game.log unavailable"
	case runtimehost.PhaseWarning:
		return "Warning"
	case runtimehost.PhaseFatal:
		return "Fatal error"
	default:
		return "Starting"
	}
}

func presentDiscoveryStrategy(strategy gamelog.DiscoveryStrategy) string {
	switch strategy {
	case gamelog.StrategyLauncherLog:
		return "RSI Launcher log"
	case gamelog.StrategyRunningProcess:
		return "Running Star Citizen"
	case gamelog.StrategyKnownLocation:
		return "Known installation"
	case gamelog.StrategyRegistry:
		return "Registry installation hint"
	case gamelog.StrategyManual:
		return "Manual path"
	default:
		return "Unknown"
	}
}

func valueOrUnknown(value string) string {
	if strings.TrimSpace(value) == "" {
		return "Unknown"
	}
	return singleLine(value)
}

func singleLine(value string) string {
	return strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return ' '
		}
		return r
	}, value)
}

func formatTime(value time.Time) string {
	if value.IsZero() {
		return "Unknown"
	}
	return value.Format(time.RFC3339Nano)
}

func formatLiveTelemetry(p liveTelemetryPresentation) string {
	return strings.Join([]string{
		"VerseLink Telemetry — Live Monitor",
		"Status: " + p.status,
		"Channel: " + p.channel,
		"Discovery strategy: " + p.strategy,
		"Game.log: " + p.path,
		"Lines processed: " + p.lines,
		"Parser events: " + p.events,
		"Source resets: " + p.resets,
		"Session: " + p.session,
		"Player: " + p.player,
		"Shard: " + p.shard,
		"Last event: " + p.lastEvent,
		"Location: " + p.location,
		"Location observed: " + p.locationAt,
		"Jurisdiction: " + p.zone,
		"Ship: " + p.ship,
		"Ship owner: " + p.owner,
		"Quantum destination: " + p.quantumDestination,
		"Quantum state: " + p.quantumState,
		"Party members: " + p.partyCount,
	}, "\n")
}

func configurationText(value runtimehost.ConfigurationStatus) string {
	mode := string(value.ConfiguredMode)
	if mode == "" {
		mode = string(settings.ModeAuto)
	}
	path := value.ConfiguredManualPath
	if path == "" {
		path = "(none)"
	}
	channel := value.Channel
	if channel == "" {
		channel = "unknown"
	}
	effectivePath := value.EffectivePath
	if effectivePath == "" {
		effectivePath = "(not found yet)"
	}
	strategy := value.EffectiveStrategy
	if strategy == "" {
		strategy = "unknown"
	}
	text := fmt.Sprintf("Game.log configuration\nConfigured mode: %s\nConfigured manual path: %s\nEffective Game.log: %s\nEffective strategy: %s\nChannel: %s", mode, path, effectivePath, strategy, channel)
	if value.Warning != "" {
		text += "\nWarning: " + value.Warning
	}
	return text
}

type configurationPresentation struct {
	mode, source, channel, path, warning string
}

type settingsDraft struct {
	mode       settings.Mode
	manualPath string
	connection settings.ConnectionConfig
}

func newSettingsDraft(saved settings.Settings) settingsDraft {
	return settingsDraft{mode: saved.GameLog.Mode, manualPath: saved.GameLog.ManualPath, connection: saved.Connection}
}

func (draft *settingsDraft) setMode(mode settings.Mode) { draft.mode = mode }
func (draft *settingsDraft) setManualPath(path string)  { draft.manualPath = path }
func (draft *settingsDraft) reset(saved settings.Settings) {
	*draft = newSettingsDraft(saved)
}
func (draft settingsDraft) value() settings.Settings {
	value := settings.Defaults()
	value.Connection = draft.connection
	if draft.mode == settings.ModeManual {
		value.GameLog = settings.GameLogConfig{Mode: settings.ModeManual, ManualPath: draft.manualPath}
	}
	return value
}

func presentConfiguration(value settings.Settings, config runtimehost.ConfigurationStatus, loadWarning string) configurationPresentation {
	mode := value.GameLog.Mode
	if mode == "" || mode == settings.ModeAuto {
		mode = "Automatic"
	} else {
		mode = "Manual"
	}
	source := "Not available"
	switch config.EffectiveStrategy {
	case gamelog.StrategyLauncherLog:
		source = "RSI Launcher log"
	case gamelog.StrategyRunningProcess:
		source = "Running Star Citizen"
	case gamelog.StrategyKnownLocation:
		source = "Known installation"
	case gamelog.StrategyRegistry:
		source = "Registry installation hint"
	case gamelog.StrategyManual:
		source = "Manual path"
	}
	channel := config.Channel
	if channel == "" {
		channel = "Unknown"
	}
	path := config.EffectivePath
	if path == "" {
		path = "Not found yet"
	}
	warning := configurationWarning(config, loadWarning)
	return configurationPresentation{mode: string(mode), source: source, channel: channel, path: path, warning: warning}
}

func configurationWarning(config runtimehost.ConfigurationStatus, loadWarning string) string {
	var warnings []string
	if config.SettingsLoadWarning || loadWarning != "" {
		warnings = append(warnings, "Warning: settings could not be loaded; safe defaults are in use.")
	}
	if config.EnvironmentInvalid {
		if config.ConfiguredMode == settings.ModeManual && config.EffectiveStrategy == gamelog.StrategyManual && !config.ManualPathInvalid {
			warnings = append(warnings, "Warning: VERSELINK_GAME_LOG_PATH is invalid. VerseLink is using the saved manual Game.log setting.")
		} else {
			warnings = append(warnings, "Warning: VERSELINK_GAME_LOG_PATH is invalid. VerseLink is continuing with automatic discovery.")
		}
	}
	if config.ManualPathInvalid {
		warnings = append(warnings, "Warning: configured manual Game.log is unavailable. VerseLink is currently using automatic discovery.")
	}
	return strings.Join(warnings, "\n")
}
