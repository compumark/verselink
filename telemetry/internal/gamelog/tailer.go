package gamelog

import (
	"bytes"
	"context"
	"io"
	"os"
	"strings"
	"sync"
	"time"
)

const DefaultTailerPollInterval = 150 * time.Millisecond

const tailerContinuityAnchorSize int64 = 4 * 1024

// Line is one complete, unmodified Game.log line. Text has no newline suffix.
type Line struct {
	Path string
	Text string
}

type TailerState string

const (
	TailerWaitingForPath TailerState = "waiting_for_path"
	TailerWaitingForFile TailerState = "waiting_for_file"
	TailerTailing        TailerState = "tailing"
)

// TailerSnapshot is a small read-only view for local diagnostics and tests.
type TailerSnapshot struct {
	Path   string
	State  TailerState
	Offset int64
}

type TailerConfig struct {
	Path         string
	PollInterval time.Duration
	OnLine       func(Line)
}

// Tailer emits newly appended complete lines from one selected Game.log path.
// OnLine runs synchronously on the Run caller's goroutine, in file order.
type Tailer struct {
	mu           sync.Mutex
	path         string
	generation   uint64
	initialPath  bool
	initialProbe bool
	interval     time.Duration
	onLine       func(Line)
	onReset      func()

	activePath       string
	activeGeneration uint64
	fileInfo         os.FileInfo
	offset           int64
	partial          []byte
	anchorOffset     int64
	anchor           []byte
	state            TailerState
}

type tailerResume struct {
	fileInfo     os.FileInfo
	offset       int64
	anchorOffset int64
	anchor       []byte
}

func NewTailer(config TailerConfig) *Tailer {
	interval := config.PollInterval
	if interval <= 0 {
		interval = DefaultTailerPollInterval
	}
	path := strings.TrimSpace(config.Path)
	return &Tailer{
		path:         path,
		generation:   1,
		initialPath:  path != "",
		initialProbe: path != "",
		interval:     interval,
		onLine:       config.OnLine,
		state:        TailerWaitingForPath,
	}
}

// newTailerWithResume is the Session-only handoff path. Unlike NewTailer, it
// starts at the captured byte offset and binds that offset to the identity and
// continuity anchor observed during restore. A nil fileInfo means the file was
// absent during restore and must start at byte zero when it first appears.
func newTailerWithResume(config TailerConfig, resume tailerResume, onReset func()) *Tailer {
	tailer := NewTailer(config)
	tailer.initialProbe = false
	tailer.activePath = tailer.path
	tailer.activeGeneration = tailer.generation
	tailer.fileInfo = resume.fileInfo
	tailer.offset = resume.offset
	tailer.anchorOffset = resume.anchorOffset
	tailer.anchor = append([]byte(nil), resume.anchor...)
	tailer.onReset = onReset
	if tailer.path == "" {
		tailer.state = TailerWaitingForPath
	} else {
		tailer.state = TailerWaitingForFile
	}
	return tailer
}

// SetPath switches the active source. A newly selected path starts at byte zero
// when it appears; it never replays a previously selected path automatically.
func (t *Tailer) SetPath(path string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	path = strings.TrimSpace(path)
	if path == t.path {
		return
	}
	t.path = path
	t.generation++
	t.initialPath = false
	t.initialProbe = false
}

func (t *Tailer) Snapshot() TailerSnapshot {
	t.mu.Lock()
	defer t.mu.Unlock()
	return TailerSnapshot{Path: t.path, State: t.state, Offset: t.offset}
}

// Run watches until ctx is cancelled. Missing files and transient read errors
// are lifecycle conditions, not fatal errors.
func (t *Tailer) Run(ctx context.Context) error {
	t.pollOnce()
	ticker := time.NewTicker(t.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			t.pollOnce()
		}
	}
}

// pollOnce is the deterministic single-poll state transition used by tests.
func (t *Tailer) pollOnce() {
	t.mu.Lock()
	lines, reset := t.pollLocked()
	deliveryGeneration := t.generation
	onLine := t.onLine
	onReset := t.onReset
	t.mu.Unlock()

	if reset && onReset != nil {
		onReset()
	}
	if onLine != nil {
		for _, line := range lines {
			t.mu.Lock()
			generationCurrent := t.generation == deliveryGeneration
			t.mu.Unlock()
			if !generationCurrent {
				return
			}
			onLine(line)
		}
	}
}

func (t *Tailer) pollLocked() ([]Line, bool) {
	if t.activeGeneration != t.generation || t.activePath != t.path {
		t.resetActiveLocked()
	}
	if t.path == "" {
		t.state = TailerWaitingForPath
		return nil, false
	}

	info, err := os.Stat(t.path)
	if err != nil || !info.Mode().IsRegular() {
		// Keep identity, offset, and partial bytes. If the same file returns we
		// can resume safely; a different identity resets below.
		t.state = TailerWaitingForFile
		t.initialProbe = false
		return nil, false
	}

	if t.initialProbe && t.initialPath {
		// The initial file existed at Run start, so begin at EOF and never replay
		// historical contents. A missing first probe instead starts at byte zero.
		t.fileInfo = info
		t.offset = info.Size()
		t.partial = nil
		t.setAnchorFromPathLocked(t.path)
		t.initialProbe = false
		t.state = TailerTailing
		return nil, false
	}
	t.initialProbe = false

	reset := false
	if t.fileInfo == nil || !os.SameFile(t.fileInfo, info) {
		reset = t.fileInfo != nil
		t.fileInfo = info
		t.offset = 0
		t.partial = nil
		t.clearAnchorLocked()
	} else if info.Size() < t.offset {
		// Same identity but shorter content: truncation/restart.
		reset = true
		t.offset = 0
		t.partial = nil
		t.clearAnchorLocked()
	} else if !t.anchorMatchesPathLocked(t.path) {
		// The same identity may have truncated and regrown beyond the old offset
		// between polls. A bounded byte anchor detects the lost continuity.
		reset = true
		t.offset = 0
		t.partial = nil
		t.clearAnchorLocked()
	}

	file, err := os.Open(t.path)
	if err != nil {
		t.state = TailerWaitingForFile
		return nil, reset
	}
	defer file.Close()

	openedInfo, err := file.Stat()
	if err != nil || !openedInfo.Mode().IsRegular() {
		t.state = TailerWaitingForFile
		return nil, reset
	}
	if t.fileInfo == nil || !os.SameFile(t.fileInfo, openedInfo) {
		reset = reset || t.fileInfo != nil
		t.fileInfo = openedInfo
		t.offset = 0
		t.partial = nil
		t.clearAnchorLocked()
	} else if openedInfo.Size() < t.offset {
		reset = true
		t.offset = 0
		t.partial = nil
		t.clearAnchorLocked()
	} else if !t.anchorMatchesFileLocked(file) {
		reset = true
		t.offset = 0
		t.partial = nil
		t.clearAnchorLocked()
	}
	if _, err := file.Seek(t.offset, io.SeekStart); err != nil {
		t.state = TailerWaitingForFile
		return nil, reset
	}

	lines := []Line{}
	buffer := make([]byte, 32*1024)
	for {
		n, readErr := file.Read(buffer)
		if n > 0 {
			t.offset += int64(n)
			lines = append(lines, t.consumeLocked(buffer[:n])...)
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			t.state = TailerWaitingForFile
			t.setAnchorFromFileLocked(file)
			return lines, reset
		}
	}
	t.fileInfo = openedInfo
	t.setAnchorFromFileLocked(file)
	t.state = TailerTailing
	return lines, reset
}

func (t *Tailer) resetActiveLocked() {
	t.activePath = t.path
	t.activeGeneration = t.generation
	t.fileInfo = nil
	t.offset = 0
	t.partial = nil
	t.clearAnchorLocked()
	if t.path == "" {
		t.state = TailerWaitingForPath
	} else {
		t.state = TailerWaitingForFile
	}
}

func (t *Tailer) clearAnchorLocked() {
	t.anchorOffset = 0
	t.anchor = nil
}

func (t *Tailer) anchorMatchesPathLocked(path string) bool {
	if len(t.anchor) == 0 {
		return true
	}
	file, err := os.Open(path)
	if err != nil {
		return true
	}
	defer file.Close()
	return t.anchorMatchesFileLocked(file)
}

func (t *Tailer) anchorMatchesFileLocked(file *os.File) bool {
	if len(t.anchor) == 0 {
		return true
	}
	actual := make([]byte, len(t.anchor))
	if _, err := file.ReadAt(actual, t.anchorOffset); err != nil {
		return false
	}
	return bytes.Equal(actual, t.anchor)
}

func (t *Tailer) setAnchorFromPathLocked(path string) {
	file, err := os.Open(path)
	if err != nil {
		return
	}
	defer file.Close()
	t.setAnchorFromFileLocked(file)
}

func (t *Tailer) setAnchorFromFileLocked(file *os.File) {
	start := t.offset - tailerContinuityAnchorSize
	if start < 0 {
		start = 0
	}
	length := t.offset - start
	if length == 0 {
		t.clearAnchorLocked()
		return
	}
	anchor := make([]byte, length)
	if _, err := file.ReadAt(anchor, start); err != nil {
		return
	}
	t.anchorOffset = start
	t.anchor = anchor
}

func (t *Tailer) consumeLocked(chunk []byte) []Line {
	t.partial = append(t.partial, chunk...)
	lines := []Line{}
	for {
		newline := bytes.IndexByte(t.partial, '\n')
		if newline < 0 {
			return lines
		}
		line := t.partial[:newline]
		if len(line) > 0 && line[len(line)-1] == '\r' {
			line = line[:len(line)-1]
		}
		lines = append(lines, Line{Path: t.activePath, Text: string(line)})
		t.partial = t.partial[newline+1:]
	}
}
