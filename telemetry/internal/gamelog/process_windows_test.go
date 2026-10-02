//go:build windows

package gamelog

import "testing"

func TestHiddenWindowsCommandUsesNoWindowProcessAttributes(t *testing.T) {
	command := newHiddenWindowsCommand("powershell.exe", "-NoProfile", "-Command", "Write-Output test")
	if command.SysProcAttr == nil {
		t.Fatal("SysProcAttr is nil")
	}
	if !command.SysProcAttr.HideWindow {
		t.Fatal("HideWindow is not enabled")
	}
	if command.SysProcAttr.CreationFlags&createNoWindow == 0 {
		t.Fatalf("CREATE_NO_WINDOW flag not set: %#x", command.SysProcAttr.CreationFlags)
	}
	if len(command.Args) != 4 || command.Args[0] != "powershell.exe" || command.Args[1] != "-NoProfile" || command.Args[2] != "-Command" || command.Args[3] != "Write-Output test" {
		t.Fatalf("command args changed: %#v", command.Args)
	}
}
