package connection

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/compumark/verselink-telemetry/internal/locationcatalog"
)

func catalogJSON(version int) string {
	return fmt.Sprintf(`{"schema":1,"version":%d,"generated_at":"2026-10-02T12:00:00Z","ttl_seconds":86400,"entries":[{"location_raw":"Pyro4_Outpost_col_m_scrp_indy_001","display_name":"Ruin Station","system_name":"Pyro","parent_name":"Pyro IV","jurisdiction":null,"affiliation":"Headhunters","source":"admin","match_type":"manual","status":"verified"}]}`, version)
}

func TestGetLocationCatalogDownloadsBoundedBearerOnlyVersionedBundle(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/telemetry/v1/location-catalog" || r.URL.RawQuery != "" {
			t.Errorf("request target = %s %s", r.Method, r.URL)
		}
		if r.Header.Get("Authorization") != "Bearer "+testDeviceCredential || r.Header.Get("Cookie") != "" || r.Header.Get("Content-Length") != "" {
			t.Error("catalog request included unexpected credential transport or body")
		}
		if r.Header.Get("If-None-Match") != `"old"` {
			t.Errorf("If-None-Match = %q", r.Header.Get("If-None-Match"))
		}
		w.Header().Set("ETag", `"catalog-v2"`)
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, catalogJSON(2))
	}))
	defer server.Close()
	credential := []byte(testDeviceCredential)
	got, err := (Client{BaseURL: server.URL, AllowHTTP: true, HTTP: server.Client()}).GetLocationCatalog(context.Background(), credential, `"old"`)
	if err != nil {
		t.Fatal(err)
	}
	if got.Catalog.Version != 2 || got.ETag != `"catalog-v2"` || len(got.Catalog.Entries) != 1 {
		t.Fatalf("catalog result = %#v", got)
	}
	if strings.Contains(string(credential), "vlt_") {
		t.Fatal("credential bytes were not cleared")
	}
	resolved := locationcatalog.Resolve(got.Catalog, "Pyro4_Outpost_col_m_scrp_indy_001", "UEE")
	if resolved.Place != "Ruin Station" || resolved.System != "Pyro" || resolved.Jurisdiction != "Unknown" {
		t.Fatalf("resolved Pyro = %#v", resolved)
	}
}

func TestGetLocationCatalogSupportsETagNotModified(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("If-None-Match") != `"catalog-v1"` {
			t.Errorf("If-None-Match = %q", r.Header.Get("If-None-Match"))
		}
		w.Header().Set("ETag", `"catalog-v1"`)
		w.WriteHeader(http.StatusNotModified)
	}))
	defer server.Close()
	got, err := (Client{BaseURL: server.URL, AllowHTTP: true, HTTP: server.Client()}).GetLocationCatalog(context.Background(), []byte(testDeviceCredential), `"catalog-v1"`)
	if err != nil || !got.NotModified || got.ETag != `"catalog-v1"` {
		t.Fatalf("not-modified result = %#v, %v", got, err)
	}
}

func TestGetLocationCatalogFailsClosedOnUnknownSchemaOrServerOutage(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		body   string
		want   error
	}{
		{"unsupported shape", http.StatusOK, `{"schema":2}`, ErrInvalidResponse},
		{"server unavailable", http.StatusServiceUnavailable, `{"error":"server_unavailable"}`, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(tc.status); fmt.Fprint(w, tc.body) }))
			defer server.Close()
			_, err := (Client{BaseURL: server.URL, AllowHTTP: true, HTTP: server.Client()}).GetLocationCatalog(context.Background(), []byte(testDeviceCredential), "")
			if tc.want != nil && !errors.Is(err, tc.want) {
				t.Fatalf("error = %v, want %v", err, tc.want)
			}
			if tc.want == nil {
				var apiErr *APIError
				if !errors.As(err, &apiErr) || apiErr.Code != "server_unavailable" {
					t.Fatalf("error = %v, want server-unavailable API error", err)
				}
			}
		})
	}
}

type locationCatalogObserver struct {
	catalog locationcatalog.Catalog
	status  string
	calls   int
	cancel  context.CancelFunc
}

func (o *locationCatalogObserver) OnLocationCatalog(c locationcatalog.Catalog, status string) {
	o.catalog, o.status = c, status
	o.calls++
	if (status == "available" || status == "unavailable" || status == "server_unavailable") && o.cancel != nil {
		o.cancel()
	}
}

func TestLocationCatalogMonitorRefreshesCacheAndKeepsHeartbeatSeparate(t *testing.T) {
	var gotPath, gotETag string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotETag = r.URL.Path, r.Header.Get("If-None-Match")
		if r.Method != http.MethodGet || r.URL.Path != "/api/telemetry/v1/location-catalog" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL)
		}
		w.Header().Set("ETag", `"catalog-v1"`)
		w.WriteHeader(http.StatusNotModified)
	}))
	defer server.Close()
	path := filepath.Join(t.TempDir(), "location-catalog.json")
	cache := locationcatalog.Store{Path: path}
	now := time.Now().UTC().Add(-time.Minute)
	old := locationcatalog.CacheFile{ServerURL: server.URL, ETag: `"catalog-v1"`, FetchedAt: now, Catalog: locationcatalog.Catalog{Schema: 1, Version: 1, TTLSeconds: 86400, Entries: []locationcatalog.Entry{{LocationRaw: "RR_P5_L2", DisplayName: "Ruin Station", SystemName: "Pyro", MatchType: "manual", Status: "verified"}}}}
	if err := cache.Save(old); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	observer := &locationCatalogObserver{cancel: cancel}
	monitor := LocationCatalogMonitor{Client: Client{HTTP: server.Client()}, Credentials: &memoryCredentialStore{value: []byte(testDeviceCredential)}, Cache: cache}
	monitor.Run(ctx, LocationCatalogConfig{BaseURL: server.URL, DeviceID: "device-1", AllowHTTP: true}, nil, observer)
	defer cancel()
	if observer.status != "available" || observer.catalog.Version != 1 || observer.calls != 2 {
		t.Fatalf("observer = %#v", observer)
	}
	if gotPath != "/api/telemetry/v1/location-catalog" || gotETag != `"catalog-v1"` {
		t.Fatalf("catalog request path/etag = %q / %q", gotPath, gotETag)
	}
	refreshed, ok := cache.Load(time.Now().UTC())
	if !ok || refreshed.FetchedAt.Equal(now) {
		t.Fatal("not-modified response did not renew bounded cache TTL")
	}
}

func TestLocationCatalogMonitorOutageFallsBackToRawOnlyWhenCacheExpired(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		fmt.Fprint(w, `{"error":"server_unavailable"}`)
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	observer := &locationCatalogObserver{cancel: cancel}
	monitor := LocationCatalogMonitor{Client: Client{HTTP: server.Client()}, Credentials: &memoryCredentialStore{value: []byte(testDeviceCredential)}, Cache: locationcatalog.Store{Path: filepath.Join(t.TempDir(), "missing.json")}}
	monitor.Run(ctx, LocationCatalogConfig{BaseURL: server.URL, DeviceID: "device-1", AllowHTTP: true}, nil, observer)
	defer cancel()
	if observer.status != "server_unavailable" || len(observer.catalog.Entries) != 0 {
		t.Fatalf("outage observer = %#v", observer)
	}
	got := locationcatalog.Resolve(observer.catalog, "Pyro5a_Outpost_col_m_trdpst_otlw_001", "UEE")
	if got.Place != "Pyro5a_Outpost_col_m_trdpst_otlw_001" || got.Jurisdiction != "Unknown" {
		t.Fatalf("outage fallback = %#v", got)
	}
}
