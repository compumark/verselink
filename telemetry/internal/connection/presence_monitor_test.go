package connection

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/compumark/verselink-telemetry/internal/revision"
	"github.com/compumark/verselink-telemetry/internal/telemetry"
)

type presenceTestStore struct{ credential string }

func (s presenceTestStore) Read(string) ([]byte, error) { return []byte(s.credential), nil }
func (presenceTestStore) Write(string, []byte) error    { return nil }
func (presenceTestStore) Delete(string) error           { return nil }

func TestPresenceMonitorSuppressesDiscardOnlyChangesAndPersistsRevision(t *testing.T) {
	var calls atomic.Int32
	received := make(chan string, 4)
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		received <- string(body)
		count := calls.Add(1)
		var revision int
		_, _ = fmt.Sscanf(string(body), `{"schema":1,"revision":%d`, &revision)
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"schema":1,"accepted":true,"revision":%d,"received_at":"2026-09-24T12:00:00Z"}`, revision)
		if count < 1 {
			t.Error("unexpected call count")
		}
	}))
	defer server.Close()
	dir := t.TempDir()
	lock, _, err := revision.Acquire(dir, "device-one")
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	ctx, cancel := context.WithCancel(context.Background())
	snapshots := make(chan PresenceSnapshot, 1)
	updates := make(chan PresenceConfig, 1)
	config := PresenceConfig{BaseURL: server.URL, DeviceID: "device-one", RevisionLock: lock}
	done := make(chan struct{})
	go func() {
		(PresenceMonitor{Client: Client{HTTP: server.Client()}, Store: presenceTestStore{testDeviceCredential}}).Run(ctx, config, updates, snapshots)
		close(done)
	}()
	base := telemetry.TelemetryState{SessionActive: true, Shard: "one", Party: []string{"private"}}
	snapshots <- PresenceSnapshot{State: base, Available: true}
	first := <-received
	if !strings.Contains(first, `"revision":1`) || strings.Contains(first, "private") {
		t.Fatalf("first payload = %s", first)
	}
	base.Shard, base.Party = "two", []string{"another-private"}
	snapshots <- PresenceSnapshot{State: base, Available: true}
	base.Jurisdiction = "Stanton"
	snapshots <- PresenceSnapshot{State: base, Available: true}
	second := <-received
	if !strings.Contains(second, `"revision":2`) || !strings.Contains(second, `"jurisdiction":"Stanton"`) {
		t.Fatalf("second payload = %s", second)
	}
	select {
	case extra := <-received:
		t.Fatalf("discard-only change emitted request: %s", extra)
	case <-time.After(75 * time.Millisecond):
	}
	state, err := lock.Advance()
	if err != nil || state.Revision != 3 {
		t.Fatalf("durable revision after two updates = %#v, %v", state, err)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("presence monitor did not stop")
	}
	if _, err := os.Stat(filepath.Join(dir, "device-one.revision.json")); err != nil {
		t.Fatal(err)
	}
}

func TestPresenceMonitorRetriesIdenticalBodyAndRevision(t *testing.T) {
	var calls atomic.Int32
	received := make(chan string, 3)
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		received <- string(body)
		count := calls.Add(1)
		if count == 1 {
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte(`{"error":"server_unavailable"}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{"schema":1,"accepted":true,"revision":1,"received_at":"2026-09-24T12:00:00Z"}`)
	}))
	defer server.Close()
	lock, _, err := revision.Acquire(t.TempDir(), "device-two")
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	ctx, cancel := context.WithCancel(context.Background())
	snapshots := make(chan PresenceSnapshot, 1)
	done := make(chan struct{})
	config := PresenceConfig{BaseURL: server.URL, DeviceID: "device-two", RevisionLock: lock}
	go func() {
		(PresenceMonitor{Client: Client{HTTP: server.Client()}, Store: presenceTestStore{testDeviceCredential}, Jitter: func(time.Duration) time.Duration { return 0 }}).Run(ctx, config, make(chan PresenceConfig), snapshots)
		close(done)
	}()
	snapshots <- PresenceSnapshot{Available: true, State: telemetry.TelemetryState{SessionActive: true}}
	first, second := <-received, <-received
	if first != second || !strings.Contains(first, `"revision":1`) {
		t.Fatalf("retry body changed: first=%s second=%s", first, second)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("presence monitor did not stop")
	}
}

func TestPresenceMonitorReconcilesServerHighWaterBeforeRetry(t *testing.T) {
	var calls atomic.Int32
	requests := make(chan PresenceRequest, 2)
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request PresenceRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
		}
		requests <- request
		if calls.Add(1) == 1 {
			w.WriteHeader(http.StatusConflict)
			_, _ = fmt.Fprint(w, `{"error":"stale_revision","current_revision":42}`)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"schema":1,"accepted":true,"revision":%d,"received_at":"2026-09-24T12:00:00Z"}`, request.Revision)
	}))
	defer server.Close()
	lock, _, err := revision.Acquire(t.TempDir(), "device-three")
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	ctx, cancel := context.WithCancel(context.Background())
	snapshots := make(chan PresenceSnapshot, 1)
	done := make(chan struct{})
	config := PresenceConfig{BaseURL: server.URL, DeviceID: "device-three", RevisionLock: lock}
	go func() {
		(PresenceMonitor{Client: Client{HTTP: server.Client()}, Store: presenceTestStore{testDeviceCredential}, Jitter: func(time.Duration) time.Duration { return 0 }}).Run(ctx, config, make(chan PresenceConfig), snapshots)
		close(done)
	}()
	snapshots <- PresenceSnapshot{Available: true, State: telemetry.TelemetryState{Jurisdiction: "Stanton"}}
	first, second := <-requests, <-requests
	if first.Revision != 1 || second.Revision != 43 || second.Jurisdiction == nil || *second.Jurisdiction != "Stanton" {
		t.Fatalf("revision reconciliation = first %#v, second %#v", first, second)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("presence monitor did not stop")
	}
}
