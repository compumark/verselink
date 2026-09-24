package runtimehost

import (
	"context"
	"errors"
	"os"
	"time"

	"github.com/compumark/verselink-telemetry/internal/gamelog"
	"github.com/compumark/verselink-telemetry/internal/settings"
	"github.com/compumark/verselink-telemetry/internal/telemetry"
)

const (
	DefaultStatusInterval = time.Second
	DefaultRetryInterval  = 15 * time.Second
)

type Phase string

const (
	PhaseStarting           Phase = "starting"
	PhaseSearching          Phase = "searching"
	PhaseMonitoring         Phase = "monitoring"
	PhaseSessionActive      Phase = "session_active"
	PhaseGameLogUnavailable Phase = "game_log_unavailable"
	PhaseWarning            Phase = "warning"
	PhaseFatal              Phase = "fatal"
)

type Status struct {
	Phase          Phase
	Message        string
	Path           string
	Strategy       gamelog.DiscoveryStrategy
	Restore        gamelog.RestoreInfo
	HasRestore     bool
	Diagnostics    gamelog.SessionDiagnostics
	HasDiagnostics bool
	Configuration  ConfigurationStatus
}

type ConfigurationStatus struct {
	ConfiguredMode       settings.Mode
	ConfiguredManualPath string
	EffectivePath        string
	EffectiveStrategy    gamelog.DiscoveryStrategy
	Channel              string
	Warning              string
	SettingsLoadWarning  bool
	EnvironmentInvalid   bool
	ManualPathInvalid    bool
}

type Observer interface {
	OnRuntimeStatus(Status)
}

// LiveSnapshotObserver receives bounded, privacy-safe snapshots independently
// of semantic status deduplication. It is intended for local UI presentation.
type LiveSnapshotObserver interface {
	OnLiveSnapshot(Status)
}

type ObserverFunc func(Status)

func (f ObserverFunc) OnRuntimeStatus(status Status) { f(status) }

type Locator interface {
	Locate() gamelog.LocateResult
}

type Session interface {
	Run(context.Context) error
	Diagnostics() gamelog.SessionDiagnostics
}

type SessionFactory func(gamelog.SessionConfig) (Session, gamelog.RestoreInfo, error)

type Config struct {
	Locator          Locator
	NewSession       SessionFactory
	Observer         Observer
	LiveObserver     LiveSnapshotObserver
	PollInterval     time.Duration
	StatusInterval   time.Duration
	RetryInterval    time.Duration
	RetryUnavailable bool
	StatusTicks      <-chan time.Time
	RediscoveryTicks <-chan time.Time
	GameLogSettings  settings.Settings
	SettingsWarning  string
	EnvironmentPath  string
	ValidatePath     func(string) error
}

type ErrorKind string

const (
	ErrorUnsupportedPlatform ErrorKind = "unsupported_platform"
	ErrorGameLogNotFound     ErrorKind = "game_log_not_found"
	ErrorSessionInitialize   ErrorKind = "session_initialize"
	ErrorSessionRun          ErrorKind = "session_run"
)

type Error struct {
	Kind ErrorKind
}

func (e *Error) Error() string {
	switch e.Kind {
	case ErrorUnsupportedPlatform:
		return "Windows Game.log discovery is unsupported on this platform"
	case ErrorGameLogNotFound:
		return "Game.log was not found; start Star Citizen or set VERSELINK_GAME_LOG_PATH to a readable Game.log"
	case ErrorSessionInitialize:
		return "Game.log was found but the telemetry session could not be initialized"
	case ErrorSessionRun:
		return "the live Game.log session stopped unexpectedly"
	default:
		return "telemetry runtime failed"
	}
}

func IsError(err error, kind ErrorKind) bool {
	var runtimeErr *Error
	return errors.As(err, &runtimeErr) && runtimeErr.Kind == kind
}

func Run(ctx context.Context, config Config) error {
	gameLogSettings := config.GameLogSettings
	if gameLogSettings.Version == 0 {
		gameLogSettings = settings.Defaults()
	}
	gameLogSettings, normalizeErr := settings.Normalize(gameLogSettings)
	loadWarning := config.SettingsWarning
	if normalizeErr != nil {
		gameLogSettings = settings.Defaults()
		loadWarning = joinWarnings(loadWarning, normalizeErr.Error())
	}
	validatePath := config.ValidatePath
	if validatePath == nil {
		validatePath = func(path string) error { return gamelog.ValidateGameLogPath(path, nil) }
	}
	environmentPath := config.EnvironmentPath
	if environmentPath == "" {
		environmentPath = os.Getenv("VERSELINK_GAME_LOG_PATH")
	}
	configured := ConfigurationStatus{ConfiguredMode: gameLogSettings.GameLog.Mode, ConfiguredManualPath: gameLogSettings.GameLog.ManualPath, Warning: loadWarning, SettingsLoadWarning: loadWarning != ""}
	locator := config.Locator
	if locator == nil {
		locator = gamelog.NewLocator(gamelog.Config{})
	}
	newSession := config.NewSession
	if newSession == nil {
		newSession = func(sessionConfig gamelog.SessionConfig) (Session, gamelog.RestoreInfo, error) {
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
		statusInterval = DefaultStatusInterval
	}
	retryInterval := config.RetryInterval
	if retryInterval <= 0 {
		retryInterval = DefaultRetryInterval
	}

	emitter := newStatusEmitter(config.Observer)
	emit := func(status Status) {
		emitter.Emit(status)
		publishLiveSnapshot(config.LiveObserver, status)
	}
	emit(Status{Phase: PhaseStarting, Message: "Starting", Configuration: configured})
	emit(Status{Phase: PhaseSearching, Message: "Searching for Game.log", Configuration: configured})

	for {
		result, effectiveConfig := resolveGameLog(locator, environmentPath, gameLogSettings, configured, validatePath)
		if result.PlatformUnsupported {
			emit(Status{Phase: PhaseFatal, Message: "Game.log discovery is unsupported on this platform", Configuration: effectiveConfig})
			return &Error{Kind: ErrorUnsupportedPlatform}
		}
		if !result.Found() {
			emit(Status{Phase: PhaseGameLogUnavailable, Message: "Game.log unavailable", Configuration: effectiveConfig})
			if !config.RetryUnavailable {
				return &Error{Kind: ErrorGameLogNotFound}
			}
			if !waitForRediscovery(ctx, config.RediscoveryTicks, retryInterval) {
				return nil
			}
			continue
		}

		emit(Status{
			Phase:         PhaseMonitoring,
			Message:       "Monitoring Game.log",
			Path:          result.Path,
			Strategy:      result.Strategy,
			Configuration: effectiveConfig,
		})
		session, restore, err := newSession(gamelog.SessionConfig{Path: result.Path, PollInterval: pollInterval})
		if err != nil || session == nil {
			emit(Status{Phase: PhaseFatal, Message: "Telemetry session could not be initialized", Path: result.Path, Strategy: result.Strategy, Configuration: effectiveConfig})
			return &Error{Kind: ErrorSessionInitialize}
		}

		initial := SafeDiagnostics(session.Diagnostics())
		initialStatus := statusForDiagnostics(initial, result, restore, true)
		initialStatus.Configuration = effectiveConfig
		emit(initialStatus)
		return monitorSession(ctx, session, result, restore, statusInterval, config.StatusTicks, emitter, config.LiveObserver, effectiveConfig)
	}
}

func resolveGameLog(locator Locator, environmentPath string, gameLogSettings settings.Settings, configured ConfigurationStatus, validate func(string) error) (gamelog.LocateResult, ConfigurationStatus) {
	resultConfig := configured
	if environmentPath != "" {
		if err := validate(environmentPath); err == nil {
			return gamelog.LocateResult{Path: environmentPath, Strategy: gamelog.StrategyManual}, effectiveConfiguration(resultConfig, environmentPath, gamelog.StrategyManual)
		} else {
			resultConfig.Warning = joinWarnings(resultConfig.Warning, "VERSELINK_GAME_LOG_PATH is invalid; continuing with saved settings or automatic discovery")
			resultConfig.EnvironmentInvalid = true
		}
	}
	if gameLogSettings.GameLog.Mode == settings.ModeManual {
		manualPath := gameLogSettings.GameLog.ManualPath
		if err := validate(manualPath); err == nil {
			return gamelog.LocateResult{Path: manualPath, Strategy: gamelog.StrategyManual}, effectiveConfiguration(resultConfig, manualPath, gamelog.StrategyManual)
		} else {
			resultConfig.Warning = joinWarnings(resultConfig.Warning, "Configured manual Game.log is unavailable or invalid; using automatic discovery. Open Settings to choose another file or switch to automatic discovery.")
			resultConfig.ManualPathInvalid = true
		}
	}
	result := locator.Locate()
	if result.Found() {
		resultConfig = effectiveConfiguration(resultConfig, result.Path, result.Strategy)
	}
	return result, resultConfig
}

func effectiveConfiguration(config ConfigurationStatus, path string, strategy gamelog.DiscoveryStrategy) ConfigurationStatus {
	config.EffectivePath = path
	config.EffectiveStrategy = strategy
	config.Channel = settings.ChannelFromPath(path)
	return config
}

func joinWarnings(first, second string) string {
	if first == "" {
		return second
	}
	if second == "" {
		return first
	}
	if first == second {
		return first
	}
	return first + "; " + second
}

func waitForRediscovery(ctx context.Context, ticks <-chan time.Time, interval time.Duration) bool {
	if ticks != nil {
		select {
		case <-ctx.Done():
			return false
		case _, ok := <-ticks:
			return ok
		}
	}
	timer := time.NewTimer(interval)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func monitorSession(ctx context.Context, session Session, result gamelog.LocateResult, restore gamelog.RestoreInfo, interval time.Duration, ticks <-chan time.Time, emitter *statusEmitter, liveObserver LiveSnapshotObserver, configuration ConfigurationStatus) error {
	runDone := make(chan error, 1)
	go func() { runDone <- session.Run(ctx) }()

	var ticker *time.Ticker
	if ticks == nil {
		ticker = time.NewTicker(interval)
		ticks = ticker.C
		defer ticker.Stop()
	}

	for {
		select {
		case err := <-runDone:
			if ctx.Err() != nil && err == nil {
				return nil
			}
			status := Status{Phase: PhaseFatal, Message: "Live Game.log session stopped unexpectedly", Path: result.Path, Strategy: result.Strategy, Configuration: configuration}
			emitter.Emit(status)
			publishLiveSnapshot(liveObserver, status)
			return &Error{Kind: ErrorSessionRun}
		case <-ctx.Done():
			err := <-runDone
			if err != nil {
				status := Status{Phase: PhaseFatal, Message: "Live Game.log session stopped unexpectedly", Path: result.Path, Strategy: result.Strategy, Configuration: configuration}
				emitter.Emit(status)
				publishLiveSnapshot(liveObserver, status)
				return &Error{Kind: ErrorSessionRun}
			}
			return nil
		case _, ok := <-ticks:
			if !ok {
				ticks = nil
				continue
			}
			diagnostics := SafeDiagnostics(session.Diagnostics())
			status := statusForDiagnostics(diagnostics, result, restore, false)
			status.Configuration = configuration
			publishLiveSnapshot(liveObserver, status)
			emitter.Emit(status)
		}
	}
}

func publishLiveSnapshot(observer LiveSnapshotObserver, status Status) {
	if observer == nil {
		return
	}
	status.Diagnostics = SafeDiagnostics(status.Diagnostics)
	observer.OnLiveSnapshot(status)
}

func statusForDiagnostics(snapshot gamelog.SessionDiagnostics, result gamelog.LocateResult, restore gamelog.RestoreInfo, includeRestore bool) Status {
	phase := PhaseMonitoring
	message := "Monitoring Game.log"
	if snapshot.State.SessionActive {
		phase = PhaseSessionActive
		message = "Session active"
	}
	return Status{
		Phase:          phase,
		Message:        message,
		Path:           result.Path,
		Strategy:       result.Strategy,
		Restore:        restore,
		HasRestore:     includeRestore,
		Diagnostics:    snapshot,
		HasDiagnostics: true,
	}
}

// SafeDiagnostics returns a detached diagnostics snapshot with Party member
// identities removed. The member count is retained for local status displays.
func SafeDiagnostics(snapshot gamelog.SessionDiagnostics) gamelog.SessionDiagnostics {
	result := snapshot
	state := snapshot.State
	if snapshot.State.Location != nil {
		location := *snapshot.State.Location
		state.Location = &location
	}
	if snapshot.State.Ship != nil {
		ship := *snapshot.State.Ship
		state.Ship = &ship
	}
	if snapshot.State.Quantum != nil {
		quantum := *snapshot.State.Quantum
		state.Quantum = &quantum
	}
	if snapshot.State.Party != nil {
		state.Party = make([]string, len(snapshot.State.Party))
	}
	result.State = state
	return result
}

type DiagnosticState struct {
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

func DiagnosticsState(snapshot gamelog.SessionDiagnostics) DiagnosticState {
	state := snapshot.State
	result := DiagnosticState{
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

func copyLocation(result *DiagnosticState, location *telemetry.LocationState) {
	if location != nil {
		result.Location = location.Raw
		result.LocationObserved = location.ObservedAt
	}
}

func copyShip(result *DiagnosticState, ship *telemetry.ShipState) {
	if ship != nil {
		result.ShipName = ship.Name
		result.ShipOwner = ship.Owner
	}
}

func copyQuantum(result *DiagnosticState, quantum *telemetry.QuantumState) {
	if quantum != nil {
		result.QuantumTarget = quantum.Destination
		result.QuantumState = quantum.State
	}
}

type statusKey struct {
	Phase          Phase
	Message        string
	Path           string
	Strategy       gamelog.DiscoveryStrategy
	HasDiagnostics bool
	Diagnostics    DiagnosticState
	Configuration  ConfigurationStatus
}

type statusEmitter struct {
	observer Observer
	last     statusKey
	hasLast  bool
}

func newStatusEmitter(observer Observer) *statusEmitter {
	return &statusEmitter{observer: observer}
}

func (e *statusEmitter) Emit(status Status) bool {
	status.Diagnostics = SafeDiagnostics(status.Diagnostics)
	key := statusKey{
		Phase:          status.Phase,
		Message:        status.Message,
		Path:           status.Path,
		Strategy:       status.Strategy,
		HasDiagnostics: status.HasDiagnostics,
		Configuration:  status.Configuration,
	}
	if status.HasDiagnostics {
		key.Diagnostics = DiagnosticsState(status.Diagnostics)
	}
	if e.hasLast && key == e.last {
		return false
	}
	e.last = key
	e.hasLast = true
	if e.observer != nil {
		e.observer.OnRuntimeStatus(status)
	}
	return true
}
