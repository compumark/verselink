package gamelog

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
)

type expectedFixture struct {
	Event        string            `json:"event"`
	Path         string            `json:"path"`
	ShouldMatch  bool              `json:"shouldMatch"`
	ExpectedData map[string]string `json:"expectedData"`
}

func eventsRoot(t *testing.T) string {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("could not locate contract test")
	}
	return filepath.Join(filepath.Dir(file), "..", "..", "testdata", "events")
}

func TestApprovedContractsCoverMilestoneA(t *testing.T) {
	contracts := ApprovedEventContracts()
	if len(contracts) != 15 {
		t.Fatalf("contract count = %d, want 15", len(contracts))
	}
	names := make(map[string]bool, len(contracts))
	presenceCount := 0
	for _, contract := range contracts {
		if names[contract.Name] {
			t.Fatalf("duplicate contract %q", contract.Name)
		}
		names[contract.Name] = true
		if contract.Positive.Path == "" || !contract.Positive.ShouldMatch {
			t.Fatalf("%s has no positive fixture", contract.Name)
		}
		if len(contract.Negative) == 0 {
			t.Fatalf("%s has no negative fixture", contract.Name)
		}
		if contract.Presence && contract.Phase != "P0" {
			t.Fatalf("presence event %s has phase %q", contract.Name, contract.Phase)
		}
		if contract.Presence {
			presenceCount++
		}
		if !contract.Presence && contract.Phase != "P1" {
			t.Fatalf("reference event %s has phase %q", contract.Name, contract.Phase)
		}
	}
	if presenceCount != 13 {
		t.Fatalf("presence contract count = %d, want 13", presenceCount)
	}
	for _, name := range []string{"player_login", "server_joined", "player_spawned", "location_change", "jurisdiction_entered", "ship_boarded", "ship_exited", "qt_target_selected", "qt_fuel_requested", "qt_arrived", "party_member_joined", "party_member_left", "party_disbanded"} {
		if !names[name] {
			t.Fatalf("missing presence contract %q", name)
		}
	}
	for _, name := range []string{"blueprint_received", "refinery_complete"} {
		if !names[name] {
			t.Fatalf("missing reference contract %q", name)
		}
	}
}

func TestFixtureCatalogueMatchesContracts(t *testing.T) {
	root := eventsRoot(t)
	data, err := os.ReadFile(filepath.Join(root, "expectations.json"))
	if err != nil {
		t.Fatal(err)
	}
	var expectations []expectedFixture
	if err := json.Unmarshal(data, &expectations); err != nil {
		t.Fatal(err)
	}
	byPath := make(map[string]expectedFixture, len(expectations))
	for _, expected := range expectations {
		if expected.Path == "" || byPath[expected.Path].Path != "" {
			t.Fatalf("invalid or duplicate expectation path %q", expected.Path)
		}
		byPath[expected.Path] = expected
	}
	seen := make(map[string]bool)
	for _, contract := range ApprovedEventContracts() {
		cases := append([]FixtureCase{contract.Positive}, contract.Negative...)
		for _, fixture := range cases {
			if !strings.HasSuffix(fixture.Path, ".log") {
				t.Fatalf("%s fixture is not a .log file: %s", contract.Name, fixture.Path)
			}
			content, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(fixture.Path)))
			if err != nil {
				t.Fatalf("%s: %v", fixture.Path, err)
			}
			if strings.TrimSpace(string(content)) == "" {
				t.Fatalf("empty fixture %s", fixture.Path)
			}
			expected, ok := byPath[fixture.Path]
			if !ok || expected.Event != contract.Name || expected.ShouldMatch != fixture.ShouldMatch {
				t.Fatalf("expectation mismatch for %s", fixture.Path)
			}
			seen[fixture.Path] = true
			if fixture.ShouldMatch && expected.ExpectedData == nil {
				t.Fatalf("positive fixture %s has no expectedData", fixture.Path)
			}
			if fixture.ShouldMatch {
				declared := make(map[string]bool, len(contract.ExpectedFields))
				for _, field := range contract.ExpectedFields {
					declared[field] = true
					if _, ok := expected.ExpectedData[field]; !ok {
						t.Fatalf("positive fixture %s is missing expected field %q", fixture.Path, field)
					}
				}
				for field := range expected.ExpectedData {
					if !declared[field] {
						t.Fatalf("positive fixture %s declares unexpected field %q", fixture.Path, field)
					}
				}
			}
		}
		if contract.RequiresMultiple {
			lines, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(contract.Positive.Path)))
			if err != nil {
				t.Fatal(err)
			}
			if len(strings.Split(strings.TrimRight(string(lines), "\r\n"), "\n")) < 2 {
				t.Fatalf("%s positive fixture must contain ordered multiple lines", contract.Name)
			}
		}
	}
	if len(seen) != len(expectations) {
		paths := make([]string, 0)
		for _, expected := range expectations {
			if !seen[expected.Path] {
				paths = append(paths, expected.Path)
			}
		}
		sort.Strings(paths)
		t.Fatalf("expectations contain unreferenced fixtures: %s", strings.Join(paths, ", "))
	}
}
