//go:build !windows && (linux || darwin || freebsd)

package revision

import (
	"fmt"
	"os"
	"syscall"
)

func lockFile(file *os.File) (func(*os.File) error, error) {
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return nil, fmt.Errorf("per-device revision lock unavailable: %w", err)
	}
	return func(file *os.File) error { return syscall.Flock(int(file.Fd()), syscall.LOCK_UN) }, nil
}
func syncDirectory(path string) error {
	dir, err := os.Open(path)
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

func replaceFile(source, destination string) error { return os.Rename(source, destination) }
