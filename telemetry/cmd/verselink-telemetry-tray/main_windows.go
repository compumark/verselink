//go:build windows

package main

import (
	"context"
	"fmt"
	"runtime"
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
	store := &statusStore{}
	tray, err := newWindowsTray(store)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithCancel(context.Background())
	runtimeDone := make(chan struct{})
	shutdown := newShutdownController(cancel, runtimeDone)
	tray.onExit = func() {
		shutdown.Request(tray.postClose)
	}
	store.SetWake(tray.postStatusUpdate)

	go func() {
		defer close(runtimeDone)
		_ = runTelemetry(ctx, store)
	}()

	err = tray.run()
	cancel()
	<-runtimeDone
	return err
}
