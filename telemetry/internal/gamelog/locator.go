package gamelog

import (
	"io"
	"os"
	"regexp"
	"sort"
	"strings"
)

type DiscoveryStrategy string

const (
	StrategyLauncherLog    DiscoveryStrategy = "launcher_log"
	StrategyRunningProcess DiscoveryStrategy = "running_process"
	StrategyKnownLocation  DiscoveryStrategy = "known_location"
	StrategyRegistry       DiscoveryStrategy = "registry"
	StrategyManual         DiscoveryStrategy = "manual"
)

type AttemptOutcome string

const (
	OutcomeSelected    AttemptOutcome = "selected"
	OutcomeNotFound    AttemptOutcome = "not_found"
	OutcomeNotRegular  AttemptOutcome = "not_regular"
	OutcomeUnreadable  AttemptOutcome = "unreadable"
	OutcomeUnavailable AttemptOutcome = "unavailable"
	OutcomeNoCandidate AttemptOutcome = "no_candidate"
	OutcomeNotSupplied AttemptOutcome = "not_supplied"
)

type DiscoveryAttempt struct {
	Strategy  DiscoveryStrategy
	Candidate string
	Outcome   AttemptOutcome
	Detail    string
}

// LocateResult provides a selected path and local diagnostics for one discovery pass.
type LocateResult struct {
	Path                string
	Strategy            DiscoveryStrategy
	Attempts            []DiscoveryAttempt
	PlatformUnsupported bool
}

func (r LocateResult) Found() bool { return r.Path != "" }

// FileSystem keeps all host filesystem interaction replaceable in tests.
type FileSystem interface {
	ReadFile(string) ([]byte, error)
	ReadDir(string) ([]DirectoryEntry, error)
	IsRegular(string) (bool, error)
	OpenRead(string) (io.Closer, error)
}

type DirectoryEntry struct { Name string; IsDir bool }

// Config carries caller input and deliberately small test seams.
// ManualPath is evaluated fifth, after every automatic strategy.
type Config struct {
	ManualPath       string
	LauncherLogPaths []string
	KnownRoots       []string
	ProcessQuery     func() (string, error)
	RegistryRoots    func() ([]string, error)
	FileSystem       FileSystem
}

type Locator struct {
	platformSupported bool
	manualPath       string
	launcherLogPaths []string
	knownRoots       []string
	processQuery     func() (string, error)
	registryRoots    func() ([]string, error)
	fs               FileSystem
}

func NewLocator(config Config) *Locator {
	d := platformLocatorDefaults()
	if config.FileSystem != nil { d.fs = config.FileSystem }
	if len(config.LauncherLogPaths) != 0 { d.launcherLogPaths = config.LauncherLogPaths }
	if len(config.KnownRoots) != 0 { d.knownRoots = config.KnownRoots }
	if config.ProcessQuery != nil { d.processQuery = config.ProcessQuery }
	if config.RegistryRoots != nil { d.registryRoots = config.RegistryRoots }
	return &Locator{
		platformSupported: d.platformSupported || config.FileSystem != nil,
		manualPath:       config.ManualPath,
		launcherLogPaths: d.launcherLogPaths,
		knownRoots:       d.knownRoots,
		processQuery:     d.processQuery,
		registryRoots:    d.registryRoots,
		fs:               d.fs,
	}
}

// Locate uses the fixed Issue #8 strategy order. It never waits, polls, or writes.
func (l *Locator) Locate() LocateResult {
	r := LocateResult{}
	if !l.platformSupported {
		r.PlatformUnsupported = true
		l.add(&r, StrategyLauncherLog, "", OutcomeUnavailable, "Windows Game.log discovery is unsupported on this platform")
		return r
	}
	if l.fromLauncher(&r) || l.fromRunningProcess(&r) || l.fromKnownLocations(&r) || l.fromRegistry(&r) || l.fromManual(&r) { return r }
	return r
}

func (l *Locator) fromLauncher(r *LocateResult) bool {
	if len(l.launcherLogPaths) == 0 { l.add(r, StrategyLauncherLog, "", OutcomeUnavailable, "launcher log paths unavailable"); return false }
	for _, path := range l.launcherLogPaths {
		contents, err := l.fs.ReadFile(path)
		if err != nil { l.add(r, StrategyLauncherLog, path, OutcomeUnavailable, "launcher log unavailable"); continue }
		candidates := launcherGameLogCandidates(string(contents))
		if len(candidates) == 0 { l.add(r, StrategyLauncherLog, path, OutcomeNoCandidate, "no applicable launch entry"); continue }
		for _, candidate := range candidates { if l.selectCandidate(r, StrategyLauncherLog, candidate) { return true } }
	}
	return false
}

func (l *Locator) fromRunningProcess(r *LocateResult) bool {
	if l.processQuery == nil { l.add(r, StrategyRunningProcess, "", OutcomeUnavailable, "process query unavailable"); return false }
	output, err := l.processQuery()
	if err != nil { l.add(r, StrategyRunningProcess, "", OutcomeUnavailable, "process query failed"); return false }
	candidates := processGameLogCandidates(output)
	if len(candidates) == 0 { l.add(r, StrategyRunningProcess, "", OutcomeNoCandidate, "StarCitizen.exe not running"); return false }
	for _, candidate := range candidates { if l.selectCandidate(r, StrategyRunningProcess, candidate) { return true } }
	return false
}

func (l *Locator) fromKnownLocations(r *LocateResult) bool {
	if len(l.knownRoots) == 0 { l.add(r, StrategyKnownLocation, "", OutcomeUnavailable, "known installation roots unavailable"); return false }
	for _, root := range l.knownRoots {
		candidates := l.knownLocationCandidates(root)
		if len(candidates) == 0 { l.add(r, StrategyKnownLocation, root, OutcomeNoCandidate, "no channel directories found"); continue }
		for _, candidate := range candidates { if l.selectCandidate(r, StrategyKnownLocation, candidate) { return true } }
	}
	return false
}

func (l *Locator) fromRegistry(r *LocateResult) bool {
	if l.registryRoots == nil { l.add(r, StrategyRegistry, "", OutcomeUnavailable, "registry query unavailable"); return false }
	roots, err := l.registryRoots()
	if err != nil { l.add(r, StrategyRegistry, "", OutcomeUnavailable, "registry query failed"); return false }
	if len(roots) == 0 { l.add(r, StrategyRegistry, "", OutcomeNoCandidate, "RSI installation hint not found"); return false }
	for _, hint := range roots {
		for _, root := range registryStarCitizenRoots(hint) {
			for _, candidate := range l.knownLocationCandidates(root) { if l.selectCandidate(r, StrategyRegistry, candidate) { return true } }
		}
	}
	l.add(r, StrategyRegistry, "", OutcomeNoCandidate, "no readable Game.log under registry hints")
	return false
}

func (l *Locator) fromManual(r *LocateResult) bool {
	if strings.TrimSpace(l.manualPath) == "" { l.add(r, StrategyManual, "", OutcomeNotSupplied, "manual path not supplied"); return false }
	return l.selectCandidate(r, StrategyManual, l.manualPath)
}

func (l *Locator) selectCandidate(r *LocateResult, strategy DiscoveryStrategy, candidate string) bool {
	if !strings.EqualFold(windowsBase(candidate), "Game.log") {
		l.add(r, strategy, candidate, OutcomeNoCandidate, "candidate is not Game.log")
		return false
	}
	regular, err := l.fs.IsRegular(candidate)
	if err != nil { l.add(r, strategy, candidate, OutcomeNotFound, "candidate missing"); return false }
	if !regular { l.add(r, strategy, candidate, OutcomeNotRegular, "candidate is not a regular file"); return false }
	reader, err := l.fs.OpenRead(candidate)
	if err != nil { l.add(r, strategy, candidate, OutcomeUnreadable, "candidate cannot be opened read-only"); return false }
	// Successful read-only opening is the accessibility check. A close error does
	// not make an otherwise readable candidate unusable for this one-shot locator.
	_ = reader.Close()
	r.Path, r.Strategy = candidate, strategy
	l.add(r, strategy, candidate, OutcomeSelected, "readable regular Game.log")
	return true
}

func (l *Locator) knownLocationCandidates(root string) []string {
	channels := []string{"LIVE", "PTU", "EPTU"}
	if entries, err := l.fs.ReadDir(root); err == nil {
		extra := []string{}
		for _, entry := range entries { if entry.IsDir && !containsFold(channels, entry.Name) { extra = append(extra, entry.Name) } }
		sort.Slice(extra, func(i, j int) bool { return strings.ToUpper(extra[i]) < strings.ToUpper(extra[j]) })
		channels = append(channels, extra...)
	}
	paths := make([]string, 0, len(channels))
	for _, channel := range channels { paths = append(paths, gameLogInChannel(joinPath(root, channel))) }
	return uniquePaths(paths)
}

func (l *Locator) add(r *LocateResult, strategy DiscoveryStrategy, candidate string, outcome AttemptOutcome, detail string) {
	r.Attempts = append(r.Attempts, DiscoveryAttempt{strategy, candidate, outcome, detail})
}

var launcherLaunchPattern = regexp.MustCompile(`(?i)\[Launcher::launch\]\s+Launching Star Citizen\s+.+?\s+from\s+\(([^)]+)\)`)

func launcherGameLogCandidates(contents string) []string {
	lines := strings.Split(contents, "\n")
	paths := []string{}
	for i := len(lines)-1; i >= 0; i-- {
		match := launcherLaunchPattern.FindStringSubmatch(strings.TrimSpace(lines[i]))
		if len(match) == 2 && strings.TrimSpace(match[1]) != "" { paths = append(paths, gameLogInChannel(strings.TrimSpace(match[1]))) }
	}
	return uniquePaths(paths)
}

func processGameLogCandidates(output string) []string {
	paths := []string{}
	for _, line := range strings.Split(output, "\n") { if path, ok := gameLogFromExecutable(strings.TrimSpace(line)); ok { paths = append(paths, path) } }
	return uniquePaths(paths)
}

func gameLogFromExecutable(executable string) (string, bool) {
	if !strings.EqualFold(windowsBase(executable), "StarCitizen.exe") { return "", false }
	bin64 := windowsDir(executable)
	if !strings.EqualFold(windowsBase(bin64), "Bin64") { return "", false }
	channel := windowsDir(bin64)
	if channel == "" || channel == "." { return "", false }
	return gameLogInChannel(channel), true
}

func registryStarCitizenRoots(hint string) []string {
	hint = strings.Trim(strings.TrimSpace(hint), `"`)
	if hint == "" { return nil }
	return uniquePaths([]string{hint, joinPath(hint, "StarCitizen"), joinPath(windowsDir(hint), "StarCitizen")})
}

// registryInstallLocations accepts only the stable value name and type emitted
// by reg.exe. It intentionally ignores unrelated uninstall values and prose.
func registryInstallLocations(output string) []string {
	paths := []string{}
	for _, line := range strings.Split(output, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 || !strings.EqualFold(fields[0], "InstallLocation") || !strings.EqualFold(fields[1], "REG_SZ") {
			continue
		}
		path := strings.Trim(strings.Join(fields[2:], " "), `"`)
		if path != "" { paths = append(paths, path) }
	}
	return uniquePaths(paths)
}

func gameLogInChannel(channel string) string { return joinPath(channel, "Game.log") }
func joinPath(base, child string) string {
	base = strings.TrimRight(strings.TrimSpace(base), `\\/`)
	if base == "" { return child }
	separator := "/"; if strings.Contains(base, `\`) { separator = `\` }
	return base + separator + child
}
func windowsDir(value string) string {
	trimmed := strings.TrimRight(value, `\\/`); last := strings.LastIndexAny(trimmed, `\\/`)
	if last < 0 { return "." }
	if last == 2 && len(trimmed) >= 3 && trimmed[1] == ':' { return trimmed[:3] }
	return trimmed[:last]
}
func windowsBase(value string) string {
	trimmed := strings.TrimRight(value, `\\/`); last := strings.LastIndexAny(trimmed, `\\/`)
	if last < 0 { return trimmed }; return trimmed[last+1:]
}
func uniquePaths(paths []string) []string {
	seen, result := map[string]bool{}, []string{}
	for _, path := range paths { key := strings.ToUpper(path); if path != "" && !seen[key] { seen[key] = true; result = append(result, path) } }
	return result
}
func containsFold(values []string, target string) bool { for _, value := range values { if strings.EqualFold(value, target) { return true } }; return false }

type osFileSystem struct{}

const maxLauncherLogBytes = 4 * 1024 * 1024

// ReadFile keeps launcher-log parsing bounded. Discovery only needs the newest
// launch records, so oversized logs are read from their trailing window.
func (osFileSystem) ReadFile(path string) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil { return nil, err }
	defer file.Close()
	info, err := file.Stat()
	if err != nil { return nil, err }
	if info.Size() > maxLauncherLogBytes {
		if _, err := file.Seek(info.Size()-maxLauncherLogBytes, io.SeekStart); err != nil { return nil, err }
	}
	return io.ReadAll(io.LimitReader(file, maxLauncherLogBytes))
}
func (osFileSystem) ReadDir(path string) ([]DirectoryEntry, error) {
	entries, err := os.ReadDir(path); if err != nil { return nil, err }
	result := make([]DirectoryEntry, 0, len(entries)); for _, entry := range entries { result = append(result, DirectoryEntry{entry.Name(), entry.IsDir()}) }; return result, nil
}
func (osFileSystem) IsRegular(path string) (bool, error) { info, err := os.Stat(path); if err != nil { return false, err }; return info.Mode().IsRegular(), nil }
func (osFileSystem) OpenRead(path string) (io.Closer, error) { return os.Open(path) }

type locatorDefaults struct {
	platformSupported bool
	launcherLogPaths []string
	knownRoots       []string
	processQuery     func() (string, error)
	registryRoots    func() ([]string, error)
	fs               FileSystem
}
