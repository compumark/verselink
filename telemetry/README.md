# VerseLink Telemetry

VerseLink Telemetry is the planned read-only telemetry companion for
VerseLink. This repository currently contains the early Milestone A scaffold,
event-contract fixtures, and an internal Windows `Game.log` locator. These
prove that the future telemetry component can build and run as an independent
Go module.

The initial implementation lives in `telemetry/` inside the VerseLink
repository. It is technically independent from the Node.js application and
from `companion/`, which remains a separate OCR project. The module path is
already suitable for a future move to `compumark/verselink-telemetry`; that
move should mainly require repository and CI relocation, not code redesign.

## Requirements

- Go 1.27 or newer
- No third-party dependencies

From the repository root:

```bash
cd telemetry
gofmt -w .
go build ./...
go test ./...
go vet ./...
go run ./cmd/verselink-telemetry
```

The B1 executable now performs the first local Windows runtime integration.
After printing its identity and build information it locates `Game.log`,
restores the latest current login session, starts the existing live tailer, and
prints privacy-safe diagnostics when meaningful state changes. A3 adds an
internal, read-only Windows `Game.log` locator for later callers. A4 adds an
internal, read-only live line tailer: it emits only newly appended complete raw
lines, buffers partial writes, and accepts an explicit path-change hook. A5
parses the three session events `player_login`, `server_joined`, and
`player_spawned` into local structured events. A6 adds internal parsing for
the `location_change` observation and `jurisdiction_entered` events. A7 adds
internal parsing for ship boarding and exiting channel notifications. A8 adds
internal Quantum Travel event parsing. A9 adds internal Party join, leave, and
disbanded-event parsing with only the minimal pending operation needed for
multi-line observations. A10 adds local, platform-neutral reduction of the 13
P0 events into current session, location, ship, Quantum, Party, and timing
state. A11 adds local current-session restoration and restart handling: it
replays only the latest `player_login` session and continues from an exact
live-tail byte offset while resetting local state on log restarts. A12 adds a
small manifest-driven regression corpus covering all 13 P0 events, an
end-to-end restore regression, monotonic Session diagnostics counters, and a
deterministic local current-state formatter. There is still no backend or API
integration. B1 provides the foreground Windows console runtime, and B2 adds
a minimal Windows tray entry point over the same local runtime pipeline.

## Regression corpus

The A12 corpus under `testdata/regression/` contains only synthetic, sanitized,
purpose-built sequences. It complements the minimal per-event A2 fixtures
under `testdata/events/`; it is not a location for personal or complete
`Game.log` files. The manifest explicitly controls which fixtures are read and
their expected event counts.

Run the complete suite with verbose corpus output:

```bash
cd telemetry
go test -v ./...
```

The reusable local diagnostics core summarizes Session counters and structured
current state without retaining raw Game.log lines or GEIDs. It is not yet
wired to the command executable or an end-user diagnostics UI. Backend/API and
runtime UI work remain outside Milestone A.

## Planned direction

Later milestones may add further parsing, platform adapters, an end-user
diagnostics experience, and a future VerseLink API client. A12 remains local
core and test behavior only: there is no backend, API integration, or
persistent state.

## First Windows runtime test

Build and run from a Windows terminal:

```powershell
cd telemetry
go build -o verselink-telemetry.exe ./cmd/verselink-telemetry
.\verselink-telemetry.exe
```

The executable remains a foreground console application in B1. It performs
one bounded, read-only `Game.log` discovery pass, restores the most recent
current login session, then continues live monitoring. Successful startup
prints the selected path, discovery strategy, restore metadata, and a local
diagnostics summary. Further diagnostics appear only when meaningful structured
state changes, such as ship, Quantum Travel, Party count, location, or a source
reset. It never prints raw `Game.log` lines, GEIDs, or Party member names.

If automatic discovery cannot find Star Citizen, set an optional one-process
manual path before launching:

```powershell
$env:VERSELINK_GAME_LOG_PATH = 'C:\Program Files\Roberts Space Industries\StarCitizen\LIVE\Game.log'
.\verselink-telemetry.exe
```

Stop the program with `Ctrl+C`. This cancels the local Session cleanly; it does
not create a service, a child process, a persistent lock, or telemetry state
files.

B1 does not include settings UI, autostart, installer, updater, VerseLink
account pairing, API upload, or MobiGlass integration.

## Windows tray application

B2 keeps the B1 console executable as a diagnostics and development entry
point and adds a separate Windows tray executable. Both commands share the
same locator, Session, parser, reducer, and structured runtime-status host;
the tray never parses console output or raw `Game.log` lines.

Build and run the tray application during development:

```powershell
cd telemetry
go build -o verselink-telemetry-tray.exe ./cmd/verselink-telemetry-tray
.\verselink-telemetry-tray.exe
```

To build it as a Windows GUI-subsystem executable without a visible console:

```powershell
go build -ldflags="-H windowsgui" -o verselink-telemetry-tray.exe ./cmd/verselink-telemetry-tray
```

The tray menu shows the current status, opens a small local diagnostics
dialog, and exits cleanly. Runtime statuses include Starting, Searching for
Game.log, Monitoring, Session active, Game.log unavailable, Warning, and
Fatal error. If `Game.log` is not available, the tray remains running and
retries the existing bounded locator every 15 seconds. It starts the existing
Session when discovery later succeeds; it does not add another file watcher.

The diagnostics dialog shows the selected path, source-reset count, session
state, player handle, shard, location, jurisdiction, current ship, Quantum
Travel state, Party count, and last event. Structured status snapshots remove
Party member names and never contain raw `Game.log` lines, GEIDs, or raw event
data maps. No diagnostics are uploaded or persisted.

B2 does not provide persistent settings, a settings UI, a stored manual path,
Windows autostart, a service, an installer/updater, account pairing, or network
telemetry. Known live compatibility investigations for shard detection (#48)
and ship-exit confirmation (#49) remain separate work.

The security boundary is explicit. VerseLink Telemetry will not use process
memory reading, DLL injection, kernel drivers, packet sniffing, keyboard hooks,
automated chat input, or modification of Star Citizen files. Its initial future
data source is `Game.log`, read-only.
