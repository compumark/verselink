package regression

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/compumark/verselink-telemetry/internal/gamelog"
)

const (
	manifestFilename    = "manifest.json"
	maxManifestCases    = 32
	maxManifestFileSize = 256 * 1024
	maxCorpusFileSize   = 256 * 1024
)

type manifest struct {
	Version   int            `json:"version"`
	Synthetic bool           `json:"synthetic"`
	Cases     []manifestCase `json:"cases"`
}

type manifestCase struct {
	Name                string         `json:"name"`
	Path                string         `json:"path"`
	ExpectedEventCounts map[string]int `json:"expectedEventCounts"`
}

// CaseResult contains aggregate results only; raw Game.log lines are never
// retained by the regression runner.
type CaseResult struct {
	Name        string
	Path        string
	Lines       int
	Events      int
	EventCounts map[string]int
}

// Failure describes a manifest expectation mismatch without retaining the
// source line that produced it.
type Failure struct {
	Case     string
	Event    string
	Expected int
	Actual   int
	Reason   string
}

// Report is the reusable structured result of a complete corpus run.
type Report struct {
	Cases       []CaseResult
	Lines       int
	Events      int
	EventCounts map[string]int
	Failures    []Failure
}

// Run validates and executes only the cases explicitly listed in the corpus
// manifest. Infrastructure and schema problems are returned as errors;
// expectation mismatches are recorded in Report.Failures.
func Run(root string) (Report, error) {
	report := Report{EventCounts: map[string]int{}}
	root = filepath.Clean(root)

	manifestPath := filepath.Join(root, manifestFilename)
	manifestInfo, err := os.Stat(manifestPath)
	if err != nil {
		return report, fmt.Errorf("inspect regression manifest: %w", err)
	}
	if !manifestInfo.Mode().IsRegular() || manifestInfo.Size() > maxManifestFileSize {
		return report, fmt.Errorf("regression manifest must be a regular file no larger than %d bytes", maxManifestFileSize)
	}
	content, err := os.ReadFile(manifestPath)
	if err != nil {
		return report, fmt.Errorf("read regression manifest: %w", err)
	}
	var definition manifest
	if err := json.Unmarshal(content, &definition); err != nil {
		return report, fmt.Errorf("decode regression manifest: %w", err)
	}
	if err := validateManifest(definition, root); err != nil {
		return report, err
	}

	expectedCoverage := map[string]int{}
	for _, item := range definition.Cases {
		result, err := runCase(root, item)
		if err != nil {
			return report, err
		}
		report.Cases = append(report.Cases, result)
		report.Lines += result.Lines
		report.Events += result.Events
		mergeCounts(report.EventCounts, result.EventCounts)
		mergeCounts(expectedCoverage, item.ExpectedEventCounts)
		report.Failures = append(report.Failures, compareCounts(item.Name, item.ExpectedEventCounts, result.EventCounts)...)
	}
	report.Failures = append(report.Failures, validateP0Coverage(expectedCoverage)...)
	return report, nil
}

// Summary returns stable, concise output suitable for go test -v.
func (r Report) Summary() string {
	var builder strings.Builder
	fmt.Fprintf(&builder, "Regression corpus: cases=%d lines=%d events=%d failures=%d", len(r.Cases), r.Lines, r.Events, len(r.Failures))
	keys := sortedKeys(r.EventCounts)
	if len(keys) > 0 {
		builder.WriteByte('\n')
		for index, key := range keys {
			if index > 0 {
				builder.WriteByte(' ')
			}
			fmt.Fprintf(&builder, "%s=%d", key, r.EventCounts[key])
		}
	}
	return builder.String()
}

func validateManifest(definition manifest, root string) error {
	if definition.Version != 1 {
		return fmt.Errorf("invalid regression manifest version %d", definition.Version)
	}
	if !definition.Synthetic {
		return fmt.Errorf("regression manifest must declare synthetic=true")
	}
	if len(definition.Cases) == 0 || len(definition.Cases) > maxManifestCases {
		return fmt.Errorf("regression manifest cases must be between 1 and %d", maxManifestCases)
	}

	names := map[string]bool{}
	paths := map[string]bool{}
	for _, item := range definition.Cases {
		if strings.TrimSpace(item.Name) == "" || names[item.Name] {
			return fmt.Errorf("invalid or duplicate regression case name %q", item.Name)
		}
		names[item.Name] = true
		if item.ExpectedEventCounts == nil {
			return fmt.Errorf("regression case %q has no expectedEventCounts", item.Name)
		}
		for event, count := range item.ExpectedEventCounts {
			if strings.TrimSpace(event) == "" || count <= 0 {
				return fmt.Errorf("regression case %q has invalid expected count for %q", item.Name, event)
			}
		}
		clean, err := safeCorpusPath(root, item.Path)
		if err != nil {
			return fmt.Errorf("regression case %q: %w", item.Name, err)
		}
		if paths[clean] {
			return fmt.Errorf("regression case %q duplicates path %q", item.Name, item.Path)
		}
		paths[clean] = true
	}
	return nil
}

func safeCorpusPath(root, relative string) (string, error) {
	normalized := strings.ReplaceAll(relative, "\\", "/")
	parts := strings.Split(normalized, "/")
	if strings.TrimSpace(relative) == "" || filepath.IsAbs(relative) || strings.HasPrefix(normalized, "/") || strings.Contains(parts[0], ":") || filepath.Ext(normalized) != ".log" {
		return "", fmt.Errorf("unsafe corpus path %q", relative)
	}
	for _, part := range parts {
		if part == ".." {
			return "", fmt.Errorf("unsafe corpus path %q", relative)
		}
	}
	joined := filepath.Join(root, filepath.FromSlash(normalized))
	rel, err := filepath.Rel(root, joined)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("unsafe corpus path %q", relative)
	}
	return joined, nil
}

func runCase(root string, item manifestCase) (CaseResult, error) {
	result := CaseResult{Name: item.Name, Path: item.Path, EventCounts: map[string]int{}}
	path, err := safeCorpusPath(root, item.Path)
	if err != nil {
		return result, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return result, fmt.Errorf("inspect regression case %q: %w", item.Name, err)
	}
	if !info.Mode().IsRegular() {
		return result, fmt.Errorf("regression case %q is not a regular file", item.Name)
	}
	if info.Size() > maxCorpusFileSize {
		return result, fmt.Errorf("regression case %q exceeds %d bytes", item.Name, maxCorpusFileSize)
	}
	if err := ensureResolvedBelowRoot(root, path); err != nil {
		return result, fmt.Errorf("regression case %q: %w", item.Name, err)
	}

	file, err := os.Open(path)
	if err != nil {
		return result, fmt.Errorf("open regression case %q: %w", item.Name, err)
	}
	defer file.Close()

	parser := gamelog.NewParser()
	reader := bufio.NewReader(file)
	for {
		line, readErr := reader.ReadString('\n')
		if len(line) > 0 {
			if !strings.HasSuffix(line, "\n") {
				return result, fmt.Errorf("regression case %q has an unterminated final line", item.Name)
			}
			line = strings.TrimSuffix(line, "\n")
			line = strings.TrimSuffix(line, "\r")
			result.Lines++
			if event, ok := parser.Parse(line); ok {
				result.Events++
				result.EventCounts[event.Type]++
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return result, fmt.Errorf("read regression case %q: %w", item.Name, readErr)
		}
	}
	return result, nil
}

func ensureResolvedBelowRoot(root, path string) error {
	root, err := filepath.EvalSymlinks(root)
	if err != nil {
		return fmt.Errorf("resolve corpus root: %w", err)
	}
	path, err = filepath.EvalSymlinks(path)
	if err != nil {
		return fmt.Errorf("resolve corpus path: %w", err)
	}
	relative, err := filepath.Rel(root, path)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return fmt.Errorf("resolved corpus path escapes root")
	}
	return nil
}

func compareCounts(caseName string, expected, actual map[string]int) []Failure {
	keys := map[string]bool{}
	for event := range expected {
		keys[event] = true
	}
	for event := range actual {
		keys[event] = true
	}
	ordered := make([]string, 0, len(keys))
	for event := range keys {
		ordered = append(ordered, event)
	}
	sort.Strings(ordered)

	var failures []Failure
	for _, event := range ordered {
		if expected[event] == actual[event] {
			continue
		}
		reason := "event count differs"
		if expected[event] == 0 {
			reason = "unexpected event emitted"
		} else if actual[event] == 0 {
			reason = "expected event missing"
		}
		failures = append(failures, Failure{Case: caseName, Event: event, Expected: expected[event], Actual: actual[event], Reason: reason})
	}
	return failures
}

func validateP0Coverage(expected map[string]int) []Failure {
	var failures []Failure
	for _, contract := range gamelog.ApprovedEventContracts() {
		if contract.Presence && contract.Phase == "P0" && expected[contract.Name] == 0 {
			failures = append(failures, Failure{Case: "manifest", Event: contract.Name, Expected: 1, Actual: 0, Reason: "required P0 coverage missing"})
		}
	}
	sort.Slice(failures, func(i, j int) bool { return failures[i].Event < failures[j].Event })
	return failures
}

func mergeCounts(target, source map[string]int) {
	for event, count := range source {
		target[event] += count
	}
}

func sortedKeys(counts map[string]int) []string {
	keys := make([]string, 0, len(counts))
	for key := range counts {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
