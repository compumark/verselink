//go:build windows

package main

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/compumark/verselink-telemetry/internal/connection"
	"github.com/compumark/verselink-telemetry/internal/settings"
)

type memoryCredentialStore struct {
	values map[string][]byte
	writes int
}

func (s *memoryCredentialStore) Read(target string) ([]byte, error) {
	return append([]byte(nil), s.values[target]...), nil
}
func (s *memoryCredentialStore) Write(target string, value []byte) error {
	if s.values == nil {
		s.values = make(map[string][]byte)
	}
	s.values[target] = append([]byte(nil), value...)
	s.writes++
	return nil
}

func TestRunTrayLifecycleUnexpectedExitDrainsPairingWithoutUIPost(t *testing.T) {
	dir := t.TempDir()
	pairingCtx, cancelPairing := context.WithCancel(context.Background())
	runtimeCtx, cancelRuntime := context.WithCancel(context.Background())
	runtimeDone := make(chan struct{})
	done := make(chan struct{})
	results := make(chan pairingResult, 1)
	resultReady := make(chan struct{})
	credential := []byte("vlt_" + strings.Repeat("b", 42) + "w")
	store := &memoryCredentialStore{}
	tray := &windowsTray{
		settingsStore:     settings.Store{Path: filepath.Join(dir, "settings.json")},
		settingsValue:     settings.Defaults(),
		credentialStore:   store,
		revisionDirectory: filepath.Join(dir, "devices"),
		pairingResults:    results,
		pairingDone:       done,
		pairingCancel:     cancelPairing,
		pairingActive:     true,
	}
	posted := false
	go func() {
		defer close(done)
		results <- pairingResult{response: connection.ClaimResponse{
			Schema: 1, DeviceID: "123e4567-e89b-12d3-a456-426614174001", DeviceName: "Test PC",
			DeviceCredential: credential, TokenType: "Bearer", CreatedAt: "2026-09-25T10:00:00Z",
		}, baseURL: "https://pair.example.test"}
		close(resultReady)
		<-pairingCtx.Done()
		tray.pairingPostGate.postIfActive(func() { posted = true })
	}()
	go func() {
		<-runtimeCtx.Done()
		close(runtimeDone)
	}()
	<-resultReady

	unexpected := errors.New("unexpected tray message-loop failure")
	cleaned := false
	err := runTrayLifecycle(trayLifecycle{
		run:         func() error { return unexpected },
		stopPairing: tray.stopPairingAndDrain,
		cancel:      cancelRuntime,
		runtimeDone: runtimeDone,
		cleanup:     func() { cleaned = true },
	})
	if !errors.Is(err, unexpected) {
		t.Fatalf("runTrayLifecycle error = %v, want original tray.run failure", err)
	}
	if tray.revisionLock != nil {
		defer tray.revisionLock.Release()
	}
	if !cleaned || posted || store.writes != 1 {
		t.Fatalf("shutdown cleanup=%v posted=%v credential writes=%d", cleaned, posted, store.writes)
	}
	if tray.connectionState != connection.Connected || !allBytesZero(credential) {
		t.Fatalf("shutdown state=%q credential cleared=%v", tray.connectionState, allBytesZero(credential))
	}
	select {
	case <-pairingCtx.Done():
	default:
		t.Fatal("unexpected tray exit did not cancel the active pairing request")
	}
	select {
	case <-runtimeCtx.Done():
	default:
		t.Fatal("unexpected tray exit did not cancel the application runtime")
	}
}

func TestRunTrayLifecyclePanicDrainsAndCleansUpBeforeRepanicking(t *testing.T) {
	dir := t.TempDir()
	pairingCtx, cancelPairing := context.WithCancel(context.Background())
	runtimeCtx, cancelRuntime := context.WithCancel(context.Background())
	runtimeDone := make(chan struct{})
	done := make(chan struct{})
	results := make(chan pairingResult, 1)
	resultReady := make(chan struct{})
	credential := []byte("vlt_" + strings.Repeat("c", 42) + "w")
	store := &memoryCredentialStore{}
	tray := &windowsTray{
		settingsStore:     settings.Store{Path: filepath.Join(dir, "settings.json")},
		settingsValue:     settings.Defaults(),
		credentialStore:   store,
		revisionDirectory: filepath.Join(dir, "devices"),
		pairingResults:    results,
		pairingDone:       done,
		pairingCancel:     cancelPairing,
		pairingActive:     true,
	}
	posted := false
	go func() {
		defer close(done)
		results <- pairingResult{response: connection.ClaimResponse{
			Schema: 1, DeviceID: "123e4567-e89b-12d3-a456-426614174002", DeviceName: "Test PC",
			DeviceCredential: credential, TokenType: "Bearer", CreatedAt: "2026-09-25T10:00:00Z",
		}, baseURL: "https://pair.example.test"}
		close(resultReady)
		<-pairingCtx.Done()
		tray.pairingPostGate.postIfActive(func() { posted = true })
	}()
	go func() {
		<-runtimeCtx.Done()
		close(runtimeDone)
	}()
	<-resultReady

	originalPanic := &struct{ marker string }{marker: "tray-run-panic"}
	cleaned := false
	var recovered any
	func() {
		defer func() { recovered = recover() }()
		_ = runTrayLifecycle(trayLifecycle{
			run:         func() error { panic(originalPanic) },
			stopPairing: tray.stopPairingAndDrain,
			cancel:      cancelRuntime,
			runtimeDone: runtimeDone,
			cleanup:     func() { cleaned = true },
		})
	}()
	if tray.revisionLock != nil {
		defer tray.revisionLock.Release()
	}
	if recovered != originalPanic {
		t.Fatalf("lifecycle panic = %v, want original panic value", recovered)
	}
	if !cleaned || posted || store.writes != 1 {
		t.Fatalf("shutdown cleanup=%v posted=%v credential writes=%d", cleaned, posted, store.writes)
	}
	if tray.connectionState != connection.Connected || !allBytesZero(credential) {
		t.Fatalf("shutdown state=%q credential cleared=%v", tray.connectionState, allBytesZero(credential))
	}
	select {
	case <-done:
	default:
		t.Fatal("pairing worker was not drained before panic propagation")
	}
	select {
	case <-pairingCtx.Done():
	default:
		t.Fatal("panic did not cancel the active pairing request")
	}
	select {
	case <-runtimeCtx.Done():
	default:
		t.Fatal("panic did not cancel the application runtime")
	}
}

func (s *memoryCredentialStore) Delete(target string) error { delete(s.values, target); return nil }

func TestCommonDialogCancellationIsNotAnError(t *testing.T) {
	if err := commonDialogFailure(0); err != nil {
		t.Fatalf("canceled file dialog returned error: %v", err)
	}
	if err := commonDialogFailure(0x3002); err == nil {
		t.Fatal("extended common-dialog error was ignored")
	}
}

func TestStopPairingAndDrainPersistsReceivedClaimWithoutUIPost(t *testing.T) {
	dir := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	results := make(chan pairingResult, 1)
	resultReady := make(chan struct{})
	credential := []byte("vlt_" + strings.Repeat("a", 42) + "w")
	store := &memoryCredentialStore{}
	tray := &windowsTray{
		settingsStore:     settings.Store{Path: filepath.Join(dir, "settings.json")},
		settingsValue:     settings.Defaults(),
		credentialStore:   store,
		revisionDirectory: filepath.Join(dir, "devices"),
		pairingResults:    results,
		pairingDone:       done,
		pairingCancel:     cancel,
		pairingActive:     true,
	}
	posted := false
	go func() {
		defer close(done)
		results <- pairingResult{response: connection.ClaimResponse{
			Schema: 1, DeviceID: "123e4567-e89b-12d3-a456-426614174000", DeviceName: "Test PC",
			DeviceCredential: credential, TokenType: "Bearer", CreatedAt: "2026-09-25T10:00:00Z",
		}, baseURL: "https://pair.example.test"}
		close(resultReady)
		<-ctx.Done() // Shutdown stops the post gate before the worker can notify UI.
		tray.pairingPostGate.postIfActive(func() { posted = true })
	}()
	<-resultReady // The successful response arrived before the message loop exits.
	tray.stopPairingAndDrain()
	if tray.revisionLock != nil {
		defer tray.revisionLock.Release()
	}

	if posted {
		t.Fatal("shutdown posted a pairing completion to a stopped UI")
	}
	if tray.connectionState != connection.Connected || tray.settingsValue.Connection.DeviceID == "" {
		t.Fatalf("received claim was not persisted: state=%q settings=%#v", tray.connectionState, tray.settingsValue.Connection)
	}
	if got := store.values[connection.CredentialTarget("https://pair.example.test", tray.settingsValue.Connection.DeviceID)]; string(got) == "" {
		t.Fatal("received credential was not written to the secure store")
	}
	if !allBytesZero(credential) {
		t.Fatal("received credential buffer was not cleared after persistence")
	}
	select {
	case <-ctx.Done():
	default:
		t.Fatal("shutdown did not cancel the pairing request")
	}
}
