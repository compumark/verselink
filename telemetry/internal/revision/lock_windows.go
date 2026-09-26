//go:build windows

package revision

import (
	"fmt"
	"os"
	"syscall"
	"unsafe"
)

var kernel32 = syscall.NewLazyDLL("kernel32.dll")
var procLockFileEx = kernel32.NewProc("LockFileEx")
var procUnlockFileEx = kernel32.NewProc("UnlockFileEx")
var procMoveFileEx = kernel32.NewProc("MoveFileExW")

const lockfileFailImmediately = 1
const lockfileExclusive = 2
const movefileReplaceExisting = 1
const movefileWriteThrough = 8

func lockFile(file *os.File) (func(*os.File) error, error) {
	var overlapped syscall.Overlapped
	r, _, err := procLockFileEx.Call(file.Fd(), lockfileExclusive|lockfileFailImmediately, 0, 0xffffffff, 0xffffffff, uintptr(unsafe.Pointer(&overlapped)))
	if r == 0 {
		return nil, fmt.Errorf("per-device revision lock unavailable: %w", err)
	}
	return func(file *os.File) error {
		r, _, err := procUnlockFileEx.Call(file.Fd(), 0, 0xffffffff, 0xffffffff, uintptr(unsafe.Pointer(&overlapped)))
		if r == 0 {
			return fmt.Errorf("release per-device revision lock: %w", err)
		}
		return nil
	}, nil
}
func syncDirectory(string) error { return nil }

func replaceFile(source, destination string) error {
	src, _ := syscall.UTF16PtrFromString(source)
	dst, _ := syscall.UTF16PtrFromString(destination)
	r, _, err := procMoveFileEx.Call(uintptr(unsafe.Pointer(src)), uintptr(unsafe.Pointer(dst)), movefileReplaceExisting|movefileWriteThrough)
	if r == 0 {
		return fmt.Errorf("replace revision state atomically: %w", err)
	}
	return nil
}
