//go:build !windows

package gamelog

func platformLocatorDefaults() locatorDefaults { return locatorDefaults{fs: osFileSystem{}} }
