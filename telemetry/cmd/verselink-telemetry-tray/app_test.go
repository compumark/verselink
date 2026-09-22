package main

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/compumark/verselink-telemetry/internal/gamelog"
	"github.com/compumark/verselink-telemetry/internal/runtimehost"
	"github.com/compumark/verselink-telemetry/internal/telemetry"
)

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
	if !strings.Contains(text, "Party members: 4") {
		t.Fatalf("diagnostics = %q, want Party count", text)
	}
	for _, forbidden := range []string{"CrewMate", "SecondMate", "GEID_SECRET_SENTINEL", "RAW_GAME_LOG_SECRET_SENTINEL", "map["} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("diagnostics contain forbidden value %q", forbidden)
		}
	}
}

func TestShutdownControllerCancelsAndWaitsBeforeClosing(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	runtimeDone := make(chan struct{})
	closed := make(chan struct{})
	controller := newShutdownController(cancel, runtimeDone)

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
