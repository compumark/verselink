package main

import (
	"context"
	"fmt"
	"strings"
	"sync"

	"github.com/compumark/verselink-telemetry/internal/diagnostics"
	"github.com/compumark/verselink-telemetry/internal/gamelog"
	"github.com/compumark/verselink-telemetry/internal/runtimehost"
	"github.com/compumark/verselink-telemetry/internal/settings"
)

type statusStore struct {
	mu     sync.RWMutex
	status runtimehost.Status
	wake   func()
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

func runTelemetryWithSettings(ctx context.Context, observer runtimehost.Observer, value settings.Settings, warning string) error {
	return runtimehost.Run(ctx, runtimehost.Config{
		Observer:         observer,
		RetryUnavailable: true,
		GameLogSettings:  value,
		SettingsWarning:  warning,
	})
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
}

func newSettingsDraft(saved settings.Settings) settingsDraft {
	return settingsDraft{mode: saved.GameLog.Mode, manualPath: saved.GameLog.ManualPath}
}

func (draft *settingsDraft) setMode(mode settings.Mode) { draft.mode = mode }
func (draft *settingsDraft) setManualPath(path string)  { draft.manualPath = path }
func (draft *settingsDraft) reset(saved settings.Settings) {
	*draft = newSettingsDraft(saved)
}
func (draft settingsDraft) value() settings.Settings {
	value := settings.Defaults()
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
