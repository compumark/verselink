package diagnostics

import "testing"

func TestBannerUsesStableDefaults(t *testing.T) {
	got := Banner(BuildMetadata{})
	want := "VerseLink Telemetry\nVersion: dev\nCommit: unknown"
	if got != want {
		t.Fatalf("Banner() = %q, want %q", got, want)
	}
}

func TestBannerIncludesBuildMetadata(t *testing.T) {
	got := Banner(BuildMetadata{Version: "0.1.0", Commit: "abc123"})
	want := "VerseLink Telemetry\nVersion: 0.1.0\nCommit: abc123"
	if got != want {
		t.Fatalf("Banner() = %q, want %q", got, want)
	}
}
