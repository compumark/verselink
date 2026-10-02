package updatecheck

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestParseStableVersionAndTelemetryTag(t *testing.T) {
	if ReleasesAPIURL != "https://api.github.com/repos/compumark/verselink/releases?per_page=100" {
		t.Fatalf("release API URL changed unexpectedly: %q", ReleasesAPIURL)
	}
	for _, value := range []string{"v0.0.0", "v1.2.3", "v10.20.30"} {
		if _, _, _, ok := ParseStableVersion(value); !ok {
			t.Errorf("ParseStableVersion(%q) rejected valid version", value)
		}
	}
	for _, value := range []string{"", "dev", "1.2.3", "v01.2.3", "v1.02.3", "v1.2.03", "v1.2", "v1.2.3-rc.1", "v1.2.3+meta"} {
		if _, _, _, ok := ParseStableVersion(value); ok {
			t.Errorf("ParseStableVersion(%q) accepted invalid version", value)
		}
	}
	largeVersion := "v" + strings.Repeat("9", 100) + "." + strings.Repeat("8", 120) + "." + strings.Repeat("7", 140)
	if _, _, _, ok := ParseStableVersion(largeVersion); !ok {
		t.Fatalf("ParseStableVersion rejected arbitrarily large valid version %q", largeVersion)
	}
	if got, ok := ParseTelemetryTag("telemetry-v1.2.3"); !ok || got != "v1.2.3" {
		t.Fatalf("ParseTelemetryTag() = %q, %v", got, ok)
	}
	for _, tag := range []string{"v9.0.0", "telemetry-v1.2.3-rc.1", "telemetry-v01.2.3", "telemetry-v1.2.3+meta", "Telemetry-v1.2.3", "telemetry-v1.2.3-extra"} {
		if _, ok := ParseTelemetryTag(tag); ok {
			t.Errorf("ParseTelemetryTag(%q) accepted invalid tag", tag)
		}
	}
}

func TestNumericVersionComparison(t *testing.T) {
	nines := strings.Repeat("9", 100)
	tenToPower := "1" + strings.Repeat("0", 100)
	cases := []struct {
		installed, available string
		want                 bool
	}{
		{"v1.9.9", "v1.10.0", true},
		{"v1.10.0", "v1.9.99", false},
		{"v1.2.3", "v1.2.4", true},
		{"v1.2.3", "v1.2.3", false},
		{"v2.0.0", "v1.99.99", false},
		{"dev", "v99.0.0", false},
		{"v" + nines + ".0.0", "v" + tenToPower + ".0.0", true},
		{"v1." + nines + ".0", "v1." + tenToPower + ".0", true},
		{"v1.0." + nines, "v1.0." + tenToPower, true},
		{"v" + tenToPower + "." + tenToPower + "." + tenToPower, "v" + tenToPower + "." + tenToPower + "." + tenToPower, false},
	}
	for _, tc := range cases {
		if got := IsNewer(tc.installed, tc.available); got != tc.want {
			t.Errorf("IsNewer(%q,%q)=%v, want %v", tc.installed, tc.available, got, tc.want)
		}
	}
}

func TestCheckSelectsNewestStableTelemetryOnly(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/releases" || r.URL.Query().Get("per_page") != "100" {
			t.Errorf("request = %s %s", r.Method, r.URL.String())
		}
		if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
			t.Error("update request unexpectedly carried user credentials")
		}
		fmt.Fprint(w, `[
{"tag_name":"telemetry-v1.9.9","draft":false,"prerelease":false},
{"tag_name":"telemetry-v1.10.0","draft":false,"prerelease":false},
{"tag_name":"telemetry-v8.0.0","draft":true,"prerelease":false},
{"tag_name":"telemetry-v7.0.0","draft":false,"prerelease":true},
{"tag_name":"telemetry-v99.0.0-rc.1","draft":false,"prerelease":false},
{"tag_name":"v99.0.0","draft":false,"prerelease":false},
{"tag_name":"telemetry-v98.0.0"},
{"tag_name":"telemetry-v01.0.0","draft":false,"prerelease":false}
]`)
	}))
	defer server.Close()
	endpoint := server.URL + "/releases?per_page=100"
	got, err := check(context.Background(), "v1.9.10", endpoint, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if got.AvailableVersion != "v1.10.0" || !got.HasUpdate() {
		t.Fatalf("check result = %#v", got)
	}
}

func TestCheckNoUpdateForCurrentOrNewerInstalledAndSkipsInvalid(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		fmt.Fprint(w, `[{"tag_name":"telemetry-v2.0.0","draft":false,"prerelease":false}]`)
	}))
	defer server.Close()
	endpoint := server.URL + "/releases?per_page=100"
	for _, installed := range []string{"v2.0.0", "v3.0.0"} {
		got, err := check(context.Background(), installed, endpoint, server.Client())
		if err != nil || got.HasUpdate() || got.AvailableVersion != "" {
			t.Errorf("installed %q: result=%#v err=%v", installed, got, err)
		}
	}
	for _, installed := range []string{"dev", "", "v1.2.3-rc.1", "telemetry-v1.2.3"} {
		got, err := check(context.Background(), installed, endpoint, server.Client())
		if err != nil || got.HasUpdate() {
			t.Errorf("invalid installed %q: result=%#v err=%v", installed, got, err)
		}
	}
	if requests.Load() != 2 {
		t.Fatalf("requests=%d, want 2 (invalid installed versions skip network)", requests.Load())
	}
}

func TestCheckRejectsMalformedAndOversizedResponses(t *testing.T) {
	for name, body := range map[string]string{
		"malformed":     `[{"tag_name":`,
		"wrong-shape":   `{"tag_name":"telemetry-v9.0.0"}`,
		"trailing-data": `[] garbage`,
		"null":          `null`,
	} {
		t.Run(name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = ioWriteString(w, body) }))
			defer server.Close()
			if _, err := check(context.Background(), "v1.0.0", server.URL, server.Client()); err == nil {
				t.Fatal("malformed response unexpectedly succeeded")
			}
		})
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = ioWriteString(w, strings.Repeat(" ", MaxResponseBytes+1))
	}))
	defer server.Close()
	if _, err := check(context.Background(), "v1.0.0", server.URL, server.Client()); err == nil {
		t.Fatal("oversized response unexpectedly succeeded")
	}
}

func ioWriteString(w http.ResponseWriter, value string) (int, error) { return w.Write([]byte(value)) }

func TestCheckNetworkErrorTimeoutAndCancellation(t *testing.T) {
	if _, err := check(context.Background(), "v1.0.0", ReleasesAPIURL, &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) { return nil, errors.New("offline") })}); err == nil {
		t.Fatal("network error unexpectedly succeeded")
	}
	for _, mode := range []string{"timeout", "cancel"} {
		t.Run(mode, func(t *testing.T) {
			started := make(chan struct{})
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				close(started)
				<-r.Context().Done()
			}))
			defer server.Close()
			client := server.Client()
			ctx := context.Background()
			if mode == "timeout" {
				client.Timeout = 15 * time.Millisecond
			} else {
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				go func() { <-started; cancel() }()
			}
			if _, err := check(ctx, "v1.0.0", server.URL, client); err == nil {
				t.Fatal("bounded request unexpectedly succeeded")
			}
		})
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) { return f(request) }

func TestCheckDoesNotFollowRedirect(t *testing.T) {
	var destination atomic.Int32
	other := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { destination.Add(1) }))
	defer other.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, other.URL, http.StatusFound) }))
	defer server.Close()
	if _, err := check(context.Background(), "v1.0.0", server.URL, server.Client()); err == nil {
		t.Fatal("redirect response unexpectedly succeeded")
	}
	if destination.Load() != 0 {
		t.Fatal("followed redirect to another host")
	}
}
