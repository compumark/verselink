//go:build windows

package gamelog

import (
	"os"
	"os/exec"
	"sort"
	"syscall"
)

func platformLocatorDefaults() locatorDefaults {
	logs := []string{}
	if appData := os.Getenv("APPDATA"); appData != "" { logs = []string{joinPath(appData, `rsilauncher\logs\log.log`), joinPath(appData, `rsilauncher\logs\log.old.log`)} }
	return locatorDefaults{
		platformSupported: true,
		launcherLogPaths: logs,
		knownRoots:       knownWindowsRoots(),
		processQuery:     queryStarCitizenProcesses,
		registryRoots:    queryRegistryRoots,
		fs:               osFileSystem{},
	}
}

func queryStarCitizenProcesses() (string, error) {
	return runWindowsCommand("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", `Get-CimInstance Win32_Process -Filter "Name = 'StarCitizen.exe'" | ForEach-Object { $_.ExecutablePath }`)
}

func queryRegistryRoots() ([]string, error) {
	keys := []string{`HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\RSI Launcher`, `HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall\RSI Launcher`, `HKLM\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\RSI Launcher`}
	roots := []string{}; var lastErr error
	for _, key := range keys {
		output, err := runWindowsCommand("reg.exe", "query", key, "/v", "InstallLocation")
		if err != nil { lastErr = err; continue }
		roots = append(roots, registryInstallLocations(output)...)
	}
	if len(roots) == 0 && lastErr != nil { return nil, lastErr }; return uniquePaths(roots), nil
}
func runWindowsCommand(name string, args ...string) (string, error) { output, err := exec.Command(name, args...).Output(); return string(output), err }
func knownWindowsRoots() []string {
	letters := []string{"C"}; mask, _, _ := syscall.NewLazyDLL("kernel32.dll").NewProc("GetLogicalDrives").Call()
	for i := 0; i < 26; i++ { if mask&(1<<uint(i)) != 0 { letter := string(rune('A'+i)); if !containsFold(letters, letter) { letters = append(letters, letter) } } }
	sort.Strings(letters)
	patterns := []string{`Program Files\Roberts Space Industries\StarCitizen`, `Roberts Space Industries\StarCitizen`, `Games\Roberts Space Industries\StarCitizen`, `Games\StarCitizen`, `Star Citizen`, `StarCitizen`, `SC\StarCitizen`, `RSI\StarCitizen`}
	roots := []string{}; for _, letter := range letters { for _, pattern := range patterns { roots = append(roots, letter+`:\`+pattern) } }; return roots
}
