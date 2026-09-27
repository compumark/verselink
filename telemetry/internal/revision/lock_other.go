//go:build !windows && !(linux || darwin || freebsd)

package revision

import (
	"errors"
	"os"
)

func lockFile(*os.File) (func(*os.File) error, error) {
	return nil, errors.New("exclusive OS file locking is unsupported on this platform")
}
func syncDirectory(string) error                   { return nil }
func replaceFile(source, destination string) error { return os.Rename(source, destination) }
