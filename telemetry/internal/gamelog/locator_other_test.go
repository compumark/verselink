//go:build !windows

package gamelog

import "testing"

func TestDefaultLocatorIsExplicitlyUnsupportedOutsideWindows(t *testing.T) {
	result := NewLocator(Config{}).Locate()
	if !result.PlatformUnsupported || result.Found() || !hasAttempt(result, StrategyLauncherLog, OutcomeUnavailable) {
		t.Fatalf("expected unsupported-platform result, got %#v", result)
	}
}
