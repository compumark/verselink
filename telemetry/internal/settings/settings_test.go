package settings

import (
	"os"
	"path/filepath"
	"testing"
)

func TestMissingSettingsDefaultToAuto(t *testing.T) {
	got, err := (Store{Path: filepath.Join(t.TempDir(), "missing.json")}).Load()
	if err != nil || got != Defaults() {
		t.Fatalf("Load() = %#v, %v; want defaults without error", got, err)
	}
}

func TestLoadVersionOneSettings(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	if err := os.WriteFile(path, []byte(`{"version":1,"gameLog":{"mode":"manual","manualPath":" O:\\SC\\LIVE\\Game.log "}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := (Store{Path: path}).Load()
	want := Settings{Version: 1, GameLog: GameLogConfig{Mode: ModeManual, ManualPath: `O:\SC\LIVE\Game.log`}}
	if err != nil || got != want {
		t.Fatalf("Load() = %#v, %v; want %#v", got, err, want)
	}
}

func TestSaveLoadRoundTripAndClearManual(t *testing.T) {
	store := Store{Path: filepath.Join(t.TempDir(), "nested", "settings.json")}
	manual := Settings{Version: 1, GameLog: GameLogConfig{Mode: ModeManual, ManualPath: `O:\SC\LIVE\Game.log`}}
	if err := store.Save(manual); err != nil {
		t.Fatal(err)
	}
	if got, err := store.Load(); err != nil || got != manual {
		t.Fatalf("round trip = %#v, %v; want %#v", got, err, manual)
	}
	if err := store.Save(Settings{Version: 1, GameLog: GameLogConfig{Mode: ModeAuto, ManualPath: "stale"}}); err != nil {
		t.Fatal(err)
	}
	if got, err := store.Load(); err != nil || got != Defaults() {
		t.Fatalf("cleared setting = %#v, %v; want defaults", got, err)
	}
	entries, err := os.ReadDir(filepath.Dir(store.Path))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "settings.json" {
		t.Fatalf("leftover files after atomic save: %v", entries)
	}
}

func TestLoadMalformedAndUnsupportedSettingsFallBackWithoutOverwrite(t *testing.T) {
	for name, content := range map[string]string{
		"malformed":    `{not json`,
		"future":       `{"version":2,"gameLog":{"mode":"auto","manualPath":""}}`,
		"bad mode":     `{"version":1,"gameLog":{"mode":"future","manualPath":""}}`,
		"missing mode": `{"version":1,"gameLog":{"manualPath":"C:\\Game.log"}}`,
		"trailing":     `{"version":1,"gameLog":{"mode":"auto","manualPath":""}} {}`,
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "settings.json")
			if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
				t.Fatal(err)
			}
			got, err := (Store{Path: path}).Load()
			if err == nil || got != Defaults() {
				t.Fatalf("Load() = %#v, %v; want defaults and a warning error", got, err)
			}
			unchanged, readErr := os.ReadFile(path)
			if readErr != nil || string(unchanged) != content {
				t.Fatalf("corrupt source was changed: %q, %v", unchanged, readErr)
			}
		})
	}
}

func TestNormalizeModes(t *testing.T) {
	auto, err := Normalize(Settings{Version: 1, GameLog: GameLogConfig{Mode: " AUTO ", ManualPath: "ignored"}})
	if err != nil || auto != Defaults() {
		t.Fatalf("auto normalization = %#v, %v", auto, err)
	}
	manual, err := Normalize(Settings{Version: 1, GameLog: GameLogConfig{Mode: " MANUAL ", ManualPath: "  C:\\Game.log  "}})
	if err != nil || manual.GameLog.Mode != ModeManual || manual.GameLog.ManualPath != `C:\Game.log` {
		t.Fatalf("manual normalization = %#v, %v", manual, err)
	}
	if normalized, err := Normalize(Settings{Version: 1, GameLog: GameLogConfig{ManualPath: `C:\Game.log`}}); err == nil || normalized != Defaults() {
		t.Fatalf("missing mode normalization = %#v, %v; want safe defaults and warning", normalized, err)
	}
}

func TestLocalSettingsPath(t *testing.T) {
	got, err := LocalSettingsPath(`C:\Users\Tester\AppData\Local`)
	if err != nil || filepath.Base(got) != "settings.json" || filepath.Base(filepath.Dir(got)) != "Telemetry" {
		t.Fatalf("LocalSettingsPath() = %q, %v", got, err)
	}
	if _, err := LocalSettingsPath(""); err == nil {
		t.Fatal("empty LOCALAPPDATA was accepted")
	}
}

func TestChannelFromPath(t *testing.T) {
	for input, want := range map[string]string{
		`O:\Roberts Space Industries\StarCitizen\LIVE\Game.log`:   "LIVE",
		`O:\Roberts Space Industries\StarCitizen\PTU\Game.log`:    "PTU",
		`O:\Roberts Space Industries\StarCitizen\EPTU\Game.log`:   "EPTU",
		`O:\Roberts Space Industries\StarCitizen\FUTURE\Game.log`: "FUTURE",
		`O:\Other\Game.log`: "",
	} {
		if got := ChannelFromPath(input); got != want {
			t.Errorf("ChannelFromPath(%q) = %q, want %q", input, got, want)
		}
	}
}
