package connection

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestValidateBaseURL(t *testing.T) {
	for _, raw := range []string{"", "http://example.test", "https://user:pass@example.test", "https://example.test/path", "https://example.test/?x=1", "https://example.test/#frag", "https://example.test#", "https://example.test:", "https://example.test:99999", "file:///tmp"} {
		if _, err := ValidateBaseURL(raw, false); err == nil {
			t.Errorf("accepted unsafe URL %q", raw)
		}
	}
	if _, err := ValidateBaseURL("http://example.test", true); err == nil {
		t.Fatal("dev HTTP accepted for non-loopback host")
	}
	if got, err := ValidateBaseURL("http://localhost:3000", true); err != nil || got != "http://localhost:3000" {
		t.Fatalf("loopback override = %q, %v", got, err)
	}
	if got, err := ValidateBaseURL("https://example.test/", false); err != nil || got != "https://example.test" {
		t.Fatalf("HTTPS normalization = %q, %v", got, err)
	}
}

func TestResolveBaseURLRequiresExplicitConfigurationAndEnvironmentWins(t *testing.T) {
	if _, _, err := ResolveBaseURL("", "", false); !errors.Is(err, ErrInvalidURL) {
		t.Fatalf("missing URL error = %v", err)
	}
	got, source, err := ResolveBaseURL("https://env.example.test", "https://saved.example.test", false)
	if err != nil || got != "https://env.example.test" || source != URLFromEnvironment {
		t.Fatalf("resolved URL=%q source=%q err=%v", got, source, err)
	}
	got, source, err = ResolveBaseURL("", "https://saved.example.test", false)
	if err != nil || got != "https://saved.example.test" || source != URLFromSettings {
		t.Fatalf("saved URL=%q source=%q err=%v", got, source, err)
	}
	if _, _, err = ResolveBaseURL("http://remote.example.test", "https://safe.example.test", false); !errors.Is(err, ErrInvalidURL) {
		t.Fatalf("unsafe environment URL error = %v", err)
	}
}

func TestClaimSendsNormalizedCodeWithoutCookiesAndValidatesResponse(t *testing.T) {
	credential := "vlt_" + strings.Repeat("a", 42) + "w"
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/telemetry/pair" || r.Method != "POST" {
			t.Errorf("request %s %s", r.Method, r.URL)
		}
		if r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "" {
			t.Errorf("unexpected auth header")
		}
		var body ClaimRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.Code != "7K3M9D2F6R8W1Q5C" || body.Name != "Test PC" {
			t.Errorf("claim request fields invalid (code_normalized=%t, device_name_valid=%t)", body.Code == "7K3M9D2F6R8W1Q5C", body.Name == "Test PC")
		}
		w.WriteHeader(http.StatusCreated)
		_, _ = fmt.Fprintf(w, `{"schema":1,"device_id":"123e4567-e89b-12d3-a456-426614174000","device_name":"Test PC","device_credential":%q,"token_type":"Bearer","created_at":"2026-09-25T10:00:00Z"}`, credential)
	}))
	defer server.Close()
	client := Client{BaseURL: server.URL, HTTP: server.Client()}
	jar, _ := cookiejar.New(nil)
	httpClient := server.Client()
	httpClient.Jar = jar
	client.HTTP = httpClient
	jar.SetCookies(mustURL(t, server.URL), []*http.Cookie{{Name: "bp_session", Value: "cookie-secret"}})
	got, err := client.Claim(context.Background(), "7K3M-9D2F-6R8W-1Q5C", " Test PC ")
	if err != nil || got.DeviceID == "" || string(got.DeviceCredential) != credential {
		t.Fatalf("Claim() response invalid (device_id_present=%t credential_length=%d, err=%v)", got.DeviceID != "", len(got.DeviceCredential), err)
	}
}

func mustURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return u
}

func TestClaimMapsErrorsWithoutEchoingResponse(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "12")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":"rate_limited","secret":"vlt_secret"}`))
	}))
	defer server.Close()
	_, err := (Client{BaseURL: server.URL, HTTP: server.Client()}).Claim(context.Background(), "7K3M9D2F6R8W1Q5C", "")
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Code != "rate_limited" || apiErr.RetryAfter != 12*time.Second {
		t.Fatalf("error = %#v", err)
	}
	if !strings.Contains(err.Error(), "12 seconds") {
		t.Fatalf("rate-limit message did not respect Retry-After: %v", err)
	}
	if strings.Contains(err.Error(), "vlt_secret") {
		t.Fatal("error exposed response secret")
	}
}

type failingTransport struct{ calls int }

func (f *failingTransport) RoundTrip(*http.Request) (*http.Response, error) {
	f.calls++
	return nil, errors.New("transport diagnostic containing credential vlt_secret")
}

func TestClaimNetworkFailureIsSafeAndNeverAutomaticallyRetried(t *testing.T) {
	transport := &failingTransport{}
	_, err := (Client{BaseURL: "https://pair.example.test", HTTP: &http.Client{Transport: transport}}).Claim(context.Background(), "7K3M9D2F6R8W1Q5C", "")
	if !errors.Is(err, ErrServerUnavailable) || strings.Contains(err.Error(), "vlt_secret") {
		t.Fatalf("network error leaked or misclassified: %v", err)
	}
	if transport.calls != 1 {
		t.Fatalf("claim attempts=%d, want exactly one", transport.calls)
	}
}

func TestClaimRejectsMalformedOversizedAndUnexpectedResponses(t *testing.T) {
	for name, handler := range map[string]http.HandlerFunc{
		"malformed": func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(201); _, _ = w.Write([]byte("not-json")) },
		"missing credential": func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(201)
			_, _ = w.Write([]byte(`{"schema":1,"device_id":"123e4567-e89b-12d3-a456-426614174000","device_name":"PC","token_type":"Bearer","created_at":"2026-09-25T10:00:00Z"}`))
		},
		"oversized": func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(201)
			_, _ = w.Write([]byte(strings.Repeat("x", MaxResponseBytes+1)))
		},
	} {
		t.Run(name, func(t *testing.T) {
			srv := httptest.NewTLSServer(handler)
			defer srv.Close()
			if _, err := (Client{BaseURL: srv.URL, HTTP: srv.Client()}).Claim(context.Background(), "7K3M9D2F6R8W1Q5C", ""); !errors.Is(err, ErrInvalidResponse) {
				t.Fatalf("error = %v", err)
			}
		})
	}
}

func TestClaimResponseFailureClearsMutableSecretBuffers(t *testing.T) {
	credential := "vlt_" + strings.Repeat("a", 42) + "w"
	validPrefix := `{"schema":1,"device_id":"123e4567-e89b-12d3-a456-426614174000","device_name":"Test PC","device_credential":` + fmt.Sprintf("%q", credential) + `,"token_type":"Bearer","created_at":`

	t.Run("invalid credential is cleared", func(t *testing.T) {
		mutable := []byte("not-a-valid-credential")
		if validateCredentialForClaim(mutable) {
			t.Fatal("invalid credential accepted")
		}
		if !allZero(mutable) {
			t.Fatalf("invalid credential buffer was not wiped: %q", mutable)
		}
	})

	t.Run("invalid CreatedAt clears response without extracting credential", func(t *testing.T) {
		response := []byte(validPrefix + `"not-a-timestamp"}`)
		var wire claimResponseWire
		got, err := parseClaimResponseWire(response, &wire)
		if !errors.Is(err, ErrInvalidResponse) || len(got.DeviceCredential) != 0 {
			t.Fatalf("parseClaimResponseWire() = %#v, %v", got, err)
		}
		if !allZero(wire.Credential) {
			t.Fatal("decoded RawMessage credential buffer was not wiped")
		}
	})

	t.Run("malformed credential response is cleared", func(t *testing.T) {
		response := []byte(validPrefix + `"invalid"}`)
		var wire claimResponseWire
		got, err := parseClaimResponseWire(response, &wire)
		if !errors.Is(err, ErrInvalidResponse) || len(got.DeviceCredential) != 0 {
			t.Fatalf("parseClaimResponseWire() = %#v, %v", got, err)
		}
		if !allZero(wire.Credential) {
			t.Fatal("decoded RawMessage credential buffer was not wiped")
		}
	})
}

func TestCredentialTargetSeparatesServerAndDevice(t *testing.T) {
	one := CredentialTarget("https://verse.example/", "device-one")
	if again := CredentialTarget("https://VERSE.example", "device-one"); again != one {
		t.Fatalf("normalized server identity produced different target: %q != %q", again, one)
	}
	if two := CredentialTarget("https://verse.example", "device-two"); two == one {
		t.Fatal("two devices on one server share a credential target")
	}
	if dev := CredentialTarget("https://dev.verse.example", "device-one"); dev == one {
		t.Fatal("production and development servers share a credential target")
	}
	if strings.Contains(one, "vlt_") {
		t.Fatal("credential target contains a secret")
	}
	if withDefaultPort := CredentialTarget("https://VERSE.example:443/", "device-one"); withDefaultPort != one {
		t.Fatalf("HTTPS default port target = %q, want %q", withDefaultPort, one)
	}
	if httpDefault := CredentialTarget("http://localhost", "device-one"); httpDefault != CredentialTarget("http://LOCALHOST:80/", "device-one") {
		t.Fatal("HTTP default port did not normalize")
	}
	if customPort := CredentialTarget("https://verse.example:8443", "device-one"); customPort == one {
		t.Fatal("non-standard port shared a credential target")
	}
	if CredentialTarget("https://verse.example/path", "device-one") != "" {
		t.Fatal("invalid path prefix produced a credential target")
	}

	store := &fakeStore{values: map[string]string{}}
	first, second := []byte("vlt_first-secret"), []byte("vlt_second-secret")
	if err := store.Write(one, first); err != nil {
		t.Fatal(err)
	}
	if err := store.Write(CredentialTarget("https://verse.example", "device-two"), second); err != nil {
		t.Fatal(err)
	}
	gotFirst, _ := store.Read(one)
	gotSecond, _ := store.Read(CredentialTarget("https://verse.example", "device-two"))
	if string(gotFirst) != string(first) || string(gotSecond) != string(second) {
		t.Fatal("per-device credential read crossed device targets")
	}
	if err := store.Delete(one); err != nil {
		t.Fatal(err)
	}
	if _, exists := store.values[one]; exists || store.values[CredentialTarget("https://verse.example", "device-two")] != string(second) {
		t.Fatal("deleting one device credential affected the other target")
	}
}

func allZero(value []byte) bool {
	for _, b := range value {
		if b != 0 {
			return false
		}
	}
	return true
}

type fakeStore struct {
	values map[string]string
	err    error
}

func (f *fakeStore) Read(k string) ([]byte, error) { return []byte(f.values[k]), f.err }
func (f *fakeStore) Write(k string, v []byte) error {
	if f.err != nil {
		return f.err
	}
	f.values[k] = string(v)
	return nil
}
func (f *fakeStore) Delete(k string) error {
	if f.err != nil {
		return f.err
	}
	delete(f.values, k)
	return nil
}

func TestDisconnectOnlyDeletesLocalCredentialAndIsIdempotent(t *testing.T) {
	store := &fakeStore{values: map[string]string{"target": "vlt_" + strings.Repeat("a", 42) + "w"}}
	if err := Disconnect(store, "target"); err != nil {
		t.Fatal(err)
	}
	if err := Disconnect(store, "target"); err != nil {
		t.Fatal(err)
	}
	if len(store.values) != 0 {
		t.Fatalf("local credentials remain: %v", store.values)
	}
}

func TestPairingControllerNeverReturnsSecretAndModelsStates(t *testing.T) {
	credential := "vlt_" + strings.Repeat("z", 42) + "w"
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(201)
		_, _ = fmt.Fprintf(w, `{"schema":1,"device_id":"123e4567-e89b-12d3-a456-426614174000","device_name":"Test PC","device_credential":%q,"token_type":"Bearer","created_at":"2026-09-25T10:00:00Z"}`, credential)
	}))
	defer server.Close()
	store := &fakeStore{values: map[string]string{}}
	controller := Controller{Service: PairingService{Client: Client{BaseURL: server.URL, HTTP: server.Client()}, Store: store}}
	response, err := controller.Pair(context.Background(), "target", "7K3M9D2F6R8W1Q5C", "")
	if err != nil || controller.Current.State != Connected || len(response.DeviceCredential) != 0 || store.values["target"] != credential {
		t.Fatalf("Pair() response=%#v state=%#v err=%v", response, controller.Current, err)
	}
	controller.SetAuthenticationState(DeviceRevoked, "revoked")
	if controller.Current.State != DeviceRevoked {
		t.Fatalf("state = %#v", controller.Current)
	}
	if err := controller.Disconnect("target"); err != nil || controller.Current.State != NotConnected || len(store.values) != 0 {
		t.Fatalf("Disconnect() state=%#v err=%v", controller.Current, err)
	}
}

func TestSecureStoreFailureDoesNotReturnCredential(t *testing.T) {
	credential := "vlt_" + strings.Repeat("a", 42) + "w"
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(201)
		_, _ = fmt.Fprintf(w, `{"schema":1,"device_id":"123e4567-e89b-12d3-a456-426614174000","device_name":"Test PC","device_credential":%q,"token_type":"Bearer","created_at":"2026-09-25T10:00:00Z"}`, credential)
	}))
	defer server.Close()
	store := &fakeStore{values: map[string]string{}, err: errors.New("do not surface")}
	response, err := (PairingService{Client: Client{BaseURL: server.URL, HTTP: server.Client()}, Store: store}).Pair(context.Background(), "target", "7K3M9D2F6R8W1Q5C", "")
	if !errors.Is(err, ErrSecureStore) || response.DeviceCredential != nil || strings.Contains(err.Error(), credential) {
		t.Fatalf("storage failure result=%#v err=%v", response, err)
	}
}
