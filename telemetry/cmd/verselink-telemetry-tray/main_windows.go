//go:build windows

package main

import (
	"context"
	"fmt"
	"os"
	"runtime"

	"github.com/compumark/verselink-telemetry/internal/connection"
	"github.com/compumark/verselink-telemetry/internal/settings"
)

func main() {
	// A Win32 window and its message queue are thread-affine. Keep creation,
	// dispatch, and destruction on this OS thread for the complete tray lifetime.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	if err := runWindowsTray(); err != nil {
		showNativeError(fmt.Sprintf("VerseLink Telemetry could not start:\n\n%v", err))
	}
}

func runWindowsTray() error {
	store := &statusStore{presenceSnapshots: make(chan connection.PresenceSnapshot, 1)}
	settingsPath, pathErr := settings.LocalSettingsPath(os.Getenv("LOCALAPPDATA"))
	settingsStore := settings.Store{Path: settingsPath}
	gameLogSettings := settings.Defaults()
	var settingsWarning string
	if pathErr != nil {
		settingsWarning = "Settings cannot be stored because LOCALAPPDATA is unavailable."
	} else if loaded, err := settingsStore.Load(); err != nil {
		settingsWarning = err.Error()
	} else {
		gameLogSettings = loaded
	}
	tray, err := newWindowsTray(store)
	if err != nil {
		return err
	}
	tray.heartbeatUpdates = make(chan connection.HeartbeatConfig, 1)
	tray.presenceUpdates = make(chan connection.PresenceConfig, 1)
	tray.configureSettings(settingsStore, gameLogSettings, settingsWarning)
	tray.configureConnection(os.Getenv("LOCALAPPDATA"), gameLogSettings)

	ctx, cancel := context.WithCancel(context.Background())
	runtimeDone := make(chan struct{})
	runtimeTaskDone := make(chan struct{})
	heartbeatDone := make(chan struct{})
	presenceDone := make(chan struct{})
	shutdown := newShutdownController(cancel, runtimeDone)
	exitPostDone := make(chan struct{})
	exitRequested := false
	tray.onExit = func() {
		exitRequested = true
		tray.cancelPairing()
		shutdown.Request(func() {
			tray.closeWhenPairingDone()
			close(exitPostDone)
		})
	}
	store.SetWake(tray.postStatusUpdate)
	store.SetLiveWake(tray.postLiveStatusUpdate)

	go func() {
		defer close(runtimeTaskDone)
		_ = runTelemetryWithSettings(ctx, store, store, gameLogSettings, settingsWarning)
	}()
	go func() {
		defer close(heartbeatDone)
		(connection.HeartbeatMonitor{Store: tray.credentialStore}).Run(ctx, tray.heartbeatConfig, tray.heartbeatUpdates, store)
	}()
	go func() {
		defer close(presenceDone)
		(connection.PresenceMonitor{Store: tray.credentialStore}).Run(ctx, tray.presenceConfig, tray.presenceUpdates, store.presenceSnapshots)
	}()
	go func() { <-runtimeTaskDone; <-heartbeatDone; <-presenceDone; close(runtimeDone) }()

	return runTrayLifecycle(trayLifecycle{
		run:         tray.run,
		stopPairing: tray.stopPairingAndDrain,
		cancel:      cancel,
		runtimeDone: runtimeDone,
		waitExit: func() {
			if exitRequested {
				<-exitPostDone
			}
		},
		cleanup: tray.cleanup,
	})
}
