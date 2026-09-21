package diagnostics

import "fmt"

// BuildMetadata contains the identity information exposed by the A1 executable.
type BuildMetadata struct {
	Version string
	Commit  string
}

// Banner returns deterministic human-readable startup output.
func Banner(metadata BuildMetadata) string {
	version := metadata.Version
	if version == "" {
		version = "dev"
	}
	commit := metadata.Commit
	if commit == "" {
		commit = "unknown"
	}
	return fmt.Sprintf("VerseLink Telemetry\nVersion: %s\nCommit: %s", version, commit)
}
