package main

import (
	"errors"
	"fmt"
	"strings"
)

const autostartArgument = "--autostart"

type autostartState string

const (
	autostartDisabled autostartState = "disabled"
	autostartEnabled  autostartState = "enabled"
	autostartStale    autostartState = "stale"
)

var errAutostartConflict = errors.New("an existing Start with Windows entry needs explicit repair")

type runValueStore interface {
	read() (value string, found bool, err error)
	write(value string) error
	delete() error
}

type autostartManager struct {
	store      runValueStore
	executable string
}

func (m autostartManager) command() string {
	return quoteWindowsArgument(m.executable) + " " + autostartArgument
}

func (m autostartManager) state() (autostartState, error) {
	value, found, err := m.store.read()
	if err != nil {
		return "", err
	}
	if !found {
		return autostartDisabled, nil
	}
	if value == m.command() {
		return autostartEnabled, nil
	}
	return autostartStale, nil
}

func (m autostartManager) enable() error {
	state, err := m.state()
	if err != nil {
		return err
	}
	switch state {
	case autostartEnabled:
		return nil
	case autostartStale:
		return errAutostartConflict
	default:
		return m.store.write(m.command())
	}
}

// repair is only called from the explicit Repair button. It may replace the
// app's stable Run value after the user confirms that the executable moved.
func (m autostartManager) repair() error {
	return m.store.write(m.command())
}

// disable removes only VerseLink Telemetry's stable Run value. It never edits
// another registry value or tries to remove the Startup folder or a task.
func (m autostartManager) disable() error {
	_, found, err := m.store.read()
	if err != nil || !found {
		return err
	}
	return m.store.delete()
}

func quoteWindowsArgument(value string) string {
	if value == "" {
		return `""`
	}
	needsQuotes := strings.ContainsAny(value, " \t\n\v\"")
	if !needsQuotes {
		return value
	}
	var out strings.Builder
	out.Grow(len(value) + 2)
	out.WriteByte('"')
	backslashes := 0
	for _, char := range value {
		switch char {
		case '\\':
			backslashes++
		case '"':
			out.WriteString(strings.Repeat(`\`, backslashes*2+1))
			out.WriteRune(char)
			backslashes = 0
		default:
			out.WriteString(strings.Repeat(`\`, backslashes))
			backslashes = 0
			out.WriteRune(char)
		}
	}
	out.WriteString(strings.Repeat(`\`, backslashes*2))
	out.WriteByte('"')
	return out.String()
}

func parseLaunchArguments(args []string) (autostart bool, err error) {
	if len(args) == 0 {
		return false, nil
	}
	if len(args) == 1 && args[0] == autostartArgument {
		return true, nil
	}
	return false, fmt.Errorf("unsupported command-line arguments")
}
