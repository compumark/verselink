package gamelog

import (
	"fmt"
	"strings"
)

// ValidateGameLogPath verifies a user-supplied Game.log without modifying it.
// Passing fs keeps the check deterministic in tests; nil uses the host filesystem.
func ValidateGameLogPath(path string, fs FileSystem) error {
	path = strings.TrimSpace(path)
	if path == "" {
		return fmt.Errorf("select a Game.log file")
	}
	if !strings.EqualFold(windowsBase(path), "Game.log") {
		return fmt.Errorf("select the Game.log file, not a folder or another file")
	}
	if fs == nil {
		fs = osFileSystem{}
	}
	regular, err := fs.IsRegular(path)
	if err != nil {
		return fmt.Errorf("Game.log does not exist or cannot be inspected")
	}
	if !regular {
		return fmt.Errorf("Game.log must be a regular file")
	}
	file, err := fs.OpenRead(path)
	if err != nil {
		return fmt.Errorf("Game.log cannot be opened read-only")
	}
	_ = file.Close()
	return nil
}
