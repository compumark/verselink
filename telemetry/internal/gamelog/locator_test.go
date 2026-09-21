package gamelog

import (
	"errors"
	"io"
	"strings"
	"testing"
)

type fakeNode struct {
	exists   bool
	regular  bool
	readable bool
	closeFails bool
	contents string
}

type closeErrorCloser struct{ io.ReadCloser }

func (closeErrorCloser) Close() error { return errors.New("close failed") }

type fakeFileSystem struct {
	nodes map[string]fakeNode
	dirs  map[string][]DirectoryEntry
}

func (f fakeFileSystem) ReadFile(path string) ([]byte, error) {
	node, ok := f.nodes[path]
	if !ok || !node.exists { return nil, errors.New("missing") }
	return []byte(node.contents), nil
}
func (f fakeFileSystem) ReadDir(path string) ([]DirectoryEntry, error) {
	entries, ok := f.dirs[path]
	if !ok { return nil, errors.New("missing") }
	return entries, nil
}
func (f fakeFileSystem) IsRegular(path string) (bool, error) {
	node, ok := f.nodes[path]
	if !ok || !node.exists { return false, errors.New("missing") }
	return node.regular, nil
}
func (f fakeFileSystem) OpenRead(path string) (io.Closer, error) {
	node, ok := f.nodes[path]
	if !ok || !node.exists || !node.readable { return nil, errors.New("unreadable") }
	reader := io.NopCloser(strings.NewReader(node.contents))
	if node.closeFails { return closeErrorCloser{reader}, nil }
	return reader, nil
}

func readable(path string) map[string]fakeNode { return map[string]fakeNode{path: {exists: true, regular: true, readable: true}} }
func fixtureFS(nodes map[string]fakeNode, dirs map[string][]DirectoryEntry) fakeFileSystem { return fakeFileSystem{nodes: nodes, dirs: dirs} }

func TestLocatorStrategyPrecedence(t *testing.T) {
	launcher := `C:\Users\Test\AppData\rsilauncher\logs\log.log`
	launcherGameLog := `C:\RSI\StarCitizen\LIVE\Game.log`
	processGameLog := `D:\RSI\StarCitizen\PTU\Game.log`
	knownRoot := `E:\Games\StarCitizen`
	registryRoot := `F:\Roberts Space Industries\StarCitizen`
	manual := `G:\manual\Game.log`
	nodes := readable(launcherGameLog)
	nodes[launcher] = fakeNode{exists: true, contents: `[Launcher::launch] Launching Star Citizen LIVE from (C:\RSI\StarCitizen\LIVE)`}
	nodes[processGameLog] = fakeNode{exists: true, regular: true, readable: true}
	nodes[gameLogInChannel(joinPath(knownRoot, "LIVE"))] = fakeNode{exists: true, regular: true, readable: true}
	nodes[gameLogInChannel(joinPath(registryRoot, "LIVE"))] = fakeNode{exists: true, regular: true, readable: true}
	nodes[manual] = fakeNode{exists: true, regular: true, readable: true}
	locator := NewLocator(Config{
		FileSystem: fixtureFS(nodes, map[string][]DirectoryEntry{knownRoot: {{Name: "LIVE", IsDir: true}}, registryRoot: {{Name: "LIVE", IsDir: true}}}),
		LauncherLogPaths: []string{launcher}, KnownRoots: []string{knownRoot}, ManualPath: manual,
		ProcessQuery: func() (string, error) { return `D:\RSI\StarCitizen\PTU\Bin64\StarCitizen.exe`, nil },
		RegistryRoots: func() ([]string, error) { return []string{registryRoot}, nil },
	})
	result := locator.Locate()
	if result.Strategy != StrategyLauncherLog || result.Path != launcherGameLog { t.Fatalf("got %#v", result) }
}

func TestLocatorPrecedenceAfterEarlierStrategiesFail(t *testing.T) {
	processLog := `C:\RSI\StarCitizen\LIVE\Game.log`
	knownRoot := `D:\Games\StarCitizen`
	knownLog := `D:\Games\StarCitizen\LIVE\Game.log`
	registryRoot := `E:\Roberts Space Industries\StarCitizen`
	registryLog := `E:\Roberts Space Industries\StarCitizen\LIVE\Game.log`
	manualLog := `F:\manual\Game.log`

	t.Run("running process wins known registry and manual", func(t *testing.T) {
		nodes := readable(processLog)
		nodes[knownLog] = fakeNode{exists: true, regular: true, readable: true}
		nodes[registryLog] = fakeNode{exists: true, regular: true, readable: true}
		nodes[manualLog] = fakeNode{exists: true, regular: true, readable: true}
		result := NewLocator(Config{FileSystem: fixtureFS(nodes, map[string][]DirectoryEntry{knownRoot: {{Name: "LIVE", IsDir: true}}, registryRoot: {{Name: "LIVE", IsDir: true}}}), KnownRoots: []string{knownRoot}, ManualPath: manualLog, ProcessQuery: func() (string, error) { return `C:\RSI\StarCitizen\LIVE\Bin64\StarCitizen.exe`, nil }, RegistryRoots: func() ([]string, error) { return []string{registryRoot}, nil }}).Locate()
		if result.Strategy != StrategyRunningProcess { t.Fatalf("got %#v", result) }
	})

	t.Run("known location wins registry and manual", func(t *testing.T) {
		nodes := readable(knownLog)
		nodes[registryLog] = fakeNode{exists: true, regular: true, readable: true}
		nodes[manualLog] = fakeNode{exists: true, regular: true, readable: true}
		result := NewLocator(Config{FileSystem: fixtureFS(nodes, map[string][]DirectoryEntry{knownRoot: {{Name: "LIVE", IsDir: true}}, registryRoot: {{Name: "LIVE", IsDir: true}}}), KnownRoots: []string{knownRoot}, ManualPath: manualLog, RegistryRoots: func() ([]string, error) { return []string{registryRoot}, nil }}).Locate()
		if result.Strategy != StrategyKnownLocation { t.Fatalf("got %#v", result) }
	})

	t.Run("registry wins manual", func(t *testing.T) {
		nodes := readable(registryLog)
		nodes[manualLog] = fakeNode{exists: true, regular: true, readable: true}
		result := NewLocator(Config{FileSystem: fixtureFS(nodes, map[string][]DirectoryEntry{registryRoot: {{Name: "LIVE", IsDir: true}}}), ManualPath: manualLog, RegistryRoots: func() ([]string, error) { return []string{registryRoot}, nil }}).Locate()
		if result.Strategy != StrategyRegistry { t.Fatalf("got %#v", result) }
	})
}

func TestLauncherCandidatesHandleChannelsAndNewestValid(t *testing.T) {
	for _, test := range []struct { name, channel string }{{"live", "LIVE"}, {"ptu", "PTU"}, {"future", "TECH-PREVIEW"}} {
		t.Run(test.name, func(t *testing.T) {
			contents := `[Launcher::launch] Launching Star Citizen ` + test.channel + ` from (C:\RSI\StarCitizen\` + test.channel + `)`
			got := launcherGameLogCandidates(contents)
			want := `C:\RSI\StarCitizen\` + test.channel + `\Game.log`
			if len(got) != 1 || got[0] != want { t.Fatalf("got %v, want %s", got, want) }
		})
	}
	log := `launcher.log`
	older := `C:\RSI\StarCitizen\PTU\Game.log`
	contents := "ignored\n[Launcher::launch] Launching Star Citizen PTU from (C:\\RSI\\StarCitizen\\PTU)\n[Launcher::launch] Launching Star Citizen LIVE from (C:\\RSI\\StarCitizen\\LIVE)"
	nodes := readable(older); nodes[log] = fakeNode{exists: true, contents: contents}
	result := NewLocator(Config{FileSystem: fixtureFS(nodes, nil), LauncherLogPaths: []string{log}}).Locate()
	if result.Path != older { t.Fatalf("newest missing candidate should fall back to older valid, got %#v", result) }
}

func TestLauncherRotatedFallbackAndMalformedLines(t *testing.T) {
	current, rotated := "log.log", "log.old.log"
	candidate := `C:\RSI\StarCitizen\EPTU\Game.log`
	nodes := readable(candidate)
	nodes[current] = fakeNode{exists: true, contents: "not a launcher entry"}
	nodes[rotated] = fakeNode{exists: true, contents: `[Launcher::launch] Launching Star Citizen EPTU from (C:\RSI\StarCitizen\EPTU)`}
	result := NewLocator(Config{FileSystem: fixtureFS(nodes, nil), LauncherLogPaths: []string{current, rotated}}).Locate()
	if result.Path != candidate || result.Strategy != StrategyLauncherLog { t.Fatalf("got %#v", result) }
}

func TestLauncherCurrentLogWinsOverRotatedLog(t *testing.T) {
	current, rotated := "log.log", "log.old.log"
	currentCandidate := `C:\RSI\StarCitizen\LIVE\Game.log`
	rotatedCandidate := `C:\RSI\StarCitizen\PTU\Game.log`
	nodes := readable(currentCandidate)
	nodes[rotatedCandidate] = fakeNode{exists: true, regular: true, readable: true}
	nodes[current] = fakeNode{exists: true, contents: `[Launcher::launch] Launching Star Citizen LIVE from (C:\RSI\StarCitizen\LIVE)`}
	nodes[rotated] = fakeNode{exists: true, contents: `[Launcher::launch] Launching Star Citizen PTU from (C:\RSI\StarCitizen\PTU)`}
	result := NewLocator(Config{FileSystem: fixtureFS(nodes, nil), LauncherLogPaths: []string{current, rotated}}).Locate()
	if result.Path != currentCandidate { t.Fatalf("current log should win over rotated log: %#v", result) }
}

func TestProcessExecutablePathProcessing(t *testing.T) {
	for _, test := range []struct { path, want string; ok bool }{
		{`C:\RSI\StarCitizen\LIVE\Bin64\StarCitizen.exe`, `C:\RSI\StarCitizen\LIVE\Game.log`, true},
		{`D:\Games\StarCitizen\PTU\Bin64\StarCitizen.exe`, `D:\Games\StarCitizen\PTU\Game.log`, true},
		{`E:\RSI\StarCitizen\FUTURE\Bin64\StarCitizen.exe`, `E:\RSI\StarCitizen\FUTURE\Game.log`, true},
		{`C:\RSI\StarCitizen\LIVE\Bin64\Other.exe`, "", false},
		{`C:\StarCitizen.exe`, "", false},
		{`C:\RSI\StarCitizen\LIVE\StarCitizen.exe`, "", false},
	} {
		got, ok := gameLogFromExecutable(test.path)
		if got != test.want || ok != test.ok { t.Fatalf("%s: got %q %t", test.path, got, ok) }
	}
}

func TestProcessFailureFallsBackToKnownLocation(t *testing.T) {
	root := `C:\Games\StarCitizen`; candidate := `C:\Games\StarCitizen\PTU\Game.log`
	nodes := readable(candidate)
	result := NewLocator(Config{FileSystem: fixtureFS(nodes, map[string][]DirectoryEntry{root: {{Name: "PTU", IsDir: true}}}), KnownRoots: []string{root}, ProcessQuery: func() (string, error) { return "", errors.New("powershell unavailable") }}).Locate()
	if result.Strategy != StrategyKnownLocation || result.Path != candidate { t.Fatalf("got %#v", result) }
}

func TestMultipleProcessCandidatesContinueAfterInvalidGameLog(t *testing.T) {
	invalid := `C:\RSI\StarCitizen\LIVE\Game.log`
	valid := `D:\Games\StarCitizen\PTU\Game.log`
	nodes := readable(valid)
	result := NewLocator(Config{
		FileSystem: fixtureFS(nodes, nil),
		ProcessQuery: func() (string, error) {
			return `C:\RSI\StarCitizen\LIVE\Bin64\StarCitizen.exe` + "\n" + `D:\Games\StarCitizen\PTU\Bin64\StarCitizen.exe`, nil
		},
	}).Locate()
	if result.Strategy != StrategyRunningProcess || result.Path != valid || !hasAttempt(result, StrategyRunningProcess, OutcomeNotFound) {
		t.Fatalf("expected second process candidate after %s fails: %#v", invalid, result)
	}
}

func TestKnownLocationsFixedAndArbitraryChannelsAreDeterministic(t *testing.T) {
	root := `C:\Games\StarCitizen`
	ptu := `C:\Games\StarCitizen\PTU\Game.log`; arbitrary := `C:\Games\StarCitizen\NEXT\Game.log`
	nodes := readable(ptu); nodes[arbitrary] = fakeNode{exists: true, regular: true, readable: true}
	result := NewLocator(Config{FileSystem: fixtureFS(nodes, map[string][]DirectoryEntry{root: {{Name: "NEXT", IsDir: true}, {Name: "PTU", IsDir: true}, {Name: "LIVE", IsDir: true}}}), KnownRoots: []string{root}}).Locate()
	if result.Path != ptu { t.Fatalf("fixed channel precedence should be deterministic, got %#v", result) }
	delete(nodes, ptu)
	result = NewLocator(Config{FileSystem: fixtureFS(nodes, map[string][]DirectoryEntry{root: {{Name: "NEXT", IsDir: true}}}), KnownRoots: []string{root}}).Locate()
	if result.Path != arbitrary { t.Fatalf("arbitrary child channel not selected: %#v", result) }
}

func TestRegistryHintsAndFailures(t *testing.T) {
	root := `C:\Roberts Space Industries\StarCitizen`; candidate := `C:\Roberts Space Industries\StarCitizen\LIVE\Game.log`
	nodes := readable(candidate)
	result := NewLocator(Config{FileSystem: fixtureFS(nodes, map[string][]DirectoryEntry{root: {{Name: "LIVE", IsDir: true}}}), RegistryRoots: func() ([]string, error) { return []string{root}, nil }}).Locate()
	if result.Strategy != StrategyRegistry || result.Path != candidate { t.Fatalf("got %#v", result) }
	result = NewLocator(Config{FileSystem: fixtureFS(nil, nil), RegistryRoots: func() ([]string, error) { return nil, errors.New("reg missing") }}).Locate()
	if result.Found() || !hasAttempt(result, StrategyRegistry, OutcomeUnavailable) { t.Fatalf("expected registry failure diagnostics: %#v", result) }
	result = NewLocator(Config{FileSystem: fixtureFS(nil, nil), RegistryRoots: func() ([]string, error) { return []string{"unrelated output"}, nil }}).Locate()
	if result.Found() || !hasAttempt(result, StrategyRegistry, OutcomeNoCandidate) { t.Fatalf("expected unusable registry diagnostics: %#v", result) }
}

func TestRegistryInstallLocationsAreConservative(t *testing.T) {
	output := "InstallLocation    REG_SZ    \"C:\\Program Files\\Roberts Space Industries\\StarCitizen\"\nDisplayName REG_SZ Something Else\nInstallLocation REG_DWORD 1\n"
	got := registryInstallLocations(output)
	want := `C:\Program Files\Roberts Space Industries\StarCitizen`
	if len(got) != 1 || got[0] != want { t.Fatalf("got %v, want %s", got, want) }
}

func TestKnownLocationMissingGameLogIsNotSelected(t *testing.T) {
	root := `C:\Games\StarCitizen`
	result := NewLocator(Config{FileSystem: fixtureFS(nil, map[string][]DirectoryEntry{root: {{Name: "LIVE", IsDir: true}}}), KnownRoots: []string{root}}).Locate()
	if result.Found() || !hasAttempt(result, StrategyKnownLocation, OutcomeNotFound) { t.Fatalf("expected missing known-location diagnostics: %#v", result) }
}

func TestManualPathValidation(t *testing.T) {
	for _, test := range []struct { name, path string; node fakeNode; found bool; outcome AttemptOutcome }{
		{"readable", `C:\manual\Game.log`, fakeNode{exists: true, regular: true, readable: true}, true, OutcomeSelected},
		{"missing", `C:\manual\Game.log`, fakeNode{}, false, OutcomeNotFound},
		{"directory", `C:\manual\Game.log`, fakeNode{exists: true}, false, OutcomeNotRegular},
		{"unreadable", `C:\manual\Game.log`, fakeNode{exists: true, regular: true}, false, OutcomeUnreadable},
		{"wrong_file_name", `C:\manual\other.log`, fakeNode{exists: true, regular: true, readable: true}, false, OutcomeNoCandidate},
	} {
		t.Run(test.name, func(t *testing.T) {
			result := NewLocator(Config{FileSystem: fixtureFS(map[string]fakeNode{test.path: test.node}, nil), ManualPath: test.path}).Locate()
			if result.Found() != test.found || !hasAttempt(result, StrategyManual, test.outcome) { t.Fatalf("got %#v", result) }
		})
	}
}

func TestGameLogFilenameIsCaseInsensitive(t *testing.T) {
	for _, name := range []string{"Game.log", "GAME.LOG", "game.log", "Game.Log"} {
		t.Run(name, func(t *testing.T) {
			path := `C:\manual\` + name
			result := NewLocator(Config{FileSystem: fixtureFS(readable(path), nil), ManualPath: path}).Locate()
			if !result.Found() || result.Strategy != StrategyManual { t.Fatalf("got %#v", result) }
		})
	}
}

func TestSuccessfulReadOnlyOpenIsSufficientWhenCloseFails(t *testing.T) {
	path := `C:\manual\Game.log`
	result := NewLocator(Config{FileSystem: fixtureFS(map[string]fakeNode{path: {exists: true, regular: true, readable: true, closeFails: true}}, nil), ManualPath: path}).Locate()
	if !result.Found() || result.Strategy != StrategyManual { t.Fatalf("got %#v", result) }
}

func TestFailureResultIncludesAllStrategies(t *testing.T) {
	result := NewLocator(Config{FileSystem: fixtureFS(nil, nil), LauncherLogPaths: []string{"missing.log"}, ProcessQuery: func() (string, error) { return "", errors.New("failed") }, RegistryRoots: func() ([]string, error) { return nil, errors.New("failed") }}).Locate()
	if result.Found() { t.Fatalf("unexpected success: %#v", result) }
	for _, strategy := range []DiscoveryStrategy{StrategyLauncherLog, StrategyRunningProcess, StrategyKnownLocation, StrategyRegistry, StrategyManual} {
		if !hasStrategy(result, strategy) { t.Fatalf("missing %s diagnostics: %#v", strategy, result.Attempts) }
	}
}

func hasAttempt(result LocateResult, strategy DiscoveryStrategy, outcome AttemptOutcome) bool {
	for _, attempt := range result.Attempts { if attempt.Strategy == strategy && attempt.Outcome == outcome { return true } }; return false
}
func hasStrategy(result LocateResult, strategy DiscoveryStrategy) bool {
	for _, attempt := range result.Attempts { if attempt.Strategy == strategy { return true } }; return false
}
