//go:build windows

package main

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestApplicationMutexConcurrentProcesses(t *testing.T) {
	if os.Getenv("B4_MUTEX_HELPER") == "1" {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		name := os.Getenv("B4_MUTEX_NAME")
		release, duplicate, err := acquireNamedApplicationMutex(name)
		if err != nil {
			fmt.Printf("B4_MUTEX_ERROR=%v\n", err)
			return
		}
		if duplicate {
			fmt.Println("B4_MUTEX_STATE=duplicate")
			return
		}
		fmt.Println("B4_MUTEX_STATE=owner")
		defer release()
		until := time.Now().Add(10 * time.Second)
		for time.Now().Before(until) {
			if _, err := os.Stat(os.Getenv("B4_MUTEX_RELEASE")); err == nil {
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
		fmt.Println("B4_MUTEX_ERROR=parent release signal timed out")
		return
	}

	root := t.TempDir()
	releaseFile := filepath.Join(root, "release")
	mutex := fmt.Sprintf(`Local\VerseLinkTelemetry-test-%d-%d`, os.Getpid(), time.Now().UnixNano())
	type helper struct {
		command *exec.Cmd
		stdout  bytes.Buffer
		stderr  bytes.Buffer
		done    chan struct{}
		waitErr error
	}
	var helpers []*helper
	release := func() { _ = os.WriteFile(releaseFile, []byte("release"), 0o600) }
	cleanupRegistered := false
	for range 2 {
		command := exec.Command(os.Args[0], "-test.run=^TestApplicationMutexConcurrentProcesses$")
		command.Env = append(os.Environ(), "B4_MUTEX_HELPER=1", "B4_MUTEX_NAME="+mutex, "B4_MUTEX_RELEASE="+releaseFile)
		child := &helper{command: command, done: make(chan struct{})}
		command.Stdout, command.Stderr = &child.stdout, &child.stderr
		if err := command.Start(); err != nil {
			t.Fatalf("start mutex helper: %v", err)
		}
		helpers = append(helpers, child)
		if !cleanupRegistered {
			cleanupRegistered = true
			t.Cleanup(func() {
				release()
				for _, process := range helpers {
					select {
					case <-process.done:
					case <-time.After(time.Second):
						_ = process.command.Process.Kill()
						select {
						case <-process.done:
						case <-time.After(2 * time.Second):
							t.Errorf("mutex helper PID %d did not exit after kill", process.command.Process.Pid)
						}
					}
				}
			})
		}
		go func(process *helper) {
			process.waitErr = process.command.Wait()
			close(process.done)
		}(child)
	}

	completed := -1
	select {
	case <-helpers[0].done:
		completed = 0
	case <-helpers[1].done:
		completed = 1
	case <-time.After(8 * time.Second):
		t.Fatal("neither mutex helper reported a duplicate")
	}
	completedOutput := helpers[completed].stdout.String() + helpers[completed].stderr.String()
	if helpers[completed].waitErr != nil || !strings.Contains(completedOutput, "B4_MUTEX_STATE=duplicate") {
		t.Fatalf("first completed helper did not report duplicate: err=%v output=%s", helpers[completed].waitErr, completedOutput)
	}
	release()
	for _, process := range helpers {
		select {
		case <-process.done:
		case <-time.After(8 * time.Second):
			t.Fatalf("mutex helper PID %d did not exit after cooperative release", process.command.Process.Pid)
		}
		if process.waitErr != nil {
			t.Fatalf("wait for mutex helper: %v", process.waitErr)
		}
	}
	owner := 1 - completed
	ownerOutput := helpers[owner].stdout.String() + helpers[owner].stderr.String()
	if !strings.Contains(ownerOutput, "B4_MUTEX_STATE=owner") {
		t.Fatalf("remaining helper did not report owner: %s", ownerOutput)
	}
}

func TestCreateMutexClearsStaleLastError(t *testing.T) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	setLastError := syscall.NewLazyDLL("kernel32.dll").NewProc("SetLastError")
	// SetLastError intentionally leaves a non-zero last-error value behind;
	// ignore Proc.Call's captured last-error result. The production LazyProc.Call
	// must clear it immediately before CreateMutexW, as verified in the Go runtime.
	setLastError.Call(uintptr(mutexAlreadyExists))

	name := fmt.Sprintf(`Local\VerseLinkTelemetry-last-error-test-%d-%d`, os.Getpid(), time.Now().UnixNano())
	release, duplicate, err := acquireNamedApplicationMutex(name)
	if err != nil {
		t.Fatalf("create new test mutex: %v", err)
	}
	if duplicate {
		t.Fatal("new mutex was misclassified as already running")
	}
	defer release()

	secondRelease, duplicate, err := acquireNamedApplicationMutex(name)
	if err != nil {
		t.Fatalf("open existing test mutex: %v", err)
	}
	if !duplicate {
		if secondRelease != nil {
			secondRelease()
		}
		t.Fatal("existing mutex was not classified as duplicate")
	}
}

func TestCurrentUserSID(t *testing.T) {
	sid, err := currentUserSID()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(sid, "S-1-") {
		t.Fatalf("current user SID = %q, want a Windows SID", sid)
	}
}

func TestNativeRunValueStoreUsesOnlyIsolatedTestKey(t *testing.T) {
	keyPath := fmt.Sprintf(`Software\VerseLinkTelemetryB4Test-%d-%d`, os.Getpid(), time.Now().UnixNano())
	store := nativeRunValueStore{keyPath: keyPath, valueName: "Run"}
	t.Cleanup(func() {
		_ = store.delete()
		_ = deleteRunKeyForTest(keyPath)
	})
	if value, found, err := store.read(); err != nil || found || value != "" {
		t.Fatalf("initial test Run value = %q found=%v err=%v", value, found, err)
	}
	want := `"C:\Program Files\VerseLink Telemetry.exe" --autostart`
	if err := store.write(want); err != nil {
		if errors.Is(err, syscall.Errno(5)) {
			t.Skip("current user registry writes are unavailable in this environment")
		}
		t.Fatal(err)
	}
	if value, found, err := store.read(); err != nil || !found || value != want {
		t.Fatalf("stored test Run value = %q found=%v err=%v", value, found, err)
	}
	if err := store.delete(); err != nil {
		t.Fatal(err)
	}
	if value, found, err := store.read(); err != nil || found || value != "" {
		t.Fatalf("deleted test Run value = %q found=%v err=%v", value, found, err)
	}
}
