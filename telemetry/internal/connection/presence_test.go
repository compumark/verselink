package connection

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/compumark/verselink-telemetry/internal/telemetry"
)

func TestMapPresenceSnapshotIsExplicitAndPrivacySafe(t *testing.T) {
	observed := time.Date(2026, 9, 24, 12, 0, 0, 123456789, time.FixedZone("offset", 2*60*60))
	state := telemetry.TelemetryState{
		SessionActive: true, PlayerHandle: "PRIVATE_HANDLE", Shard: "pu-test-01", Jurisdiction: "Stanton",
		Location: &telemetry.LocationState{Raw: "RR_CRU_L1", ObservedAt: observed, Source: "PRIVATE_SOURCE"},
		Ship:     &telemetry.ShipState{Name: "RSI_Hermes", Owner: "PRIVATE_OWNER"},
		Quantum:  &telemetry.QuantumState{Destination: "LOC_CRU_L1", State: "target_selected"},
		Party:    []string{"PRIVATE_CREWMATE"}, LastEventAt: observed,
	}
	request := MapPresenceSnapshot(state, true)
	if request.Schema != 1 || request.SessionActive == nil || !*request.SessionActive || request.PartyCount == nil || *request.PartyCount != 1 {
		t.Fatalf("unexpected core mapping: %#v", request)
	}
	encoded, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	text := string(encoded)
	for _, forbidden := range []string{"PRIVATE_HANDLE", "PRIVATE_SOURCE", "PRIVATE_OWNER", "PRIVATE_CREWMATE", "playerHandle"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("wire DTO contains forbidden %q: %s", forbidden, text)
		}
	}
	if !strings.Contains(text, "2026-09-24T10:00:00.123456789Z") {
		t.Fatalf("source timestamp precision/UTC mapping lost: %s", text)
	}
	unknown := MapPresenceSnapshot(state, false)
	if unknown.SessionActive != nil || unknown.PartyCount != nil || unknown.Shard != nil || unknown.Location != nil {
		t.Fatalf("unavailable state was inferred: %#v", unknown)
	}
}

func TestPutPresenceUsesBoundedBearerRequestAndParsesRevision(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut || r.URL.Path != "/api/telemetry/presence" || r.Header.Get("Authorization") != "Bearer "+testDeviceCredential || r.Header.Get("Cookie") != "" {
			t.Errorf("unexpected request method/path/auth: %s %s", r.Method, r.URL)
		}
		var body PresenceRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Schema != 1 || body.Revision != 7 || body.Shard == nil || *body.Shard != "pu-test-01" {
			t.Errorf("request body = %#v, %v", body, err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{"schema":1,"accepted":true,"revision":7,"received_at":"2026-09-24T12:01:00.123456Z"}`)
	}))
	defer server.Close()
	shard := "pu-test-01"
	got, err := (Client{BaseURL: server.URL, HTTP: server.Client()}).PutPresence(context.Background(), []byte(testDeviceCredential), PresenceRequest{Schema: 1, Revision: 7, Shard: &shard})
	if err != nil || !got.Accepted || got.Revision != 7 || got.ReceivedAt.Nanosecond() != 123456000 {
		t.Fatalf("PutPresence() = %#v, %v", got, err)
	}
}

func TestPutPresenceReturnsConflictHighWaterWithoutLeakingBody(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = fmt.Fprint(w, `{"error":"stale_revision","current_revision":42}`)
	}))
	defer server.Close()
	_, err := (Client{BaseURL: server.URL, HTTP: server.Client()}).PutPresence(context.Background(), []byte(testDeviceCredential), PresenceRequest{Schema: 1, Revision: 2})
	apiErr, ok := err.(*APIError)
	if !ok || apiErr.Code != "stale_revision" || apiErr.CurrentRevision != 42 {
		t.Fatalf("error = %#v", err)
	}
	if strings.Contains(err.Error(), "42") {
		t.Fatal("API error exposed response content")
	}
}
