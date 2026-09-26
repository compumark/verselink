package revision

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAcquireIsExclusiveAndRevisionSurvivesRestart(t *testing.T) {
	dir := t.TempDir()
	first, state, err := Acquire(dir, "device-123")
	if err != nil {
		t.Fatal(err)
	}
	if state.Version != 1 || state.Revision != 0 {
		t.Fatalf("initial state = %#v", state)
	}
	lockPath := filepath.Join(dir, "device-123.revision.lock")
	if info, err := os.Stat(lockPath); err != nil || !info.Mode().IsRegular() {
		t.Fatalf("stable per-device sibling lock missing or not regular: info=%v err=%v", info, err)
	}
	if _, _, err := Acquire(dir, "device-123"); err == nil {
		t.Fatal("second process acquired the held device lock")
	}
	state, err = first.Advance()
	if err != nil || state.Revision != 1 {
		t.Fatalf("first Advance() = %#v, %v", state, err)
	}
	state, err = first.Advance()
	if err != nil || state.Revision != 2 {
		t.Fatalf("second Advance() = %#v, %v", state, err)
	}
	if err := first.Release(); err != nil {
		t.Fatal(err)
	}
	lockBytes, err := os.ReadFile(lockPath)
	if err != nil || len(lockBytes) != 0 {
		t.Fatalf("lock file should be empty and contain no state/secrets: bytes=%q err=%v", lockBytes, err)
	}
	second, reloaded, err := Acquire(dir, "device-123")
	if err != nil {
		t.Fatal(err)
	}
	defer second.Release()
	if reloaded.Revision != 2 {
		t.Fatalf("persisted revision = %d, want 2", reloaded.Revision)
	}
	state, err = second.Advance()
	if err != nil || state.Revision != 3 {
		t.Fatalf("restart Advance() = %#v, %v", state, err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".revision-") && strings.HasSuffix(entry.Name(), ".tmp") {
			t.Fatalf("temporary revision file remained: %s", entry.Name())
		}
	}
}

func TestAdvanceRejectsExhaustedRevisionAndUnsafeDeviceID(t *testing.T) {
	dir := t.TempDir()
	if _, _, err := Acquire(dir, "../escape"); err == nil {
		t.Fatal("path traversal device ID accepted")
	}
	encoded, err := json.Marshal(State{Version: 1, DeviceID: "device", Revision: MaxValue})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "device.revision.json"), encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	lock, state, err := Acquire(dir, "device")
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	if state.Revision != MaxValue {
		t.Fatalf("loaded revision = %d, want max", state.Revision)
	}
	if _, err := lock.Advance(); err == nil {
		t.Fatal("advance beyond safe integer range succeeded")
	}
}

func TestAcquireRejectsCorruptOrMismatchedState(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "device-123.revision.json"), []byte(`{"version":1,"deviceId":"other","revision":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := Acquire(dir, "device-123"); err == nil {
		t.Fatal("mismatched state accepted")
	}
}

func TestSaveRequiresHeldLockAndValidRevision(t *testing.T) {
	dir := t.TempDir()
	if _, err := (&Lock{}).Advance(); err == nil {
		t.Fatal("advance without lock succeeded")
	}
	l, state, err := Acquire(dir, "device")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Release()
	if state.DeviceID != "device" {
		t.Fatalf("initial device ID = %q", state.DeviceID)
	}
}
