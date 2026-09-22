package gamelog

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func writeTailerFile(t *testing.T, path, text string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil { t.Fatal(err) }
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil { t.Fatal(err) }
}

func appendTailerFile(t *testing.T, path, text string) {
	t.Helper()
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil { t.Fatal(err) }
	if _, err := file.WriteString(text); err != nil { _ = file.Close(); t.Fatal(err) }
	if err := file.Close(); err != nil { t.Fatal(err) }
}

func newTestTailer(path string, received *[]Line) *Tailer {
	return NewTailer(TailerConfig{Path: path, PollInterval: time.Millisecond, OnLine: func(line Line) { *received = append(*received, line) }})
}

func texts(lines []Line) []string {
	result := make([]string, 0, len(lines))
	for _, line := range lines { result = append(result, line.Text) }
	return result
}

func TestTailerInitialExistingFileAttachesAtEOFAndDeliversNewLines(t *testing.T) {
	path := filepath.Join(t.TempDir(), "Game.log")
	writeTailerFile(t, path, "historic one\nhistoric two\n")
	var received []Line
	tailer := newTestTailer(path, &received)
	tailer.pollOnce()
	appendTailerFile(t, path, "new one\nnew two \t\r\n")
	tailer.pollOnce()
	tailer.pollOnce()
	if got, want := texts(received), []string{"new one", "new two \t"}; !reflect.DeepEqual(got, want) { t.Fatalf("got %q, want %q", got, want) }
}

func TestTailerStartsAtZeroWhenFileAppearsLater(t *testing.T) {
	path := filepath.Join(t.TempDir(), "Game.log")
	var received []Line
	tailer := newTestTailer(path, &received)
	tailer.pollOnce()
	writeTailerFile(t, path, "first\nsecond\n")
	tailer.pollOnce()
	if got, want := texts(received), []string{"first", "second"}; !reflect.DeepEqual(got, want) { t.Fatalf("got %q, want %q", got, want) }
}

func TestTailerWaitsForInitiallyEmptyPathAndLaterSetPathStartsAtZero(t *testing.T) {
	path := filepath.Join(t.TempDir(), "Game.log")
	var received []Line
	tailer := newTestTailer("", &received)
	tailer.pollOnce()
	if state := tailer.Snapshot().State; state != TailerWaitingForPath { t.Fatalf("got state %s", state) }
	writeTailerFile(t, path, "later\n")
	tailer.SetPath(path)
	tailer.pollOnce()
	if got := texts(received); !reflect.DeepEqual(got, []string{"later"}) { t.Fatalf("got %q", got) }
}

func TestTailerBuffersPartialLinesAndHandlesMultipleLines(t *testing.T) {
	path := filepath.Join(t.TempDir(), "Game.log")
	writeTailerFile(t, path, "")
	var received []Line
	tailer := newTestTailer(path, &received)
	tailer.pollOnce()
	appendTailerFile(t, path, "partial")
	tailer.pollOnce()
	if snapshot := tailer.Snapshot(); snapshot.Offset != int64(len("partial")) || string(tailer.partial) != "partial" {
		t.Fatalf("offset/partial mismatch: %#v, %q", snapshot, tailer.partial)
	}
	appendTailerFile(t, path, " completed\none\ntwo\r\nthree")
	tailer.pollOnce()
	appendTailerFile(t, path, " complete\n")
	tailer.pollOnce()
	if got, want := texts(received), []string{"partial completed", "one", "two", "three complete"}; !reflect.DeepEqual(got, want) { t.Fatalf("got %q, want %q", got, want) }
}

func TestTailerSupportsLinesBeyondScannerDefaultLimit(t *testing.T) {
	path := filepath.Join(t.TempDir(), "Game.log")
	writeTailerFile(t, path, "")
	var received []Line
	tailer := newTestTailer(path, &received)
	tailer.pollOnce()
	longLine := strings.Repeat("x", 70*1024)
	appendTailerFile(t, path, longLine+"\n")
	tailer.pollOnce()
	if len(received) != 1 || received[0].Text != longLine { t.Fatalf("long line was lost or changed: got %d bytes", len(received)) }
}

func TestTailerNormalizesNonPositivePollIntervals(t *testing.T) {
	if got := NewTailer(TailerConfig{}).interval; got != DefaultTailerPollInterval { t.Fatalf("zero interval: got %s", got) }
	if got := NewTailer(TailerConfig{PollInterval: -time.Second}).interval; got != DefaultTailerPollInterval { t.Fatalf("negative interval: got %s", got) }
}

func TestTailerTruncationClearsPartialBuffer(t *testing.T) {
	path := filepath.Join(t.TempDir(), "Game.log")
	writeTailerFile(t, path, "")
	var received []Line
	tailer := newTestTailer(path, &received)
	tailer.pollOnce()
	appendTailerFile(t, path, "old partial")
	tailer.pollOnce()
	if err := os.Truncate(path, 0); err != nil { t.Fatal(err) }
	appendTailerFile(t, path, "new line\n")
	tailer.pollOnce()
	if got := texts(received); !reflect.DeepEqual(got, []string{"new line"}) { t.Fatalf("got %q", got) }
}

func TestTailerTruncationAfterCompleteLinesDoesNotReplayOldLines(t *testing.T) {
	path := filepath.Join(t.TempDir(), "Game.log")
	writeTailerFile(t, path, "")
	var received []Line
	tailer := newTestTailer(path, &received)
	tailer.pollOnce()
	appendTailerFile(t, path, "one\ntwo\n")
	tailer.pollOnce()
	if err := os.Truncate(path, 0); err != nil { t.Fatal(err) }
	appendTailerFile(t, path, "three\n")
	tailer.pollOnce()
	if got, want := texts(received), []string{"one", "two", "three"}; !reflect.DeepEqual(got, want) { t.Fatalf("got %q, want %q", got, want) }
}

func TestTailerRecreationClearsPartialBuffer(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "Game.log")
	oldPath := filepath.Join(dir, "previous.log")
	writeTailerFile(t, path, "")
	var received []Line
	tailer := newTestTailer(path, &received)
	tailer.pollOnce()
	appendTailerFile(t, path, "old partial")
	tailer.pollOnce()
	if err := os.Rename(path, oldPath); err != nil { t.Fatal(err) }
	writeTailerFile(t, path, "new file\n")
	tailer.pollOnce()
	if got := texts(received); !reflect.DeepEqual(got, []string{"new file"}) { t.Fatalf("got %q", got) }
}

func TestTailerSurvivesDisappearanceAndResumesSameFileWithoutDuplicates(t *testing.T) {
	dir := t.TempDir()
	path, parked := filepath.Join(dir, "Game.log"), filepath.Join(dir, "parked.log")
	writeTailerFile(t, path, "")
	var received []Line
	tailer := newTestTailer(path, &received)
	tailer.pollOnce()
	appendTailerFile(t, path, "before\n")
	tailer.pollOnce()
	appendTailerFile(t, path, "partial")
	tailer.pollOnce()
	if err := os.Rename(path, parked); err != nil { t.Fatal(err) }
	tailer.pollOnce()
	tailer.pollOnce()
	if err := os.Rename(parked, path); err != nil { t.Fatal(err) }
	appendTailerFile(t, path, " after\n")
	tailer.pollOnce()
	if got := texts(received); !reflect.DeepEqual(got, []string{"before", "partial after"}) { t.Fatalf("got %q", got) }
}

func TestTailerDisappearanceThenReplacementClearsPartialBuffer(t *testing.T) {
	dir := t.TempDir()
	path, oldPath := filepath.Join(dir, "Game.log"), filepath.Join(dir, "old.log")
	writeTailerFile(t, path, "")
	var received []Line
	tailer := newTestTailer(path, &received)
	tailer.pollOnce()
	appendTailerFile(t, path, "old partial")
	tailer.pollOnce()
	if err := os.Rename(path, oldPath); err != nil { t.Fatal(err) }
	tailer.pollOnce()
	writeTailerFile(t, path, "replacement\n")
	tailer.pollOnce()
	if got := texts(received); !reflect.DeepEqual(got, []string{"replacement"}) { t.Fatalf("got %q", got) }
}

func TestTailerPathSwitchStartsNewPathAtZeroAndDiscardsOldPartial(t *testing.T) {
	dir := t.TempDir()
	live, ptu := filepath.Join(dir, "LIVE", "Game.log"), filepath.Join(dir, "PTU", "Game.log")
	writeTailerFile(t, live, "")
	writeTailerFile(t, ptu, "ptu first\n")
	var received []Line
	tailer := newTestTailer(live, &received)
	tailer.pollOnce()
	appendTailerFile(t, live, "live\nold partial")
	tailer.pollOnce()
	tailer.SetPath(ptu)
	tailer.pollOnce()
	appendTailerFile(t, live, " ignored\n")
	tailer.pollOnce()
	if got, want := texts(received), []string{"live", "ptu first"}; !reflect.DeepEqual(got, want) { t.Fatalf("got %q, want %q", got, want) }
	if received[1].Path != ptu { t.Fatalf("expected PTU source path, got %q", received[1].Path) }
}

func TestTailerSetPathWithSamePathDoesNotReplay(t *testing.T) {
	path := filepath.Join(t.TempDir(), "Game.log")
	writeTailerFile(t, path, "historic\n")
	var received []Line
	tailer := newTestTailer(path, &received)
	tailer.pollOnce()
	appendTailerFile(t, path, "first\n")
	tailer.pollOnce()
	tailer.SetPath(path)
	tailer.pollOnce()
	appendTailerFile(t, path, "second\n")
	tailer.pollOnce()
	if got, want := texts(received), []string{"first", "second"}; !reflect.DeepEqual(got, want) { t.Fatalf("got %q, want %q", got, want) }
}

func TestTailerCallbackOrderingAndReentrantSetPath(t *testing.T) {
	dir := t.TempDir()
	live, ptu := filepath.Join(dir, "LIVE", "Game.log"), filepath.Join(dir, "PTU", "Game.log")
	writeTailerFile(t, live, "")
	writeTailerFile(t, ptu, "ptu\n")
	var received []Line
	var tailer *Tailer
	tailer = NewTailer(TailerConfig{Path: live, PollInterval: time.Millisecond, OnLine: func(line Line) {
		received = append(received, line)
		if line.Text == "switch" { tailer.SetPath(ptu) }
	}})
	tailer.pollOnce()
	appendTailerFile(t, live, "one\nswitch\nstale live line\n")
	tailer.pollOnce()
	tailer.pollOnce()
	if got, want := texts(received), []string{"one", "switch", "ptu"}; !reflect.DeepEqual(got, want) { t.Fatalf("got %q, want %q", got, want) }
	if received[2].Path != ptu { t.Fatalf("expected PTU source path, got %q", received[2].Path) }
}

func TestTailerRunStopsPromptlyOnCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	tailer := NewTailer(TailerConfig{PollInterval: time.Millisecond})
	done := make(chan error, 1)
	go func() { done <- tailer.Run(ctx) }()
	cancel()
	select {
	case err := <-done:
		if err != nil { t.Fatal(err) }
	case <-time.After(time.Second):
		t.Fatal("Run did not stop after cancellation")
	}
}

func TestTailerResumeReadsBytesAppendedBeforeFirstPoll(t *testing.T) {
	path := filepath.Join(t.TempDir(), "Game.log")
	writeTailerFile(t, path, "restored\n")
	info, err := os.Stat(path)
	if err != nil { t.Fatal(err) }
	file, err := os.Open(path)
	if err != nil { t.Fatal(err) }
	anchorOffset, anchor, err := readContinuityAnchor(file, info.Size())
	if closeErr := file.Close(); err == nil { err = closeErr }
	if err != nil { t.Fatal(err) }

	var received []Line
	tailer := newTailerWithResume(TailerConfig{Path: path, OnLine: func(line Line) { received = append(received, line) }}, tailerResume{
		fileInfo: info, offset: info.Size(), anchorOffset: anchorOffset, anchor: anchor,
	}, nil)
	appendTailerFile(t, path, "appended\n")
	tailer.pollOnce()
	if got, want := texts(received), []string{"appended"}; !reflect.DeepEqual(got, want) { t.Fatalf("got %q, want %q", got, want) }
}

func TestTailerResetNotificationPrecedesReplacementLines(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "Game.log")
	oldPath := filepath.Join(dir, "old.log")
	writeTailerFile(t, path, "")
	var order []string
	tailer := newTailerWithResume(TailerConfig{Path: path, OnLine: func(line Line) { order = append(order, "line:"+line.Text) }}, tailerResume{}, func() {
		order = append(order, "reset")
	})
	tailer.pollOnce()
	appendTailerFile(t, path, "old\n")
	tailer.pollOnce()
	if err := os.Rename(path, oldPath); err != nil { t.Fatal(err) }
	writeTailerFile(t, path, "new\n")
	tailer.pollOnce()
	if got, want := order, []string{"line:old", "reset", "line:new"}; !reflect.DeepEqual(got, want) { t.Fatalf("got %q, want %q", got, want) }
}

func TestTailerContinuityAnchorDetectsRapidTruncateAndRegrow(t *testing.T) {
	path := filepath.Join(t.TempDir(), "Game.log")
	writeTailerFile(t, path, "")
	var received []Line
	resetCount := 0
	tailer := newTailerWithResume(TailerConfig{Path: path, OnLine: func(line Line) { received = append(received, line) }}, tailerResume{}, func() {
		resetCount++
	})
	tailer.pollOnce()
	old := strings.Repeat("old-", 1500) + "\n"
	appendTailerFile(t, path, old)
	tailer.pollOnce()
	oldOffset := tailer.Snapshot().Offset

	newContent := "new first\n" + strings.Repeat("new-", int(oldOffset/4)+100) + "\n"
	writeTailerFile(t, path, newContent)
	if int64(len(newContent)) < oldOffset { t.Fatalf("test content %d shorter than old offset %d", len(newContent), oldOffset) }
	tailer.pollOnce()
	if resetCount != 1 { t.Fatalf("resetCount = %d, want 1", resetCount) }
	if len(received) < 2 || received[len(received)-2].Text != "new first" { t.Fatalf("new file was not read from zero: %q", texts(received)) }
}

func TestTailerTemporaryDisappearanceOfSameFileDoesNotReset(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "Game.log")
	parked := filepath.Join(dir, "parked.log")
	writeTailerFile(t, path, "")
	resetCount := 0
	var received []Line
	tailer := newTailerWithResume(TailerConfig{Path: path, OnLine: func(line Line) { received = append(received, line) }}, tailerResume{}, func() {
		resetCount++
	})
	tailer.pollOnce()
	appendTailerFile(t, path, "before\n")
	tailer.pollOnce()
	if err := os.Rename(path, parked); err != nil { t.Fatal(err) }
	tailer.pollOnce()
	if err := os.Rename(parked, path); err != nil { t.Fatal(err) }
	appendTailerFile(t, path, "after\n")
	tailer.pollOnce()
	if resetCount != 0 { t.Fatalf("resetCount = %d, want 0", resetCount) }
	if got, want := texts(received), []string{"before", "after"}; !reflect.DeepEqual(got, want) { t.Fatalf("got %q, want %q", got, want) }
}

func TestTailerContinuityAnchorAdvancesAcrossNormalPartialAppends(t *testing.T) {
	path := filepath.Join(t.TempDir(), "Game.log")
	writeTailerFile(t, path, "")
	resetCount := 0
	var received []Line
	tailer := newTailerWithResume(TailerConfig{Path: path, OnLine: func(line Line) { received = append(received, line) }}, tailerResume{}, func() {
		resetCount++
	})
	tailer.pollOnce()

	first := strings.Repeat("a", 5000) + "\npartial"
	appendTailerFile(t, path, first)
	tailer.pollOnce()
	firstOffset := tailer.Snapshot().Offset
	firstAnchorOffset := tailer.anchorOffset
	firstAnchor := append([]byte(nil), tailer.anchor...)
	if firstAnchorOffset != firstOffset-4096 || !reflect.DeepEqual(firstAnchor, []byte(first[len(first)-4096:])) {
		t.Fatalf("first anchor offset=%d len=%d for read offset=%d", firstAnchorOffset, len(firstAnchor), firstOffset)
	}

	second := " completed\n" + strings.Repeat("b", 5000) + "\n"
	appendTailerFile(t, path, second)
	tailer.pollOnce()
	all := first + second
	secondOffset := tailer.Snapshot().Offset
	if resetCount != 0 { t.Fatalf("resetCount = %d, want 0", resetCount) }
	if got, want := texts(received), []string{strings.Repeat("a", 5000), "partial completed", strings.Repeat("b", 5000)}; !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}
	if secondOffset <= firstOffset || tailer.anchorOffset != secondOffset-4096 || !reflect.DeepEqual(tailer.anchor, []byte(all[len(all)-4096:])) {
		t.Fatalf("advanced anchor offset=%d len=%d for read offset=%d", tailer.anchorOffset, len(tailer.anchor), secondOffset)
	}
	if firstAnchorOffset == tailer.anchorOffset && reflect.DeepEqual(firstAnchor, tailer.anchor) {
		t.Fatal("continuity anchor did not advance with the physical read offset")
	}
}

func TestContinuityAnchorHandlesSmallOffsets(t *testing.T) {
	path := filepath.Join(t.TempDir(), "Game.log")
	content := strings.Repeat("x", 100)
	writeTailerFile(t, path, content)
	file, err := os.Open(path)
	if err != nil { t.Fatal(err) }
	defer file.Close()

	for _, offset := range []int64{0, 1, 100} {
		t.Run(fmt.Sprintf("offset-%d", offset), func(t *testing.T) {
			anchorOffset, anchor, err := readContinuityAnchor(file, offset)
			if err != nil { t.Fatal(err) }
			if anchorOffset != 0 || len(anchor) != int(offset) || string(anchor) != content[:int(offset)] {
				t.Fatalf("anchorOffset=%d len=%d content=%q", anchorOffset, len(anchor), string(anchor))
			}
		})
	}
}
