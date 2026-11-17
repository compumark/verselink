package locationcatalog

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestResolveRequiresExactVerifiedKeyAndNeverInfersPyroJurisdiction(t *testing.T) {
	catalog := Catalog{Schema: 1, Version: 4, TTLSeconds: 86400, Entries: []Entry{{LocationRaw: "Pyro4_Outpost_col_m_scrp_indy_001", DisplayName: "Ruin Station", SystemName: "Pyro", Affiliation: "Headhunters", MatchType: "manual", Status: "verified"}}}
	got := Resolve(catalog, "Pyro4_Outpost_col_m_scrp_indy_001", "UEE")
	if got.Place != "Ruin Station" || got.System != "Pyro" || got.Jurisdiction != "Unknown" || got.Affiliation != "Headhunters" {
		t.Fatalf("Pyro resolution = %#v", got)
	}
	unknown := Resolve(catalog, "pyro4_outpost_col_m_scrp_indy_001", "UEE")
	if unknown.Place != "pyro4_outpost_col_m_scrp_indy_001" || unknown.Jurisdiction != "Unknown" || unknown.Status != "unknown" {
		t.Fatalf("non-exact resolution = %#v", unknown)
	}
	conflict := Catalog{Schema: 1, Version: 4, TTLSeconds: 86400, Entries: []Entry{{LocationRaw: "RR_P5_L2", DisplayName: "Ruin Station", SystemName: "Pyro", Jurisdiction: "Pyro Free Peoples", MatchType: "manual", Status: "verified"}}}
	if got := Resolve(conflict, "RR_P5_L2", "UEE"); got.Jurisdiction != "Unknown" || got.Status != "conflict" {
		t.Fatalf("conflicting jurisdiction = %#v", got)
	}
}

func TestCatalogValidationAndCacheTTLVersionUpdate(t *testing.T) {
	now := time.Date(2026, 10, 2, 12, 0, 0, 0, time.UTC)
	first := CacheFile{ETag: `"v1"`, FetchedAt: now, Catalog: Catalog{Schema: 1, Version: 1, TTLSeconds: 60, Entries: []Entry{}}}
	if !first.ValidAt(now.Add(59*time.Second)) || first.ValidAt(now.Add(time.Minute)) {
		t.Fatal("cache TTL was not enforced")
	}
	second := first
	second.Catalog.Version = 2
	if _, err := Validate(second.Catalog); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "location-catalog.json")
	store := Store{Path: path}
	if err := store.Save(second); err != nil {
		t.Fatal(err)
	}
	got, ok := store.Load(now.Add(time.Second))
	if !ok || got.Catalog.Version != 2 {
		t.Fatalf("cache load = %#v, %v", got, ok)
	}
	if info, err := os.Stat(path); err != nil {
		t.Fatalf("cache stat = %v, %v", info, err)
	} else if runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0 {
		t.Fatalf("cache permissions = %v", info.Mode().Perm())
	}
	if _, ok := store.Load(now.Add(time.Minute)); ok {
		t.Fatal("expired cache accepted")
	}
}

func TestCatalogRejectsDuplicateKeysAndUnverifiedRows(t *testing.T) {
	base := Entry{LocationRaw: "raw", DisplayName: "place", MatchType: "exact", Status: "verified"}
	for _, entries := range [][]Entry{{base, base}, {{LocationRaw: "raw", DisplayName: "guess", MatchType: "suggestion", Status: "suggested"}}} {
		if _, err := Validate(Catalog{Schema: 1, Version: 1, TTLSeconds: 60, Entries: entries}); err == nil {
			t.Fatal("invalid catalog accepted")
		}
	}
}
