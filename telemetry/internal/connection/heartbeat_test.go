package connection

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

var testDeviceCredential = "vlt_" + strings.Repeat("a", 42) + "w"

func TestHeartbeatSendsBearerOnlyAndParsesServerReceipt(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/telemetry/heartbeat" {
			t.Errorf("request %s %s", r.Method, r.URL)
		}
		if r.Header.Get("Authorization") != "Bearer "+testDeviceCredential || r.Header.Get("Cookie") != "" {
			t.Errorf("unexpected auth/cookie header")
		}
		if r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("content type = %q", r.Header.Get("Content-Type"))
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body) != 1 || body["schema"] != float64(1) {
			t.Errorf("body = %#v, %v", body, err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{"schema":1,"ok":true,"received_at":"2026-09-27T10:11:12.123456789Z"}`)
	}))
	defer server.Close()
	jar, _ := cookiejar.New(nil)
	client := server.Client()
	client.Jar = jar
	jar.SetCookies(mustURL(t, server.URL), []*http.Cookie{{Name: "session", Value: "secret"}})
	secret := []byte(testDeviceCredential)
	got, err := (Client{BaseURL: server.URL, HTTP: client}).Heartbeat(context.Background(), secret)
	if err != nil || !got.ReceivedAt.Equal(time.Date(2026, 9, 27, 10, 11, 12, 123456789, time.UTC)) {
		t.Fatalf("Heartbeat = %v, %v", got, err)
	}
	if !allZero(secret) {
		t.Fatal("credential buffer was not cleared")
	}
}

func TestHeartbeatMapsRetryAfterAndNeverEchoesResponse(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "999")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte("invalid secret response vlt_secret"))
	}))
	defer server.Close()
	_, err := (Client{BaseURL: server.URL, HTTP: server.Client()}).Heartbeat(context.Background(), []byte(testDeviceCredential))
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.HTTPStatus != 429 || apiErr.RetryAfter != RetryAfterCap {
		t.Fatalf("error = %#v", err)
	}
	if strings.Contains(err.Error(), "vlt_secret") {
		t.Fatal("error exposed response body")
	}
}

func TestHeartbeatTreats5xxAsTransientBeforeDecodingBody(t *testing.T) {
	for _, tc := range []struct {
		name       string
		body       string
		retryAfter string
		wantDelay  time.Duration
	}{
		{name: "invalid JSON with retry hint", body: "{not json", retryAfter: "17", wantDelay: 17 * time.Second},
		{name: "empty body without retry hint", body: "", wantDelay: 0},
		{name: "oversized delay is capped", body: "not json", retryAfter: "999", wantDelay: RetryAfterCap},
		{name: "zero delay is raised to one second", body: "", retryAfter: "0", wantDelay: time.Second},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				if tc.retryAfter != "" {
					w.Header().Set("Retry-After", tc.retryAfter)
				}
				w.WriteHeader(http.StatusServiceUnavailable)
				_, _ = fmt.Fprint(w, tc.body)
			}))
			defer server.Close()
			_, err := (Client{BaseURL: server.URL, HTTP: server.Client()}).Heartbeat(context.Background(), []byte(testDeviceCredential))
			var apiErr *APIError
			if !errors.As(err, &apiErr) || apiErr.HTTPStatus != http.StatusServiceUnavailable || apiErr.Code != "server_unavailable" || apiErr.RetryAfter != tc.wantDelay {
				t.Fatalf("Heartbeat error = %#v (%v)", apiErr, err)
			}
			if strings.Contains(err.Error(), tc.body) && tc.body != "" {
				t.Fatal("response body was exposed through the returned error")
			}
		})
	}
}

func TestHeartbeatUsesTenSecondDeadlineAndClearsCredentialOnEarlyFailure(t *testing.T) {
	var remaining time.Duration
	transport := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		deadline, ok := request.Context().Deadline()
		if !ok {
			t.Error("heartbeat request has no deadline")
		} else {
			remaining = time.Until(deadline)
		}
		return nil, errors.New("offline")
	})
	credential := []byte(testDeviceCredential)
	_, err := (Client{BaseURL: "https://example.test", HTTP: &http.Client{Transport: transport}}).Heartbeat(context.Background(), credential)
	if !errors.Is(err, ErrServerUnavailable) || remaining <= 0 || remaining > HeartbeatTimeout || !allZero(credential) {
		t.Fatalf("heartbeat timeout/clear err=%v remaining=%v cleared=%t", err, remaining, allZero(credential))
	}
	invalid := []byte("secret-buffer")
	_, err = (Client{BaseURL: "https://example.test/path"}).Heartbeat(context.Background(), invalid)
	if !errors.Is(err, ErrInvalidURL) || !allZero(invalid) {
		t.Fatalf("early failure err=%v cleared=%t", err, allZero(invalid))
	}
}

type memoryCredentialStore struct{ value []byte }

func (s *memoryCredentialStore) Read(string) ([]byte, error) {
	return append([]byte(nil), s.value...), nil
}
func (s *memoryCredentialStore) Write(string, []byte) error { return nil }
func (s *memoryCredentialStore) Delete(string) error        { return nil }

type healthRecorder struct {
	mu     sync.Mutex
	values []HealthStatus
}

func (r *healthRecorder) OnConnectionHealth(value HealthStatus) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.values = append(r.values, value)
}
func (r *healthRecorder) snapshot() []HealthStatus {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]HealthStatus(nil), r.values...)
}

func TestHeartbeatMonitorSuccessfulSendAndShutdown(t *testing.T) {
	requests := 0
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		_, _ = fmt.Fprint(w, `{"schema":1,"ok":true,"received_at":"2026-09-27T10:11:12Z"}`)
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	recorder := &healthRecorder{}
	var scheduled time.Duration
	monitor := HeartbeatMonitor{Client: Client{HTTP: server.Client()}, Store: &memoryCredentialStore{value: []byte(testDeviceCredential)}, Wait: func(_ context.Context, duration time.Duration) bool { scheduled = duration; cancel(); return false }}
	monitor.Run(ctx, HeartbeatConfig{BaseURL: server.URL, DeviceID: "device-1"}, nil, recorder)
	if requests != 1 {
		t.Fatalf("requests=%d", requests)
	}
	if scheduled != HeartbeatInterval {
		t.Fatalf("next heartbeat scheduled after %v", scheduled)
	}
	states := recorder.snapshot()
	if len(states) != 2 || states[0].State != HealthConnecting || states[1].State != HealthConnected || states[1].LastSuccess.IsZero() {
		t.Fatalf("states=%#v", states)
	}
}

func TestHeartbeatMonitorStopsAfterAuthenticationFailure(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		code   string
		want   HealthState
	}{
		{"invalid credential", 401, "invalid_device_credential", HealthAuthenticationFailed},
		{"revoked", 401, "device_revoked", HealthDeviceRevoked},
		{"inactive account", 403, "account_inactive", HealthAuthenticationFailed},
	} {
		t.Run(tc.name, func(t *testing.T) {
			requests := 0
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				requests++
				w.WriteHeader(tc.status)
				_, _ = fmt.Fprintf(w, `{"error":%q}`, tc.code)
			}))
			defer server.Close()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			recorder := &healthRecorder{}
			monitor := HeartbeatMonitor{Client: Client{HTTP: server.Client()}, Store: &memoryCredentialStore{value: []byte(testDeviceCredential)}}
			done := make(chan struct{})
			go func() {
				defer close(done)
				monitor.Run(ctx, HeartbeatConfig{BaseURL: server.URL, DeviceID: "device-1"}, nil, recorder)
			}()
			deadline := time.After(2 * time.Second)
			for {
				states := recorder.snapshot()
				if len(states) > 1 && states[len(states)-1].State == tc.want {
					break
				}
				select {
				case <-deadline:
					cancel()
					<-done
					t.Fatalf("monitor did not report %s", tc.want)
				case <-time.After(time.Millisecond):
				}
			}
			cancel()
			select {
			case <-done:
			case <-time.After(time.Second):
				t.Fatal("monitor did not cancel")
			}
			if requests != 1 {
				t.Fatalf("authentication failure retried %d times", requests)
			}
		})
	}
}

func TestHeartbeatMonitorDoesNotRetryOtherClientErrors(t *testing.T) {
	requests := 0
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		w.WriteHeader(400)
		_, _ = w.Write([]byte(`{"error":"unsupported_schema"}`))
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	recorder := &healthRecorder{}
	monitor := HeartbeatMonitor{Client: Client{HTTP: server.Client()}, Store: &memoryCredentialStore{value: []byte(testDeviceCredential)}}
	done := make(chan struct{})
	go func() {
		defer close(done)
		monitor.Run(ctx, HeartbeatConfig{BaseURL: server.URL, DeviceID: "device-1"}, nil, recorder)
	}()
	deadline := time.After(2 * time.Second)
	for {
		states := recorder.snapshot()
		if len(states) > 1 && states[len(states)-1].Error == "client_error" {
			break
		}
		select {
		case <-deadline:
			cancel()
			<-done
			t.Fatal("monitor did not report client error")
		case <-time.After(time.Millisecond):
		}
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("monitor did not stop")
	}
	if requests != 1 {
		t.Fatalf("non-auth 4xx retried %d times", requests)
	}
}

func TestHeartbeatMonitorBackoffJitterIsBounded(t *testing.T) {
	var got time.Duration
	monitor := HeartbeatMonitor{Jitter: func(cap time.Duration) time.Duration { got = cap; return cap + 1 }}
	if value := monitor.jitter(60 * time.Second); value != 60*time.Second || got != 60*time.Second {
		t.Fatalf("jitter=%v cap=%v", value, got)
	}
}

func TestHeartbeatMonitorRetryAfterPrecedesExponentialBackoff(t *testing.T) {
	requests := 0
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		if requests == 1 {
			w.Header().Set("Retry-After", "7")
			w.WriteHeader(429)
			_, _ = w.Write([]byte("unparseable response body"))
			return
		}
		_, _ = fmt.Fprint(w, `{"schema":1,"ok":true,"received_at":"2026-09-27T10:11:12Z"}`)
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var delays []time.Duration
	monitor := HeartbeatMonitor{Client: Client{HTTP: server.Client()}, Store: &memoryCredentialStore{value: []byte(testDeviceCredential)}, Wait: func(_ context.Context, d time.Duration) bool {
		delays = append(delays, d)
		if len(delays) == 2 {
			cancel()
			return false
		}
		return true
	}}
	recorder := &healthRecorder{}
	monitor.Run(ctx, HeartbeatConfig{BaseURL: server.URL, DeviceID: "device-1"}, nil, recorder)
	if requests != 2 || len(delays) != 2 || delays[0] != 7*time.Second || delays[1] != HeartbeatInterval {
		t.Fatalf("requests=%d delays=%v", requests, delays)
	}
}

func TestHeartbeatMonitorUses5xxRetryAfterInsteadOfJitter(t *testing.T) {
	requests := 0
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		if requests == 1 {
			w.Header().Set("Retry-After", "11")
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte("malformed upstream body"))
			return
		}
		_, _ = fmt.Fprint(w, `{"schema":1,"ok":true,"received_at":"2026-09-27T10:11:12Z"}`)
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var delays []time.Duration
	var jitterCalls int
	monitor := HeartbeatMonitor{
		Client: Client{HTTP: server.Client()}, Store: &memoryCredentialStore{value: []byte(testDeviceCredential)},
		Jitter: func(cap time.Duration) time.Duration { jitterCalls++; return cap },
		Wait: func(_ context.Context, delay time.Duration) bool {
			delays = append(delays, delay)
			if requests == 2 {
				cancel()
				return false
			}
			return true
		},
	}
	monitor.Run(ctx, HeartbeatConfig{BaseURL: server.URL, DeviceID: "device-1"}, nil, &healthRecorder{})
	if requests != 2 || len(delays) != 2 || delays[0] != 11*time.Second || delays[1] != HeartbeatInterval || jitterCalls != 0 {
		t.Fatalf("requests=%d delays=%v jitter calls=%d", requests, delays, jitterCalls)
	}
}

func TestHeartbeatMonitorUsesFullJitterFor5xxWithoutRetryAfter(t *testing.T) {
	requests := 0
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		if requests == 1 {
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte(""))
			return
		}
		_, _ = fmt.Fprint(w, `{"schema":1,"ok":true,"received_at":"2026-09-27T10:11:12Z"}`)
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var caps, delays []time.Duration
	monitor := HeartbeatMonitor{
		Client: Client{HTTP: server.Client()}, Store: &memoryCredentialStore{value: []byte(testDeviceCredential)},
		Jitter: func(cap time.Duration) time.Duration { caps = append(caps, cap); return cap / 2 },
		Wait: func(_ context.Context, delay time.Duration) bool {
			delays = append(delays, delay)
			if requests == 2 {
				cancel()
				return false
			}
			return true
		},
	}
	monitor.Run(ctx, HeartbeatConfig{BaseURL: server.URL, DeviceID: "device-1"}, nil, &healthRecorder{})
	if requests != 2 || len(caps) != 1 || caps[0] != time.Second || len(delays) != 2 || delays[0] != 500*time.Millisecond || delays[1] != HeartbeatInterval {
		t.Fatalf("requests=%d caps=%v delays=%v", requests, caps, delays)
	}
}

func TestHeartbeatMonitorDoesNotRetryInvalidSuccessResponse(t *testing.T) {
	requests := 0
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		_, _ = fmt.Fprint(w, `{"schema":1,"ok":false}`)
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	recorder := &healthRecorder{}
	monitor := HeartbeatMonitor{Client: Client{HTTP: server.Client()}, Store: &memoryCredentialStore{value: []byte(testDeviceCredential)}}
	done := make(chan struct{})
	go func() {
		defer close(done)
		monitor.Run(ctx, HeartbeatConfig{BaseURL: server.URL, DeviceID: "device-1"}, nil, recorder)
	}()
	deadline := time.After(2 * time.Second)
	for {
		states := recorder.snapshot()
		if len(states) > 1 && states[len(states)-1].Error == "invalid_response" {
			break
		}
		select {
		case <-deadline:
			cancel()
			<-done
			t.Fatal("monitor did not classify invalid 2xx response")
		case <-time.After(time.Millisecond):
		}
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("monitor did not stop after invalid 2xx response")
	}
	if requests != 1 {
		t.Fatalf("invalid 2xx response retried %d times", requests)
	}
}

func TestHeartbeatMonitorCancellationDuringRetryWaitStopsFurtherRequests(t *testing.T) {
	requests := 0
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte("not JSON"))
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	waitStarted := make(chan struct{})
	monitor := HeartbeatMonitor{
		Client: Client{HTTP: server.Client()}, Store: &memoryCredentialStore{value: []byte(testDeviceCredential)},
		Wait: func(ctx context.Context, _ time.Duration) bool {
			close(waitStarted)
			<-ctx.Done()
			return false
		},
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		monitor.Run(ctx, HeartbeatConfig{BaseURL: server.URL, DeviceID: "device-1"}, nil, &healthRecorder{})
	}()
	select {
	case <-waitStarted:
		cancel()
	case <-time.After(2 * time.Second):
		cancel()
		t.Fatal("monitor did not enter retry wait")
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("monitor did not stop after shutdown cancellation")
	}
	if requests != 1 {
		t.Fatalf("shutdown during retry wait allowed %d requests", requests)
	}
}

func TestHeartbeatMonitorRetriesTransientFailureWithExponentialFullJitterAndRecovers(t *testing.T) {
	requests := 0
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		if requests < 3 {
			http.Error(w, `{"error":"server_unavailable"}`, 503)
			return
		}
		_, _ = fmt.Fprint(w, `{"schema":1,"ok":true,"received_at":"2026-09-27T10:11:12Z"}`)
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var caps, delays []time.Duration
	monitor := HeartbeatMonitor{Client: Client{HTTP: server.Client()}, Store: &memoryCredentialStore{value: []byte(testDeviceCredential)}, Jitter: func(cap time.Duration) time.Duration { caps = append(caps, cap); return cap }, Wait: func(_ context.Context, d time.Duration) bool {
		delays = append(delays, d)
		if requests == 3 {
			cancel()
			return false
		}
		return true
	}}
	recorder := &healthRecorder{}
	monitor.Run(ctx, HeartbeatConfig{BaseURL: server.URL, DeviceID: "device-1"}, nil, recorder)
	if requests != 3 || len(caps) != 2 || caps[0] != time.Second || caps[1] != 2*time.Second || delays[0] != time.Second || delays[1] != 2*time.Second {
		t.Fatalf("requests=%d caps=%v delays=%v", requests, caps, delays)
	}
	states := recorder.snapshot()
	if states[len(states)-1].State != HealthConnected || states[len(states)-1].LastSuccess.IsZero() {
		t.Fatalf("recovery state=%#v", states)
	}
}

func TestHeartbeatMonitorConfigurationUpdateCancelsInflightRequest(t *testing.T) {
	started := make(chan struct{})
	cancelled := make(chan struct{})
	transport := roundTripFunc(func(r *http.Request) (*http.Response, error) {
		close(started)
		<-r.Context().Done()
		close(cancelled)
		return nil, r.Context().Err()
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	updates := make(chan HeartbeatConfig, 1)
	recorder := &healthRecorder{}
	monitor := HeartbeatMonitor{Client: Client{HTTP: &http.Client{Transport: transport}}, Store: &memoryCredentialStore{value: []byte(testDeviceCredential)}}
	done := make(chan struct{})
	go func() {
		defer close(done)
		monitor.Run(ctx, HeartbeatConfig{BaseURL: "https://example.test", DeviceID: "device-1"}, updates, recorder)
	}()
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		cancel()
		t.Fatal("request did not start")
	}
	updates <- HeartbeatConfig{}
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		cancel()
		t.Fatal("configuration change did not cancel HTTP request")
	}
	deadline := time.After(2 * time.Second)
	for {
		states := recorder.snapshot()
		if len(states) > 1 && states[len(states)-1].State == HealthNotConnected {
			break
		}
		select {
		case <-deadline:
			cancel()
			t.Fatal("monitor did not switch to Not connected")
		case <-time.After(time.Millisecond):
		}
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("monitor remained running")
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) { return fn(request) }
