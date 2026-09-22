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

The current executable prints its identity and build defaults. A3 adds an
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
state. There is still no session restore, backend, API, or end-user runtime
integration.

## Planned direction

Later milestones may add further parsing, platform adapters, diagnostics, and a
future VerseLink API client. None of those features are part of A10. Session
restore and restart reconstruction remain separate A11 work.

The security boundary is explicit. VerseLink Telemetry will not use process
memory reading, DLL injection, kernel drivers, packet sniffing, keyboard hooks,
automated chat input, or modification of Star Citizen files. Its initial future
data source is `Game.log`, read-only.
