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

	activePath       string
	activeGeneration uint64
	fileInfo         os.FileInfo
	offset           int64
	partial          []byte
	state            TailerState
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
	lines := t.pollLocked()
	onLine := t.onLine
	t.mu.Unlock()

	if onLine != nil {
		for _, line := range lines {
			onLine(line)
		}
	}
}

func (t *Tailer) pollLocked() []Line {
	if t.activeGeneration != t.generation || t.activePath != t.path {
		t.resetActiveLocked()
	}
	if t.path == "" {
		t.state = TailerWaitingForPath
		return nil
	}

	info, err := os.Stat(t.path)
	if err != nil || !info.Mode().IsRegular() {
		// Keep identity, offset, and partial bytes. If the same file returns we
		// can resume safely; a different identity resets below.
		t.state = TailerWaitingForFile
		t.initialProbe = false
		return nil
	}

	if t.initialProbe && t.initialPath {
		// The initial file existed at Run start, so begin at EOF and never replay
		// historical contents. A missing first probe instead starts at byte zero.
		t.fileInfo = info
		t.offset = info.Size()
		t.partial = nil
		t.initialProbe = false
		t.state = TailerTailing
		return nil
	}
	t.initialProbe = false

	if t.fileInfo == nil || !os.SameFile(t.fileInfo, info) {
		t.fileInfo = info
		t.offset = 0
		t.partial = nil
	} else if info.Size() < t.offset {
		// Same identity but shorter content: truncation/restart. Never join old
		// partial bytes with post-truncation bytes.
		t.offset = 0
		t.partial = nil
	}

	file, err := os.Open(t.path)
	if err != nil {
		t.state = TailerWaitingForFile
		return nil
	}
	defer file.Close()

	openedInfo, err := file.Stat()
	if err != nil || !openedInfo.Mode().IsRegular() {
		t.state = TailerWaitingForFile
		return nil
	}
	if t.fileInfo == nil || !os.SameFile(t.fileInfo, openedInfo) {
		t.fileInfo = openedInfo
		t.offset = 0
		t.partial = nil
	} else if openedInfo.Size() < t.offset {
		t.offset = 0
		t.partial = nil
	}
	if _, err := file.Seek(t.offset, io.SeekStart); err != nil {
		t.state = TailerWaitingForFile
		return nil
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
			return lines
		}
	}
	t.fileInfo = openedInfo
	t.state = TailerTailing
	return lines
}

func (t *Tailer) resetActiveLocked() {
	t.activePath = t.path
	t.activeGeneration = t.generation
	t.fileInfo = nil
	t.offset = 0
	t.partial = nil
	if t.path == "" {
		t.state = TailerWaitingForPath
	} else {
		t.state = TailerWaitingForFile
	}
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
