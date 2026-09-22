package gamelog

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/compumark/verselink-telemetry/internal/telemetry"
)

const (
	restoreSearchBlockSize = 64 * 1024
	maxBoundaryLineSize    = 1024 * 1024
)

type SessionConfig struct {
	Path         string
	PollInterval time.Duration
}

// RestoreInfo contains byte offsets and counts useful for local diagnostics.
// It deliberately retains no Game.log content.
type RestoreInfo struct {
	Path           string
	BoundaryFound  bool
	BoundaryOffset int64
	ResumeOffset   int64
	// ReplayedLines counts complete raw lines presented to the parser from
	// BoundaryOffset through ResumeOffset, whether or not they emit events.
	ReplayedLines  int
}

// Session coordinates one Parser, one TelemetryState, and one live Tailer.
// The same Parser instance is used for startup replay and live processing.
type Session struct {
	mu     sync.RWMutex
	parser *Parser
	state  telemetry.TelemetryState
	tailer *Tailer
}

func NewSession(config SessionConfig) (*Session, RestoreInfo, error) {
	path := strings.TrimSpace(config.Path)
	info := RestoreInfo{Path: path}
	session := &Session{parser: NewParser()}

	file, fileInfo, err := openRestoreFile(path)
	if err != nil {
		return nil, info, err
	}
	if file == nil {
		session.tailer = session.newTailer(config, tailerResume{})
		return session, info, nil
	}
	defer file.Close()

	snapshotSize := fileInfo.Size()
	resumeOffset, err := findLastCompleteOffset(file, snapshotSize)
	if err != nil {
		return nil, info, fmt.Errorf("inspect complete Game.log lines: %w", err)
	}
	info.ResumeOffset = resumeOffset

	boundaryOffset, found, err := findLatestLoginBoundary(file, resumeOffset)
	if err != nil {
		return nil, info, fmt.Errorf("find latest player_login boundary: %w", err)
	}
	if found {
		info.BoundaryFound = true
		info.BoundaryOffset = boundaryOffset
		replayed, replayErr := session.replay(file, boundaryOffset, resumeOffset)
		if replayErr != nil {
			return nil, info, fmt.Errorf("replay current Game.log session: %w", replayErr)
		}
		info.ReplayedLines = replayed
	}

	anchorOffset, anchor, err := readContinuityAnchor(file, resumeOffset)
	if err != nil {
		return nil, info, fmt.Errorf("capture Game.log continuity anchor: %w", err)
	}
	session.tailer = session.newTailer(config, tailerResume{
		fileInfo:     fileInfo,
		offset:       resumeOffset,
		anchorOffset: anchorOffset,
		anchor:       anchor,
	})
	return session, info, nil
}

func (s *Session) Run(ctx context.Context) error {
	return s.tailer.Run(ctx)
}

// Snapshot returns a deep-enough copy that cannot mutate Session-owned state.
func (s *Session) Snapshot() telemetry.TelemetryState {
	s.mu.RLock()
	defer s.mu.RUnlock()

	snapshot := s.state
	if s.state.Location != nil {
		location := *s.state.Location
		snapshot.Location = &location
	}
	if s.state.Ship != nil {
		ship := *s.state.Ship
		snapshot.Ship = &ship
	}
	if s.state.Quantum != nil {
		quantum := *s.state.Quantum
		snapshot.Quantum = &quantum
	}
	if s.state.Party != nil {
		snapshot.Party = append([]string{}, s.state.Party...)
	}
	return snapshot
}

func (s *Session) newTailer(config SessionConfig, resume tailerResume) *Tailer {
	return newTailerWithResume(TailerConfig{
		Path:         strings.TrimSpace(config.Path),
		PollInterval: config.PollInterval,
		OnLine:       s.processLine,
	}, resume, s.resetSource)
}

func (s *Session) replay(file *os.File, start, end int64) (int, error) {
	reader := bufio.NewReader(io.NewSectionReader(file, start, end-start))
	count := 0
	for {
		line, err := reader.ReadString('\n')
		if len(line) > 0 && strings.HasSuffix(line, "\n") {
			line = strings.TrimSuffix(line, "\n")
			line = strings.TrimSuffix(line, "\r")
			s.processLine(Line{Text: line})
			count++
		}
		if err == io.EOF {
			return count, nil
		}
		if err != nil {
			return count, err
		}
	}
}

func (s *Session) processLine(line Line) {
	s.mu.Lock()
	defer s.mu.Unlock()

	event, ok := s.parser.Parse(line.Text)
	if !ok {
		return
	}
	if event.Type == "player_login" {
		s.state = telemetry.TelemetryState{}
	}
	telemetry.Reduce(&s.state, event)
}

func (s *Session) resetSource() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.parser = NewParser()
	s.state = telemetry.TelemetryState{}
}

func openRestoreFile(path string) (*os.File, os.FileInfo, error) {
	file, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil, nil
		}
		return nil, nil, fmt.Errorf("open Game.log %q: %w", path, err)
	}
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return nil, nil, fmt.Errorf("stat Game.log %q: %w", path, err)
	}
	if !info.Mode().IsRegular() {
		file.Close()
		return nil, nil, fmt.Errorf("Game.log %q is not a regular file", path)
	}
	return file, info, nil
}

func findLastCompleteOffset(file *os.File, size int64) (int64, error) {
	buffer := make([]byte, restoreSearchBlockSize)
	for end := size; end > 0; {
		start := end - int64(len(buffer))
		if start < 0 {
			start = 0
		}
		chunk := buffer[:end-start]
		if _, err := file.ReadAt(chunk, start); err != nil {
			return 0, err
		}
		if index := bytes.LastIndexByte(chunk, '\n'); index >= 0 {
			return start + int64(index) + 1, nil
		}
		end = start
	}
	return 0, nil
}

func findLatestLoginBoundary(file *os.File, end int64) (int64, bool, error) {
	buffer := make([]byte, restoreSearchBlockSize)
	lineEnd := end
	for cursor := end; cursor > 0; {
		start := cursor - int64(len(buffer))
		if start < 0 {
			start = 0
		}
		chunk := buffer[:cursor-start]
		if _, err := file.ReadAt(chunk, start); err != nil {
			return 0, false, err
		}
		for index := len(chunk) - 1; index >= 0; index-- {
			if chunk[index] != '\n' {
				continue
			}
			lineStart := start + int64(index) + 1
			if lineStart < lineEnd {
				match, err := rangeIsPlayerLogin(file, lineStart, lineEnd)
				if err != nil {
					return 0, false, err
				}
				if match {
					return lineStart, true, nil
				}
			}
			lineEnd = start + int64(index)
		}
		cursor = start
	}
	if lineEnd > 0 {
		match, err := rangeIsPlayerLogin(file, 0, lineEnd)
		if err != nil {
			return 0, false, err
		}
		if match {
			return 0, true, nil
		}
	}
	return 0, false, nil
}

func rangeIsPlayerLogin(file *os.File, start, end int64) (bool, error) {
	length := end - start
	if length <= 0 || length > maxBoundaryLineSize {
		return false, nil
	}
	line := make([]byte, length)
	if _, err := file.ReadAt(line, start); err != nil {
		return false, err
	}
	line = bytes.TrimSuffix(line, []byte{'\r'})
	event, ok := NewParser().Parse(string(line))
	return ok && event.Type == "player_login", nil
}

func readContinuityAnchor(file *os.File, offset int64) (int64, []byte, error) {
	start := offset - tailerContinuityAnchorSize
	if start < 0 {
		start = 0
	}
	length := offset - start
	if length == 0 {
		return 0, nil, nil
	}
	anchor := make([]byte, length)
	if _, err := file.ReadAt(anchor, start); err != nil {
		return 0, nil, err
	}
	return start, anchor, nil
}
