//go:build windows

package gamelog

import (
	"os/exec"
	"syscall"
)

const createNoWindow = 0x08000000

func newHiddenWindowsCommand(name string, args ...string) *exec.Cmd {
	command := exec.Command(name, args...)
	command.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: createNoWindow,
	}
	return command
}
