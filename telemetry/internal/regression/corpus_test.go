package regression

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/compumark/verselink-telemetry/internal/gamelog"
	"github.com/compumark/verselink-telemetry/internal/telemetry"
)

func corpusRoot() string {
	return filepath.Join("..", "..", "testdata", "regression")
}

func TestRegressionCorpus(t *testing.T) {
	report, err := Run(corpusRoot())
	if err != nil {
		t.Fatal(err)
	}
	t.Log(report.Summary())
	if len(report.Failures) > 0 {
		for _, failure := range report.Failures {
			t.Errorf("case=%s event=%s expected=%d actual=%d reason=%s", failure.Case, failure.Event, failure.Expected, failure.Actual, failure.Reason)
		}
	}
	if len(report.Cases) != 4 || report.Lines != 42 || report.Events != 25 {
		t.Fatalf("aggregate report = %#v", report)
	}
	full := findCase(t, report, "p0-full-session")
	if full.Lines != 15 || full.Events != 13 || len(full.EventCounts) != 13 {
		t.Fatalf("p0-full-session = %#v", full)
	}
	for event, count := range full.EventCounts {
		if count != 1 {
			t.Errorf("p0-full-session %s count = %d, want 1", event, count)
		}
	}
	noise := findCase(t, report, "noise-near-miss")
	if noise.Lines != 8 || noise.Events != 0 || len(noise.EventCounts) != 0 {
		t.Fatalf("noise-near-miss = %#v", noise)
	}

	wantP0 := map[string]bool{}
	for _, contract := range gamelog.ApprovedEventContracts() {
		if contract.Presence && contract.Phase == "P0" {
			wantP0[contract.Name] = true
		}
	}
	if len(wantP0) != 13 {
		t.Fatalf("approved P0 contracts = %d, want 13", len(wantP0))
	}
	for event := range wantP0 {
		if report.EventCounts[event] == 0 {
			t.Errorf("P0 event %q has no corpus coverage", event)
		}
	}
	if report.EventCounts["blueprint_received"] != 0 || report.EventCounts["refinery_complete"] != 0 {
		t.Fatalf("reference-only event was parsed: %#v", report.EventCounts)
	}
}

func TestManifestContainsExactlyReviewedCorpusFiles(t *testing.T) {
	content, err := os.ReadFile(filepath.Join(corpusRoot(), manifestFilename))
	if err != nil {
		t.Fatal(err)
	}
	var definition manifest
	if err := json.Unmarshal(content, &definition); err != nil {
		t.Fatal(err)
	}
	if !definition.Synthetic {
		t.Fatal("manifest must declare synthetic=true")
	}
	var got []string
	for _, item := range definition.Cases {
		got = append(got, item.Path)
	}
	sort.Strings(got)
	want := []string{"noise-near-miss.log", "p0-full-session.log", "party-state.log", "session-rollover.log"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("manifest paths = %q, want %q", got, want)
	}
}

func TestGitignoreAllowlistIsExact(t *testing.T) {
	content, err := os.ReadFile(filepath.Join("..", "..", "..", ".gitignore"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(content)
	if strings.Contains(text, "!telemetry/testdata/regression/**/*.log") {
		t.Fatal("regression corpus uses a broad .log exception")
	}
	want := []string{
		"!telemetry/testdata/regression/p0-full-session.log",
		"!telemetry/testdata/regression/session-rollover.log",
		"!telemetry/testdata/regression/party-state.log",
		"!telemetry/testdata/regression/noise-near-miss.log",
	}
	for _, entry := range want {
		if strings.Count(text, entry) != 1 {
			t.Errorf("gitignore entry %q count = %d, want 1", entry, strings.Count(text, entry))
		}
	}
}

func TestRegressionCorpusRestoresExpectedCurrentState(t *testing.T) {
	fixture := filepath.Join(corpusRoot(), "p0-full-session.log")
	content, err := os.ReadFile(fixture)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "Game.log")
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}

	session, info, err := gamelog.NewSession(gamelog.SessionConfig{Path: path})
	if err != nil {
		t.Fatal(err)
	}
	state := session.Snapshot()
	if !info.BoundaryFound || info.ReplayedLines != 15 {
		t.Fatalf("restore info = %#v", info)
	}
	if !state.SessionActive || state.PlayerHandle != "TestPilot" || state.Shard != "pub_test_shard_001" || state.Jurisdiction != "Stanton" {
		t.Fatalf("session state = %#v", state)
	}
	if state.Location == nil || state.Location.Raw != "RR_CRU_L1" || !state.Location.ObservedAt.Equal(mustTime(t, "2026-09-22T12:00:03Z")) {
		t.Fatalf("location = %#v", state.Location)
	}
	if state.Ship != nil {
		t.Fatalf("ship = %#v, want nil after ship_exited", state.Ship)
	}
	if state.Quantum == nil || state.Quantum.Destination != "ARC-L1" || state.Quantum.State != telemetry.QuantumStateArrived {
		t.Fatalf("quantum = %#v", state.Quantum)
	}
	if state.Party == nil || len(state.Party) != 0 {
		t.Fatalf("party = %#v, want non-nil empty", state.Party)
	}
	if !state.LastEventAt.Equal(mustTime(t, "2026-09-22T12:00:14Z")) {
		t.Fatalf("LastEventAt = %s", state.LastEventAt)
	}
	diagnostics := session.Diagnostics()
	if diagnostics.LinesProcessed != 15 || diagnostics.ParserEventCount != 13 || diagnostics.SourceResetCount != 0 {
		t.Fatalf("diagnostics = %#v", diagnostics)
	}
}

func TestRegressionCorpusSessionRolloverRestoresFinalSessionOnly(t *testing.T) {
	content, err := os.ReadFile(filepath.Join(corpusRoot(), "session-rollover.log"))
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "Game.log")
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
	session, info, err := gamelog.NewSession(gamelog.SessionConfig{Path: path})
	if err != nil {
		t.Fatal(err)
	}
	state := session.Snapshot()
	if info.ReplayedLines != 4 || state.PlayerHandle != "CurrentPilot" || state.Shard != "pub_test_shard_001" || !state.SessionActive || state.Location == nil || state.Location.Raw != "CURRENT_LOCATION" {
		t.Fatalf("info = %#v, state = %#v", info, state)
	}
	diagnostics := session.Diagnostics()
	if diagnostics.LinesProcessed != 4 || diagnostics.ParserEventCount != 4 {
		t.Fatalf("pre-boundary lines were counted: %#v", diagnostics)
	}
}

func TestRunRejectsUnsafeOrUnsanitizedManifest(t *testing.T) {
	for _, test := range []struct {
		name     string
		manifest string
		want     string
	}{
		{"missing synthetic marker", `{"version":1,"cases":[{"name":"case","path":"case.log","expectedEventCounts":{}}]}`, "synthetic=true"},
		{"path traversal", `{"version":1,"synthetic":true,"cases":[{"name":"case","path":"../case.log","expectedEventCounts":{}}]}`, "unsafe corpus path"},
		{"nested path traversal", `{"version":1,"synthetic":true,"cases":[{"name":"case","path":"../../Game.log","expectedEventCounts":{}}]}`, "unsafe corpus path"},
		{"absolute path", `{"version":1,"synthetic":true,"cases":[{"name":"case","path":"C:/private/Game.log","expectedEventCounts":{}}]}`, "unsafe corpus path"},
		{"Windows absolute path", `{"version":1,"synthetic":true,"cases":[{"name":"case","path":"C:\\Users\\Test\\Game.log","expectedEventCounts":{}}]}`, "unsafe corpus path"},
		{"Unix absolute path", `{"version":1,"synthetic":true,"cases":[{"name":"case","path":"/var/log/Game.log","expectedEventCounts":{}}]}`, "unsafe corpus path"},
		{"wrong extension", `{"version":1,"synthetic":true,"cases":[{"name":"case","path":"case.txt","expectedEventCounts":{}}]}`, "unsafe corpus path"},
		{"explicit zero count", `{"version":1,"synthetic":true,"cases":[{"name":"case","path":"case.log","expectedEventCounts":{"player_login":0}}]}`, "invalid expected count"},
	} {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			if err := os.WriteFile(filepath.Join(root, manifestFilename), []byte(test.manifest), 0o600); err != nil {
				t.Fatal(err)
			}
			_, err := Run(root)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("error = %v, want containing %q", err, test.want)
			}
		})
	}
}

func TestRunRejectsTooManyManifestCases(t *testing.T) {
	root := t.TempDir()
	definition := manifest{Version: 1, Synthetic: true}
	for index := 0; index <= maxManifestCases; index++ {
		definition.Cases = append(definition.Cases, manifestCase{Name: fmt.Sprintf("case-%d", index), Path: fmt.Sprintf("case-%d.log", index), ExpectedEventCounts: map[string]int{}})
	}
	writeManifest(t, root, definition)
	_, err := Run(root)
	if err == nil || !strings.Contains(err.Error(), "between 1 and 32") {
		t.Fatalf("error = %v", err)
	}
}

func TestRunRejectsUnterminatedAndOversizedCorpus(t *testing.T) {
	t.Run("unterminated final line", func(t *testing.T) {
		root := makeSingleCaseCorpus(t, "noise without newline")
		_, err := Run(root)
		if err == nil || !strings.Contains(err.Error(), "unterminated final line") {
			t.Fatalf("error = %v", err)
		}
	})

	t.Run("oversized file", func(t *testing.T) {
		root := makeSingleCaseCorpus(t, strings.Repeat("x", maxCorpusFileSize)+"\n")
		_, err := Run(root)
		if err == nil || !strings.Contains(err.Error(), "exceeds") {
			t.Fatalf("error = %v", err)
		}
	})
}

func TestRunSupportsCompleteLinesBeyondScannerLimit(t *testing.T) {
	root := t.TempDir()
	definition := manifest{Version: 1, Synthetic: true, Cases: []manifestCase{{Name: "long-line", Path: "long-line.log", ExpectedEventCounts: map[string]int{}}}}
	writeManifest(t, root, definition)
	if err := os.WriteFile(filepath.Join(root, "long-line.log"), []byte(strings.Repeat("x", 70*1024)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	report, err := Run(root)
	if err != nil {
		t.Fatal(err)
	}
	result := findCase(t, report, "long-line")
	if result.Lines != 1 || result.Events != 0 {
		t.Fatalf("long-line result = %#v", result)
	}
}

func TestRunUsesFreshParserForEveryCase(t *testing.T) {
	root := t.TempDir()
	definition := manifest{Version: 1, Synthetic: true, Cases: []manifestCase{
		{Name: "header", Path: "header.log", ExpectedEventCounts: map[string]int{}},
		{Name: "continuation", Path: "continuation.log", ExpectedEventCounts: map[string]int{}},
	}}
	writeManifest(t, root, definition)
	if err := os.WriteFile(filepath.Join(root, "header.log"), []byte(`<2026-09-22T12:00:00Z> Added notification "New Member Joined`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "continuation.log"), []byte(`<2026-09-22T12:00:01Z> CrewMate has joined the party.`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	report, err := Run(root)
	if err != nil {
		t.Fatal(err)
	}
	if findCase(t, report, "header").Events != 0 || findCase(t, report, "continuation").Events != 0 {
		t.Fatalf("Party pending state crossed cases: %#v", report.Cases)
	}
}

func TestRunReportsExpectationMismatchWithoutRawContent(t *testing.T) {
	root := t.TempDir()
	expected := allP0Counts()
	definition := manifest{Version: 1, Synthetic: true, Cases: []manifestCase{{Name: "mismatch", Path: "case.log", ExpectedEventCounts: expected}}}
	writeManifest(t, root, definition)
	raw := `<2026-09-22T12:00:00Z> [Notice] nickname="TestPilot" playerGEID=123456789` + "\n"
	if err := os.WriteFile(filepath.Join(root, "case.log"), []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	report, err := Run(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Failures) != 12 {
		t.Fatalf("failures = %#v", report.Failures)
	}
	if strings.Contains(report.Summary(), "nickname") || strings.Contains(report.Summary(), "playerGEID") || strings.Contains(strings.TrimSpace(failureText(report.Failures)), "nickname") {
		t.Fatal("report retained raw Game.log content")
	}
}

func TestRunDetectsMissingUnexpectedAndCountMismatch(t *testing.T) {
	root := t.TempDir()
	definition := manifest{Version: 1, Synthetic: true, Cases: []manifestCase{{
		Name: "mismatch", Path: "case.log", ExpectedEventCounts: map[string]int{"player_login": 2, "player_spawned": 1},
	}}}
	writeManifest(t, root, definition)
	content := strings.Join([]string{
		`<2026-09-22T12:00:00Z> nickname="TestPilot" playerGEID=123456789`,
		`<2026-09-22T12:00:01Z> Added notification "You have joined channel '@vehicle_NameRSI_Hermes : TestOwner'.`,
	}, "\n") + "\n"
	if err := os.WriteFile(filepath.Join(root, "case.log"), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	report, err := Run(root)
	if err != nil {
		t.Fatalf("expectation mismatch returned infrastructure error: %v", err)
	}
	for _, want := range []Failure{
		{Case: "mismatch", Event: "player_login", Expected: 2, Actual: 1, Reason: "event count differs"},
		{Case: "mismatch", Event: "player_spawned", Expected: 1, Actual: 0, Reason: "expected event missing"},
		{Case: "mismatch", Event: "ship_boarded", Expected: 0, Actual: 1, Reason: "unexpected event emitted"},
	} {
		if !containsFailure(report.Failures, want) {
			t.Errorf("missing failure %#v in %#v", want, report.Failures)
		}
	}
}

func TestRunReadsOnlyManifestListedFiles(t *testing.T) {
	root := makeSingleCaseCorpus(t, "unrecognized noise\n")
	if err := os.WriteFile(filepath.Join(root, "unlisted.log"), []byte("unterminated private content"), 0o600); err != nil {
		t.Fatal(err)
	}
	report, err := Run(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Cases) != 1 || report.Cases[0].Path != "case.log" {
		t.Fatalf("cases = %#v", report.Cases)
	}
}

func TestSummaryIsDeterministic(t *testing.T) {
	report := Report{Cases: []CaseResult{{}, {}}, Lines: 3, Events: 2, EventCounts: map[string]int{"z_event": 1, "a_event": 1}}
	want := "Regression corpus: cases=2 lines=3 events=2 failures=0\na_event=1 z_event=1"
	if got := report.Summary(); got != want {
		t.Fatalf("Summary() = %q, want %q", got, want)
	}
	for index := 0; index < 10; index++ {
		if got := report.Summary(); got != want {
			t.Fatalf("Summary() run %d = %q, want %q", index, got, want)
		}
	}
}

func findCase(t *testing.T, report Report, name string) CaseResult {
	t.Helper()
	for _, result := range report.Cases {
		if result.Name == name {
			return result
		}
	}
	t.Fatalf("case %q not found in %#v", name, report.Cases)
	return CaseResult{}
}

func containsFailure(failures []Failure, want Failure) bool {
	for _, failure := range failures {
		if failure == want {
			return true
		}
	}
	return false
}

func makeSingleCaseCorpus(t *testing.T, content string) string {
	t.Helper()
	root := t.TempDir()
	definition := manifest{Version: 1, Synthetic: true, Cases: []manifestCase{{Name: "case", Path: "case.log", ExpectedEventCounts: allP0Counts()}}}
	writeManifest(t, root, definition)
	if err := os.WriteFile(filepath.Join(root, "case.log"), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return root
}

func writeManifest(t *testing.T, root string, definition manifest) {
	t.Helper()
	content, err := json.Marshal(definition)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, manifestFilename), content, 0o600); err != nil {
		t.Fatal(err)
	}
}

func allP0Counts() map[string]int {
	counts := map[string]int{}
	for _, contract := range gamelog.ApprovedEventContracts() {
		if contract.Presence && contract.Phase == "P0" {
			counts[contract.Name] = 1
		}
	}
	return counts
}

func failureText(failures []Failure) string {
	var builder strings.Builder
	for _, failure := range failures {
		builder.WriteString(failure.Case)
		builder.WriteString(failure.Event)
		builder.WriteString(failure.Reason)
	}
	return builder.String()
}

func mustTime(t *testing.T, value string) time.Time {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}
