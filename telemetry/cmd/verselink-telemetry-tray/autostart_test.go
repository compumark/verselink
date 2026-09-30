package main

import (
	"errors"
	"testing"
)

type memoryRunValue struct {
	value                        string
	found                        bool
	readErr, writeErr, deleteErr error
	writes, deletes              int
}

func (m *memoryRunValue) read() (string, bool, error) { return m.value, m.found, m.readErr }
func (m *memoryRunValue) write(value string) error {
	m.writes++
	if m.writeErr != nil {
		return m.writeErr
	}
	m.value, m.found = value, true
	return nil
}
func (m *memoryRunValue) delete() error {
	m.deletes++
	if m.deleteErr != nil {
		return m.deleteErr
	}
	m.value, m.found = "", false
	return nil
}

func TestAutostartManagerStatesAndExplicitRepair(t *testing.T) {
	store := &memoryRunValue{}
	manager := autostartManager{store: store, executable: `C:\Users\Pilot One\VerseLink Telemetry.exe`}
	if state, err := manager.state(); err != nil || state != autostartDisabled {
		t.Fatalf("initial state = %q, %v", state, err)
	}
	if err := manager.enable(); err != nil {
		t.Fatal(err)
	}
	if want := `"C:\Users\Pilot One\VerseLink Telemetry.exe" --autostart`; store.value != want {
		t.Fatalf("Run value = %q, want %q", store.value, want)
	}
	if state, err := manager.state(); err != nil || state != autostartEnabled {
		t.Fatalf("enabled state = %q, %v", state, err)
	}
	store.value = `"C:\Old Location\VerseLink Telemetry.exe" --autostart`
	if state, err := manager.state(); err != nil || state != autostartStale {
		t.Fatalf("moved executable state = %q, %v", state, err)
	}
	if err := manager.enable(); !errors.Is(err, errAutostartConflict) {
		t.Fatalf("enable stale value error = %v", err)
	}
	if store.writes != 1 {
		t.Fatalf("implicit enable overwrote stale value; writes=%d", store.writes)
	}
	if err := manager.repair(); err != nil {
		t.Fatal(err)
	}
	if state, err := manager.state(); err != nil || state != autostartEnabled {
		t.Fatalf("repaired state = %q, %v", state, err)
	}
	if err := manager.disable(); err != nil {
		t.Fatal(err)
	}
	if state, err := manager.state(); err != nil || state != autostartDisabled {
		t.Fatalf("disabled state = %q, %v", state, err)
	}
}

func TestAutostartManagerReportsRegistryFailures(t *testing.T) {
	want := errors.New("registry unavailable")
	store := &memoryRunValue{readErr: want}
	manager := autostartManager{store: store, executable: `C:\VerseLink.exe`}
	if _, err := manager.state(); !errors.Is(err, want) {
		t.Fatalf("state error = %v", err)
	}
	store.readErr = nil
	store.writeErr = want
	if err := manager.enable(); !errors.Is(err, want) {
		t.Fatalf("enable error = %v", err)
	}
	store.writeErr = nil
	store.found = true
	store.value = "foreign"
	store.deleteErr = want
	if err := manager.disable(); !errors.Is(err, want) {
		t.Fatalf("disable error = %v", err)
	}
}

func TestQuoteWindowsArgument(t *testing.T) {
	cases := map[string]string{
		`C:\Program Files\VerseLink.exe`: `"C:\Program Files\VerseLink.exe"`,
		`C:\VerseLink.exe`:               `C:\VerseLink.exe`,
		`C:\path with space\trailing\`:   `"C:\path with space\trailing\\"`,
		`C:\say"hi.exe`:                  `"C:\say\"hi.exe"`,
	}
	for input, want := range cases {
		if got := quoteWindowsArgument(input); got != want {
			t.Errorf("quoteWindowsArgument(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestParseLaunchArguments(t *testing.T) {
	for _, test := range []struct {
		args               []string
		autostart, wantErr bool
	}{
		{nil, false, false},
		{[]string{autostartArgument}, true, false},
		{[]string{"--autostart", "unexpected"}, false, true},
		{[]string{"--unknown"}, false, true},
	} {
		got, err := parseLaunchArguments(test.args)
		if got != test.autostart || (err != nil) != test.wantErr {
			t.Errorf("parseLaunchArguments(%q) = %v, %v", test.args, got, err)
		}
		if err != nil && err.Error() != "unsupported command-line arguments" {
			t.Errorf("unexpected argument error: %v", err)
		}
	}
}
