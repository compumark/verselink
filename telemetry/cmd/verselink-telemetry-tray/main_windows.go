//go:build windows

package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"runtime"
	"sync"

	"github.com/compumark/verselink-telemetry/internal/connection"
	"github.com/compumark/verselink-telemetry/internal/diagnosticsexport"
	"github.com/compumark/verselink-telemetry/internal/locationcatalog"
	"github.com/compumark/verselink-telemetry/internal/settings"
	"github.com/compumark/verselink-telemetry/internal/updatecheck"
)

var errAlreadyRunning = errors.New("VerseLink Telemetry is already running")

func main() {
	// The native tray message queue and the owned mutex must stay on this thread.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	autostart, err := parseLaunchArguments(os.Args[1:])
	if err != nil {
		showNativeError("VerseLink Telemetry could not start:\n\n" + err.Error())
		return
	}
	if err := runWindowsTray(autostart); err != nil {
		if errors.Is(err, errAlreadyRunning) {
			emitLifecycleDebug("duplicate_start")
			if !autostart {
				showNativeMessage("VerseLink Telemetry", "VerseLink Telemetry is already running", mbOK|mbIconInfo)
			}
			return
		}
		showNativeError(fmt.Sprintf("VerseLink Telemetry could not start:\n\n%v", err))
	}
}

func runWindowsTray(autostart bool) error {
	releaseMutex, alreadyRunning, err := acquireApplicationMutex()
	if err != nil {
		emitLifecycleDebug("single_instance_error")
		return err
	}
	if alreadyRunning {
		return errAlreadyRunning
	}
	mutexReleased := false
	defer func() {
		if !mutexReleased {
			releaseMutex()
		}
	}()

	currentExe, err := currentExecutablePath()
	if err != nil {
		emitLifecycleDebug("executable_path_error")
		return err
	}
	store := &statusStore{presenceSnapshots: make(chan connection.PresenceSnapshot, 1)}
	if autostart {
		store.RecordLifecycle("start_autostart")
	} else {
		store.RecordLifecycle("start_manual")
	}
	settingsPath, pathErr := settings.LocalSettingsPath(os.Getenv("LOCALAPPDATA"))
	settingsStore := settings.Store{Path: settingsPath}
	gameLogSettings := settings.Defaults()
	var settingsWarning string
	if pathErr != nil {
		settingsWarning = "Settings cannot be stored because LOCALAPPDATA is unavailable."
	} else if loaded, loadErr := settingsStore.Load(); loadErr != nil {
		settingsWarning = loadErr.Error()
	} else {
		gameLogSettings = loaded
	}
	tray, err := newWindowsTray(store)
	if err != nil {
		return err
	}
	tray.heartbeatUpdates = make(chan connection.HeartbeatConfig, 1)
	tray.presenceUpdates = make(chan connection.PresenceConfig, 1)
	tray.locationCatalogUpdates = make(chan connection.LocationCatalogConfig, 1)
	tray.workerGroup = &sync.WaitGroup{}
	tray.autostart = autostartManager{store: nativeRunValueStore{}, executable: currentExe}
	tray.configureSettings(settingsStore, gameLogSettings, settingsWarning)
	tray.configureConnection(os.Getenv("LOCALAPPDATA"), gameLogSettings)

	ctx, cancel := context.WithCancel(context.Background())
	workersDone := make(chan struct{})
	tray.workerGroup.Add(5)
	shutdown := newShutdownController(cancel, workersDone, func() {
		tray.beginShutdown()
		go func() {
			tray.workerGroup.Wait()
			close(workersDone)
		}()
	}, store.RecordLifecycle, func() {
		emitLifecycleDebug("shutdown_timeout")
		// Process exit lets Windows release owned handles. Never release locks
		// while a worker may still write presence or revision state.
		os.Exit(2)
	}, applicationShutdownTimeout)
	tray.onExit = func() { shutdown.Request(tray.postClose) }
	store.SetWake(tray.postStatusUpdate)
	store.SetLiveWake(tray.postLiveStatusUpdate)

	go func() {
		defer tray.workerGroup.Done()
		_ = runTelemetryWithSettings(ctx, store, store, gameLogSettings, settingsWarning)
	}()
	go func() {
		defer tray.workerGroup.Done()
		(connection.HeartbeatMonitor{Store: tray.credentialStore}).Run(ctx, tray.heartbeatConfig, tray.heartbeatUpdates, store)
	}()
	go func() {
		defer tray.workerGroup.Done()
		(connection.PresenceMonitor{Store: tray.credentialStore}).Run(ctx, tray.presenceConfig, tray.presenceUpdates, store.presenceSnapshots)
	}()
	go func() {
		defer tray.workerGroup.Done()
		cachePath, _ := locationcatalog.LocalCachePath(os.Getenv("LOCALAPPDATA"))
		monitor := connection.LocationCatalogMonitor{Credentials: tray.credentialStore, Cache: locationcatalog.Store{Path: cachePath}}
		monitor.Run(ctx, tray.locationCatalogConfig, tray.locationCatalogUpdates, store)
	}()
	go func() {
		defer tray.workerGroup.Done()
		installed, _ := diagnosticsexport.BuildInfo()
		result, checkErr := updatecheck.CheckLatest(ctx, installed)
		if checkErr == nil && result.HasUpdate() {
			tray.postUpdateCheckResult(result)
		}
	}()

	err = runTrayLifecycle(trayLifecycle{
		run: tray.run, stopPairing: tray.stopPairingAndDrain, shutdown: shutdown, cleanup: tray.cleanup,
	})
	if err == nil {
		releaseMutex()
		mutexReleased = true
	}
	return err
}
