package settings

import (
	"fmt"
	"github.com/compumark/verselink-telemetry/internal/connection"
	"path/filepath"
	"strings"
)

const CurrentVersion = 2

type Mode string

const (
	ModeAuto   Mode = "auto"
	ModeManual Mode = "manual"
)

type Settings struct {
	Version    int              `json:"version"`
	GameLog    GameLogConfig    `json:"gameLog"`
	Connection ConnectionConfig `json:"connection,omitempty"`
}

// ConnectionConfig contains non-secret instance/device metadata only.
type ConnectionConfig struct {
	ServerURL  string `json:"serverUrl,omitempty"`
	DeviceID   string `json:"deviceId,omitempty"`
	DeviceName string `json:"deviceName,omitempty"`
	Revision   int64  `json:"revision,omitempty"`
}

type GameLogConfig struct {
	Mode       Mode   `json:"mode"`
	ManualPath string `json:"manualPath"`
}

func Defaults() Settings {
	return Settings{Version: CurrentVersion, GameLog: GameLogConfig{Mode: ModeAuto}}
}

func Normalize(value Settings) (Settings, error) {
	if value.Version == 1 {
		value.Version = CurrentVersion
	}
	if value.Version != CurrentVersion {
		return Defaults(), fmt.Errorf("unsupported settings version %d", value.Version)
	}
	value.GameLog.Mode = Mode(strings.ToLower(strings.TrimSpace(string(value.GameLog.Mode))))
	value.GameLog.ManualPath = strings.TrimSpace(value.GameLog.ManualPath)
	switch value.GameLog.Mode {
	case ModeAuto:
		value.GameLog.Mode = ModeAuto
		value.GameLog.ManualPath = ""
	case ModeManual:
		if value.GameLog.ManualPath == "" {
			return Defaults(), fmt.Errorf("manual mode requires a Game.log path")
		}
	default:
		return Defaults(), fmt.Errorf("unsupported Game.log mode %q", value.GameLog.Mode)
	}
	value.Connection.ServerURL = strings.TrimSpace(value.Connection.ServerURL)
	if value.Connection.ServerURL != "" {
		serverURL, err := connection.ValidateStoredServerURL(value.Connection.ServerURL, true)
		if err != nil {
			return Defaults(), err
		}
		value.Connection.ServerURL = serverURL
	}
	value.Connection.DeviceID = strings.TrimSpace(value.Connection.DeviceID)
	value.Connection.DeviceName = strings.TrimSpace(value.Connection.DeviceName)
	if value.Connection.Revision < 0 || value.Connection.Revision > 9007199254740991 {
		return Defaults(), fmt.Errorf("invalid connection revision")
	}
	if len(value.Connection.DeviceID) > 64 || len(value.Connection.DeviceName) > 256 {
		return Defaults(), fmt.Errorf("invalid connection metadata")
	}
	return value, nil
}

func LocalSettingsPath(localAppData string) (string, error) {
	if strings.TrimSpace(localAppData) == "" {
		return "", fmt.Errorf("LOCALAPPDATA is not set")
	}
	return filepath.Join(localAppData, "VerseLink", "Telemetry", "settings.json"), nil
}

// ChannelFromPath recognizes <...>/StarCitizen/<channel>/Game.log and allows
// channel names introduced by future Star Citizen releases.
func ChannelFromPath(path string) string {
	clean := strings.TrimRight(strings.TrimSpace(path), `/\`)
	parts := strings.FieldsFunc(clean, func(r rune) bool { return r == '/' || r == '\\' })
	if len(parts) < 3 || !strings.EqualFold(parts[len(parts)-1], "Game.log") || !strings.EqualFold(parts[len(parts)-3], "StarCitizen") {
		return ""
	}
	return parts[len(parts)-2]
}
