// Package revision manages durable, non-secret per-device presence revision metadata.
package revision

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const MaxValue int64 = 9007199254740991

type State struct {
	Version  int    `json:"version"`
	DeviceID string `json:"deviceId"`
	Revision int64  `json:"revision"`
}
type Lock struct {
	file      *os.File
	unlock    func(*os.File) error
	deviceID  string
	directory string
	statePath string
}

func Acquire(directory, deviceID string) (*Lock, State, error) {
	if deviceID == "" || deviceID == "." || deviceID == ".." || filepath.Base(deviceID) != deviceID || strings.ContainsAny(deviceID, ":\\/") {
		return nil, State{}, errors.New("invalid device identity")
	}
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return nil, State{}, fmt.Errorf("create revision directory: %w", err)
	}
	path := filepath.Join(directory, deviceID+".revision.lock")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, State{}, fmt.Errorf("open per-device lock: %w", err)
	}
	unlock, err := lockFile(f)
	if err != nil {
		_ = f.Close()
		return nil, State{}, err
	}
	statePath := filepath.Join(directory, deviceID+".revision.json")
	state, err := load(statePath, deviceID)
	if err != nil {
		_ = unlock(f)
		_ = f.Close()
		return nil, State{}, err
	}
	return &Lock{file: f, unlock: unlock, deviceID: deviceID, directory: directory, statePath: statePath}, state, nil
}

func (l *Lock) Release() error {
	if l == nil || l.file == nil {
		return nil
	}
	err := l.unlock(l.file)
	closeErr := l.file.Close()
	l.file = nil
	if err != nil {
		return err
	}
	return closeErr
}

// Advance allocates and durably stores one revision. Call only after a new snapshot exists.
func (l *Lock) Advance() (State, error) {
	if l == nil || l.file == nil {
		return State{}, errors.New("revision lock is not held")
	}
	state, err := load(l.statePath, l.deviceID)
	if err != nil {
		return State{}, err
	}
	if state.Revision >= MaxValue {
		return State{}, errors.New("revision space exhausted; pair a new device")
	}
	state.Revision++
	if err := l.save(state); err != nil {
		return State{}, err
	}
	return state, nil
}

func (l *Lock) save(state State) error {
	if l == nil || l.file == nil {
		return errors.New("revision lock is not held")
	}
	if state.DeviceID != l.deviceID {
		return errors.New("revision state does not match held lock")
	}
	if state.Version != 1 || state.DeviceID == "" || state.Revision < 0 || state.Revision > MaxValue {
		return errors.New("invalid revision state")
	}
	path := l.statePath
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return errors.New("encode revision state")
	}
	data = append(data, '\n')
	tmp, err := os.CreateTemp(l.directory, ".revision-*.tmp")
	if err != nil {
		return fmt.Errorf("create revision temp file: %w", err)
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err = tmp.Chmod(0o600); err == nil {
		_, err = tmp.Write(data)
	}
	if err == nil {
		err = tmp.Sync()
	}
	closeErr := tmp.Close()
	if err != nil {
		return fmt.Errorf("write revision state: %w", err)
	}
	if closeErr != nil {
		return fmt.Errorf("close revision state: %w", closeErr)
	}
	if err = replaceFile(tmpPath, path); err != nil {
		return fmt.Errorf("replace revision state: %w", err)
	}
	return syncDirectory(l.directory)
}

func load(path, deviceID string) (State, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return State{Version: 1, DeviceID: deviceID}, nil
	}
	if err != nil {
		return State{}, fmt.Errorf("read revision state: %w", err)
	}
	var state State
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if dec.Decode(&state) != nil {
		return State{}, errors.New("invalid revision state")
	}
	var trailing any
	if dec.Decode(&trailing) != io.EOF {
		return State{}, errors.New("invalid revision state")
	}
	if state.Version != 1 || state.DeviceID != deviceID || state.Revision < 0 || state.Revision > MaxValue {
		return State{}, errors.New("invalid revision state")
	}
	return state, nil
}
