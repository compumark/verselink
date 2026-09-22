package gamelog

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/compumark/verselink-telemetry/internal/telemetry"
)

func sessionLogin(second int, handle string) string {
	return fmt.Sprintf(`<2026-09-22T10:00:%02dZ> [Notice] nickname="%s" playerGEID=123456789`, second, handle)
}

func sessionShard(second int, shard string) string {
	return fmt.Sprintf(`<2026-09-22T10:00:%02dZ> [Notice] <Join PU> connection established shard[%s]`, second, shard)
}

func sessionSpawn(second int) string {
	return fmt.Sprintf(`<2026-09-22T10:00:%02dZ> [Notice] [CSessionManager::OnClientSpawned] Spawned!`, second)
}

func sessionLocation(second int, location string) string {
	return fmt.Sprintf(`<2026-09-22T10:00:%02dZ> [Notice] <RequestLocationInventory> Player[TestPilot] requested inventory for Location[%s]`, second, location)
}

func sessionJurisdiction(second int, jurisdiction string) string {
	return fmt.Sprintf(`<2026-09-22T10:00:%02dZ> [Notice] <SHUDEvent_OnNotification> Added notification "Entered %s Jurisdiction: "`, second, jurisdiction)
}

func sessionQuantumTarget(second int, destination string) string {
	return fmt.Sprintf(`<2026-09-22T10:00:%02dZ> Player has selected point %s as their destination`, second, destination)
}

func sessionShip(second int, ship string) string {
	return fmt.Sprintf(`<2026-09-22T10:00:%02dZ> [Notice] <SHUDEvent_OnNotification> Added notification "You have joined channel '@vehicle_Name%s : TestOwner'.`, second, ship)
}

func sessionPartyHeader(second int) string {
	return fmt.Sprintf(`<2026-09-22T10:00:%02dZ> [Notice] <SHUDEvent_OnNotification> Added notification "New Member Joined`, second)
}

func sessionPartyJoin(second int, player string) string {
	return fmt.Sprintf(`<2026-09-22T10:00:%02dZ> %s has joined the party.`, second, player)
}

func joined(lines ...string) string {
	return strings.Join(lines, "\n") + "\n"
}

func TestSessionRestoresOnlyLatestLoginBoundary(t *testing.T) {
	path := filepath.Join(t.TempDir(), "Game.log")
	currentLogin := sessionLogin(10, "CurrentPilot")
	content := joined(
		sessionLogin(0, "OldPilot"),
		sessionShard(1, "old_shard"),
		sessionSpawn(2),
		sessionLocation(3, "OLD_LOCATION"),
		sessionJurisdiction(4, "Pyro"),
		sessionShip(5, "OldShip"),
		sessionQuantumTarget(6, "OLD_DESTINATION"),
		sessionPartyHeader(7),
		sessionPartyJoin(8, "OldCrew"),
		currentLogin,
		sessionShard(11, "current_shard"),
		sessionSpawn(12),
		sessionLocation(13, "CURRENT_LOCATION"),
	)
	writeTailerFile(t, path, content)

	session, info, err := NewSession(SessionConfig{Path: path})
	if err != nil { t.Fatal(err) }
	state := session.Snapshot()
	if !info.BoundaryFound || info.BoundaryOffset != int64(strings.LastIndex(content, currentLogin)) || info.ResumeOffset != int64(len(content)) || info.ReplayedLines != 4 {
		t.Fatalf("restore info = %#v", info)
	}
	if state.PlayerHandle != "CurrentPilot" || state.Shard != "current_shard" || !state.SessionActive || state.Location == nil || state.Location.Raw != "CURRENT_LOCATION" {
		t.Fatalf("restored state = %#v", state)
	}
	if state.Ship != nil || state.Quantum != nil || len(state.Party) != 0 || state.Jurisdiction != "" || strings.Contains(fmt.Sprintf("%#v", state), "old_shard") {
		t.Fatalf("old session leaked into state: %#v", state)
	}
	if !state.LastEventAt.Equal(time.Date(2026, 9, 22, 10, 0, 13, 0, time.UTC)) || !state.Location.ObservedAt.Equal(state.LastEventAt) {
		t.Fatalf("timestamps = LastEventAt %s, Location %#v", state.LastEventAt, state.Location)
	}
}

func TestSessionRestoresPartialCurrentSessionAndLatestOfMultipleLogins(t *testing.T) {
	path := filepath.Join(t.TempDir(), "Game.log")
	content := joined(
		sessionLogin(0, "PilotA"),
		sessionSpawn(1),
		sessionLogin(2, "PilotB"),
		sessionSpawn(3),
		sessionLogin(4, "PilotC"),
		sessionShard(5, "current_shard"),
	)
	writeTailerFile(t, path, content)
	session, info, err := NewSession(SessionConfig{Path: path})
	if err != nil { t.Fatal(err) }
	state := session.Snapshot()
	if !info.BoundaryFound || info.ReplayedLines != 2 || state.PlayerHandle != "PilotC" || state.Shard != "current_shard" || state.SessionActive {
		t.Fatalf("info = %#v, state = %#v", info, state)
	}
}

func TestSessionDoesNotReplayWithoutValidLoginBoundary(t *testing.T) {
	for _, test := range []struct {
		name    string
		content string
	}{
		{"no login", joined("arbitrary", sessionShard(1, "old_shard"), sessionSpawn(2), sessionLocation(3, "OLD"))},
		{"invalid login like", joined(`<2026-09-22T10:00:00Z> [Notice] nickname="Pilot" login accepted`, sessionSpawn(1))},
	} {
		t.Run(test.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "Game.log")
			writeTailerFile(t, path, test.content)
			session, info, err := NewSession(SessionConfig{Path: path})
			if err != nil { t.Fatal(err) }
			if info.BoundaryFound || info.ReplayedLines != 0 || info.ResumeOffset != int64(len(test.content)) {
				t.Fatalf("restore info = %#v", info)
			}
			if got := session.Snapshot(); !reflect.DeepEqual(got, (sessionZeroState())) {
				t.Fatalf("state = %#v", got)
			}
			diagnostics := session.Diagnostics()
			if diagnostics.LinesProcessed != 0 || diagnostics.ParserEventCount != 0 || diagnostics.SourceResetCount != 0 {
				t.Fatalf("skipped history diagnostics = %#v", diagnostics)
			}
		})
	}
}

func TestSessionNoGapHandoffAndNoDuplicateReplay(t *testing.T) {
	path := filepath.Join(t.TempDir(), "Game.log")
	content := joined(sessionLogin(0, "Pilot"), sessionSpawn(1))
	writeTailerFile(t, path, content)
	session, info, err := NewSession(SessionConfig{Path: path})
	if err != nil { t.Fatal(err) }
	originalOnLine := session.tailer.onLine
	callbackCount := 0
	session.tailer.onLine = func(line Line) {
		callbackCount++
		originalOnLine(line)
	}
	before := session.Snapshot()
	if session.tailer.Snapshot().Offset != info.ResumeOffset { t.Fatalf("tailer offset = %d, resume = %d", session.tailer.Snapshot().Offset, info.ResumeOffset) }
	session.tailer.pollOnce()
	if callbackCount != 0 { t.Fatalf("first poll processed %d restored lines, want 0", callbackCount) }
	if after := session.Snapshot(); !reflect.DeepEqual(after, before) { t.Fatalf("replay duplicated on first poll: before %#v after %#v", before, after) }
	appendTailerFile(t, path, sessionShard(2, "appended_shard")+"\n")
	session.tailer.pollOnce()
	if callbackCount != 1 { t.Fatalf("callback count = %d, want exactly 1 appended line", callbackCount) }
	if got := session.Snapshot(); got.Shard != "appended_shard" { t.Fatalf("appended line skipped: %#v", got) }
}

func TestSessionPartyPendingSurvivesRestoreToLive(t *testing.T) {
	path := filepath.Join(t.TempDir(), "Game.log")
	writeTailerFile(t, path, joined(sessionLogin(0, "Pilot"), sessionPartyHeader(1)))
	session, _, err := NewSession(SessionConfig{Path: path})
	if err != nil { t.Fatal(err) }
	appendTailerFile(t, path, sessionPartyJoin(2, "CrewMate")+"\n")
	session.tailer.pollOnce()
	if got := session.Snapshot().Party; !reflect.DeepEqual(got, []string{"CrewMate"}) { t.Fatalf("Party = %#v", got) }
}

func TestSessionTrailingPartialPartyContinuationHandoff(t *testing.T) {
	path := filepath.Join(t.TempDir(), "Game.log")
	prefix := `<2026-09-22T10:00:02Z> CrewMate has joi`
	complete := joined(sessionLogin(0, "Pilot"), sessionPartyHeader(1))
	writeTailerFile(t, path, complete+prefix)
	session, info, err := NewSession(SessionConfig{Path: path})
	if err != nil { t.Fatal(err) }
	if info.ResumeOffset != int64(len(complete)) { t.Fatalf("ResumeOffset = %d, want %d", info.ResumeOffset, len(complete)) }
	appendTailerFile(t, path, "ned the party.\n")
	session.tailer.pollOnce()
	session.tailer.pollOnce()
	if got := session.Snapshot().Party; !reflect.DeepEqual(got, []string{"CrewMate"}) { t.Fatalf("Party = %#v", got) }
}

func TestSessionRestoreHandlesCRLFLongLinesAndIncompleteTail(t *testing.T) {
	path := filepath.Join(t.TempDir(), "Game.log")
	longNoise := strings.Repeat("x", 80*1024)
	partialSpawn := sessionSpawn(3)
	complete := strings.Join([]string{sessionLogin(0, "Pilot"), longNoise, sessionShard(2, "current_shard")}, "\r\n") + "\r\n"
	writeTailerFile(t, path, complete+partialSpawn)

	session, info, err := NewSession(SessionConfig{Path: path})
	if err != nil { t.Fatal(err) }
	state := session.Snapshot()
	if info.ReplayedLines != 3 || info.ResumeOffset != int64(len(complete)) || state.PlayerHandle != "Pilot" || state.Shard != "current_shard" || state.SessionActive {
		t.Fatalf("info = %#v, state = %#v", info, state)
	}
	appendTailerFile(t, path, "\r\n")
	session.tailer.pollOnce()
	if !session.Snapshot().SessionActive { t.Fatal("completed trailing player_spawned line was not processed") }
}

func TestSessionFileWithOnlyPartialLineResumesAtZero(t *testing.T) {
	path := filepath.Join(t.TempDir(), "Game.log")
	partialLogin := sessionLogin(0, "PartialPilot")
	writeTailerFile(t, path, partialLogin)
	session, info, err := NewSession(SessionConfig{Path: path})
	if err != nil { t.Fatal(err) }
	if info.BoundaryFound || info.ResumeOffset != 0 || info.ReplayedLines != 0 || !reflect.DeepEqual(session.Snapshot(), sessionZeroState()) {
		t.Fatalf("info = %#v, state = %#v", info, session.Snapshot())
	}
	appendTailerFile(t, path, "\n")
	session.tailer.pollOnce()
	if got := session.Snapshot().PlayerHandle; got != "PartialPilot" { t.Fatalf("PlayerHandle = %q", got) }
}

func TestSessionLivePlayerLoginResetsStateBeforeReducing(t *testing.T) {
	path := filepath.Join(t.TempDir(), "Game.log")
	writeTailerFile(t, path, joined(
		sessionLogin(0, "OldPilot"), sessionShard(1, "old_shard"), sessionSpawn(2),
		sessionLocation(3, "OLD"), sessionShip(4, "OldShip"), sessionPartyHeader(5), sessionPartyJoin(6, "Alpha"),
	))
	session, _, err := NewSession(SessionConfig{Path: path})
	if err != nil { t.Fatal(err) }
	originalOnLine := session.tailer.onLine
	callbackCount := 0
	session.tailer.onLine = func(line Line) {
		callbackCount++
		originalOnLine(line)
	}
	appendTailerFile(t, path, sessionLogin(7, "NewPilot")+"\n")
	session.tailer.pollOnce()
	state := session.Snapshot()
	if callbackCount != 1 { t.Fatalf("login callback count = %d, want 1", callbackCount) }
	if state.PlayerHandle != "NewPilot" || state.SessionActive || state.Shard != "" || state.Location != nil || state.Ship != nil || state.Quantum != nil || len(state.Party) != 0 || state.Jurisdiction != "" {
		t.Fatalf("old state retained after login: %#v", state)
	}
	if want := time.Date(2026, 9, 22, 10, 0, 7, 0, time.UTC); !state.LastEventAt.Equal(want) {
		t.Fatalf("LastEventAt = %s, want %s", state.LastEventAt, want)
	}
}

func TestSessionSourceResetsClearParserAndStateBeforeNewLines(t *testing.T) {
	t.Run("same-file truncation", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "Game.log")
		writeTailerFile(t, path, joined(sessionLogin(0, "OldPilot"), sessionSpawn(1), sessionPartyHeader(2)))
		session, _, err := NewSession(SessionConfig{Path: path})
		if err != nil { t.Fatal(err) }
		writeTailerFile(t, path, joined(sessionPartyJoin(3, "LeakedCrew")))
		session.tailer.pollOnce()
		state := session.Snapshot()
		if !reflect.DeepEqual(state, sessionZeroState()) { t.Fatalf("old Party pending state leaked after truncation: %#v", state) }
	})

	t.Run("replacement", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "Game.log")
		old := filepath.Join(dir, "old.log")
		writeTailerFile(t, path, joined(sessionLogin(0, "OldPilot"), sessionSpawn(1), sessionLocation(2, "OLD")))
		session, _, err := NewSession(SessionConfig{Path: path})
		if err != nil { t.Fatal(err) }
		if err := os.Rename(path, old); err != nil { t.Fatal(err) }
		writeTailerFile(t, path, joined(sessionShard(4, "new_shard")))
		session.tailer.pollOnce()
		state := session.Snapshot()
		if state.PlayerHandle != "" || state.Shard != "new_shard" || state.SessionActive || state.Location != nil { t.Fatalf("state = %#v", state) }
	})

	t.Run("replacement after temporary disappearance", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "Game.log")
		old := filepath.Join(dir, "old.log")
		writeTailerFile(t, path, joined(sessionLogin(0, "OldPilot"), sessionSpawn(1), sessionPartyHeader(2)))
		session, _, err := NewSession(SessionConfig{Path: path})
		if err != nil { t.Fatal(err) }
		if err := os.Rename(path, old); err != nil { t.Fatal(err) }
		session.tailer.pollOnce()
		writeTailerFile(t, path, joined(sessionShard(4, "replacement_shard")))
		session.tailer.pollOnce()
		state := session.Snapshot()
		if state.PlayerHandle != "" || state.Shard != "replacement_shard" || state.SessionActive || len(state.Party) != 0 {
			t.Fatalf("state = %#v", state)
		}
	})
}

func TestSessionRapidTruncateRegrowResetsState(t *testing.T) {
	path := filepath.Join(t.TempDir(), "Game.log")
	oldContent := joined(sessionLogin(0, "OldPilot"), sessionSpawn(1), sessionLocation(2, "OLD"), strings.Repeat("old", 3000))
	writeTailerFile(t, path, oldContent)
	session, _, err := NewSession(SessionConfig{Path: path})
	if err != nil { t.Fatal(err) }
	newPrefix := joined(sessionShard(4, "new_shard"))
	newContent := newPrefix + strings.Repeat("new", len(oldContent)/3+100) + "\n"
	if len(newContent) < len(oldContent) { t.Fatal("new content must regrow beyond old offset") }
	writeTailerFile(t, path, newContent)
	session.tailer.pollOnce()
	state := session.Snapshot()
	if state.PlayerHandle != "" || state.Shard != "new_shard" || state.SessionActive || state.Location != nil { t.Fatalf("state = %#v", state) }
}

func TestSessionTemporaryDisappearanceOfSameFileKeepsState(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "Game.log")
	parked := filepath.Join(dir, "parked.log")
	writeTailerFile(t, path, joined(sessionLogin(0, "Pilot"), sessionSpawn(1)))
	session, _, err := NewSession(SessionConfig{Path: path})
	if err != nil { t.Fatal(err) }
	if err := os.Rename(path, parked); err != nil { t.Fatal(err) }
	session.tailer.pollOnce()
	if err := os.Rename(parked, path); err != nil { t.Fatal(err) }
	appendTailerFile(t, path, sessionShard(2, "same_file_shard")+"\n")
	session.tailer.pollOnce()
	state := session.Snapshot()
	if state.PlayerHandle != "Pilot" || !state.SessionActive || state.Shard != "same_file_shard" { t.Fatalf("state = %#v", state) }
}

func TestSessionMissingEmptyAndInvalidTargets(t *testing.T) {
	t.Run("missing", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "Game.log")
		session, info, err := NewSession(SessionConfig{Path: path})
		if err != nil { t.Fatal(err) }
		if info.BoundaryFound || info.ResumeOffset != 0 || !reflect.DeepEqual(session.Snapshot(), sessionZeroState()) { t.Fatalf("info = %#v state = %#v", info, session.Snapshot()) }
		writeTailerFile(t, path, joined(sessionLogin(0, "LaterPilot"), sessionSpawn(1)))
		session.tailer.pollOnce()
		state := session.Snapshot()
		if state.PlayerHandle != "LaterPilot" || !state.SessionActive { t.Fatalf("state = %#v", state) }
	})

	t.Run("empty", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "Game.log")
		writeTailerFile(t, path, "")
		session, info, err := NewSession(SessionConfig{Path: path})
		if err != nil { t.Fatal(err) }
		if info.BoundaryFound || info.ResumeOffset != 0 || !reflect.DeepEqual(session.Snapshot(), sessionZeroState()) { t.Fatalf("info = %#v state = %#v", info, session.Snapshot()) }
	})

	t.Run("non-regular", func(t *testing.T) {
		_, _, err := NewSession(SessionConfig{Path: t.TempDir()})
		if err == nil || !strings.Contains(err.Error(), "not a regular file") { t.Fatalf("error = %v", err) }
	})
}

func TestSessionSnapshotIsDeepCopy(t *testing.T) {
	path := filepath.Join(t.TempDir(), "Game.log")
	writeTailerFile(t, path, joined(
		sessionLogin(0, "Pilot"), sessionLocation(1, "LOCATION"), sessionShip(2, "Ship"),
		`<2026-09-22T10:00:03Z> Player has selected point ARC-L1 as their destination`,
		sessionPartyHeader(4), sessionPartyJoin(5, "CrewMate"),
	))
	session, _, err := NewSession(SessionConfig{Path: path})
	if err != nil { t.Fatal(err) }
	snapshot := session.Snapshot()
	snapshot.Location.Raw = "changed"
	snapshot.Ship.Name = "changed"
	snapshot.Quantum.Destination = "changed"
	snapshot.Party[0] = "changed"
	actual := session.Snapshot()
	if actual.Location.Raw != "LOCATION" || actual.Ship.Name != "Ship" || actual.Quantum.Destination != "ARC-L1" || !reflect.DeepEqual(actual.Party, []string{"CrewMate"}) {
		t.Fatalf("snapshot aliases internal state: %#v", actual)
	}
}

func TestSessionDiagnosticsCountRestoreAndLiveProcessing(t *testing.T) {
	path := filepath.Join(t.TempDir(), "Game.log")
	writeTailerFile(t, path, joined(
		sessionLogin(0, "Pilot"),
		"restore noise",
		sessionPartyHeader(1),
		sessionPartyJoin(2, "RestoreCrew"),
	))
	session, info, err := NewSession(SessionConfig{Path: path})
	if err != nil { t.Fatal(err) }

	diagnostics := session.Diagnostics()
	if diagnostics.LogPath != path || diagnostics.LinesProcessed != uint64(info.ReplayedLines) || diagnostics.LinesProcessed != 4 || diagnostics.ParserEventCount != 2 || diagnostics.SourceResetCount != 0 {
		t.Fatalf("restore diagnostics = %#v", diagnostics)
	}

	appendTailerFile(t, path, "live noise\n")
	session.tailer.pollOnce()
	diagnostics = session.Diagnostics()
	if diagnostics.LinesProcessed != 5 || diagnostics.ParserEventCount != 2 {
		t.Fatalf("live noise diagnostics = %#v", diagnostics)
	}

	appendTailerFile(t, path, sessionSpawn(3)+"\n")
	session.tailer.pollOnce()
	diagnostics = session.Diagnostics()
	if diagnostics.LinesProcessed != 6 || diagnostics.ParserEventCount != 3 {
		t.Fatalf("live event diagnostics = %#v", diagnostics)
	}

	appendTailerFile(t, path, sessionPartyHeader(4)+"\n")
	session.tailer.pollOnce()
	diagnostics = session.Diagnostics()
	if diagnostics.LinesProcessed != 7 || diagnostics.ParserEventCount != 3 {
		t.Fatalf("Party header diagnostics = %#v", diagnostics)
	}

	appendTailerFile(t, path, sessionPartyJoin(5, "LiveCrew")+"\n")
	session.tailer.pollOnce()
	diagnostics = session.Diagnostics()
	if diagnostics.LinesProcessed != 8 || diagnostics.ParserEventCount != 4 {
		t.Fatalf("Party continuation diagnostics = %#v", diagnostics)
	}

	appendTailerFile(t, path, sessionLogin(6, "NewPilot")+"\n")
	session.tailer.pollOnce()
	diagnostics = session.Diagnostics()
	if diagnostics.LinesProcessed != 9 || diagnostics.ParserEventCount != 5 || diagnostics.SourceResetCount != 0 {
		t.Fatalf("live login diagnostics = %#v", diagnostics)
	}
	if diagnostics.State.PlayerHandle != "NewPilot" || len(diagnostics.State.Party) != 0 {
		t.Fatalf("live login state = %#v", diagnostics.State)
	}
}

func TestSessionDiagnosticsDoNotCountPartialBytes(t *testing.T) {
	path := filepath.Join(t.TempDir(), "Game.log")
	complete := joined(sessionLogin(0, "Pilot"))
	writeTailerFile(t, path, complete+"partial bytes")
	session, info, err := NewSession(SessionConfig{Path: path})
	if err != nil { t.Fatal(err) }
	if info.ReplayedLines != 1 || session.Diagnostics().LinesProcessed != 1 {
		t.Fatalf("initial info = %#v diagnostics = %#v", info, session.Diagnostics())
	}

	session.tailer.pollOnce()
	if diagnostics := session.Diagnostics(); diagnostics.LinesProcessed != 1 || diagnostics.ParserEventCount != 1 {
		t.Fatalf("partial bytes counted before newline: %#v", diagnostics)
	}
	appendTailerFile(t, path, "\n")
	session.tailer.pollOnce()
	if diagnostics := session.Diagnostics(); diagnostics.LinesProcessed != 2 || diagnostics.ParserEventCount != 1 {
		t.Fatalf("completed noise line diagnostics = %#v", diagnostics)
	}
}

func TestSessionDiagnosticsSourceResetIsMonotonic(t *testing.T) {
	path := filepath.Join(t.TempDir(), "Game.log")
	writeTailerFile(t, path, joined(sessionLogin(0, "OldPilot"), sessionSpawn(1)))
	session, _, err := NewSession(SessionConfig{Path: path})
	if err != nil { t.Fatal(err) }

	writeTailerFile(t, path, joined(sessionShard(2, "replacement_shard")))
	session.tailer.pollOnce()
	diagnostics := session.Diagnostics()
	if diagnostics.SourceResetCount != 1 || diagnostics.LinesProcessed != 3 || diagnostics.ParserEventCount != 3 {
		t.Fatalf("reset diagnostics = %#v", diagnostics)
	}
	if diagnostics.State.PlayerHandle != "" || diagnostics.State.Shard != "replacement_shard" {
		t.Fatalf("reset state = %#v", diagnostics.State)
	}

	appendTailerFile(t, path, "ordinary noise\n")
	session.tailer.pollOnce()
	diagnostics = session.Diagnostics()
	if diagnostics.SourceResetCount != 1 || diagnostics.LinesProcessed != 4 || diagnostics.ParserEventCount != 3 {
		t.Fatalf("post-reset diagnostics = %#v", diagnostics)
	}
}

func TestSessionDiagnosticsCountsReplacementAndContinuityResets(t *testing.T) {
	t.Run("replacement", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "Game.log")
		old := filepath.Join(dir, "old.log")
		writeTailerFile(t, path, joined(sessionLogin(0, "OldPilot")))
		session, _, err := NewSession(SessionConfig{Path: path})
		if err != nil { t.Fatal(err) }
		if err := os.Rename(path, old); err != nil { t.Fatal(err) }
		writeTailerFile(t, path, joined(sessionShard(1, "replacement_shard")))
		session.tailer.pollOnce()

		diagnostics := session.Diagnostics()
		if diagnostics.SourceResetCount != 1 || diagnostics.LinesProcessed != 2 || diagnostics.ParserEventCount != 2 || diagnostics.State.PlayerHandle != "" || diagnostics.State.Shard != "replacement_shard" {
			t.Fatalf("replacement diagnostics = %#v", diagnostics)
		}
	})

	t.Run("continuity mismatch", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "Game.log")
		oldContent := joined(sessionLogin(0, "OldPilot"), sessionSpawn(1), strings.Repeat("old", 3000))
		writeTailerFile(t, path, oldContent)
		session, _, err := NewSession(SessionConfig{Path: path})
		if err != nil { t.Fatal(err) }
		newPrefix := joined(sessionShard(2, "continuity_shard"))
		newContent := newPrefix + strings.Repeat("new", len(oldContent)/3+100) + "\n"
		if len(newContent) < len(oldContent) { t.Fatal("new content must regrow beyond old offset") }
		writeTailerFile(t, path, newContent)
		session.tailer.pollOnce()

		diagnostics := session.Diagnostics()
		if diagnostics.SourceResetCount != 1 || diagnostics.LinesProcessed != 5 || diagnostics.ParserEventCount != 3 || diagnostics.State.PlayerHandle != "" || diagnostics.State.Shard != "continuity_shard" {
			t.Fatalf("continuity diagnostics = %#v", diagnostics)
		}
	})
}

func TestSessionDiagnosticsTemporaryDisappearanceDoesNotReset(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "Game.log")
	parked := filepath.Join(dir, "parked.log")
	writeTailerFile(t, path, joined(sessionLogin(0, "Pilot")))
	session, _, err := NewSession(SessionConfig{Path: path})
	if err != nil { t.Fatal(err) }
	if err := os.Rename(path, parked); err != nil { t.Fatal(err) }
	session.tailer.pollOnce()
	if err := os.Rename(parked, path); err != nil { t.Fatal(err) }
	appendTailerFile(t, path, sessionSpawn(1)+"\n")
	session.tailer.pollOnce()

	diagnostics := session.Diagnostics()
	if diagnostics.SourceResetCount != 0 || diagnostics.LinesProcessed != 2 || diagnostics.ParserEventCount != 2 {
		t.Fatalf("diagnostics = %#v", diagnostics)
	}
}

func TestSessionDiagnosticsStateIsDeepCopy(t *testing.T) {
	path := filepath.Join(t.TempDir(), "Game.log")
	writeTailerFile(t, path, joined(
		sessionLogin(0, "Pilot"), sessionLocation(1, "LOCATION"), sessionShip(2, "Ship"),
		`<2026-09-22T10:00:03Z> Player has selected point ARC-L1 as their destination`,
		sessionPartyHeader(4), sessionPartyJoin(5, "CrewMate"),
	))
	session, _, err := NewSession(SessionConfig{Path: path})
	if err != nil { t.Fatal(err) }
	diagnostics := session.Diagnostics()
	diagnostics.State.Location.Raw = "changed"
	diagnostics.State.Ship.Name = "changed"
	diagnostics.State.Quantum.Destination = "changed"
	diagnostics.State.Party[0] = "changed"

	actual := session.Diagnostics()
	if actual.State.Location.Raw != "LOCATION" || actual.State.Ship.Name != "Ship" || actual.State.Quantum.Destination != "ARC-L1" || !reflect.DeepEqual(actual.State.Party, []string{"CrewMate"}) {
		t.Fatalf("diagnostics state aliases internal state: %#v", actual.State)
	}
}

func TestSessionRunStopsOnCancellation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "Game.log")
	session, _, err := NewSession(SessionConfig{Path: path, PollInterval: time.Millisecond})
	if err != nil { t.Fatal(err) }
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- session.Run(ctx) }()
	cancel()
	select {
	case err := <-done:
		if err != nil { t.Fatal(err) }
	case <-time.After(time.Second):
		t.Fatal("Session.Run did not stop after cancellation")
	}
}

func sessionZeroState() telemetry.TelemetryState {
	return telemetry.TelemetryState{}
}
