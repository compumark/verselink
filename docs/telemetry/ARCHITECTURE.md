# VerseLink Telemetry — Architecture

Status: Proposed  
Created: 2026-09-21

## System boundary

VerseLink Telemetry is a standalone local client. It is separate from the existing `companion/` OCR prototype.

```text
Star Citizen
    |
    | Game.log
    v
VerseLink Telemetry
    |
    +-- GameLogLocator
    +-- GameLogTailer
    +-- GameLogParser
    +-- TelemetryEvent
    +-- TelemetryReducer
    +-- TelemetryState
    +-- Diagnostics
    +-- later: VerseLinkApiClient
                    |
                    | HTTPS
                    v
              VerseLink Server
                    |
                    +-- Device Auth
                    +-- Event Ingest
                    +-- Presence
                    +-- Privacy
                    +-- Location Resolver
                    |
                    v
                PostgreSQL
                    |
                    v
            MobiGlass Crew UI
```

## Client language

Current recommendation: Go.

Reasons:

- single self-contained binaries,
- low runtime overhead,
- simple file tailing and HTTP,
- straightforward Windows/Linux builds,
- no dependency on the existing Windows-only OCR stack.

This decision can be revisited only through an explicit architecture decision.

## Core pipeline

```text
Game.log
  -> locator
  -> tailer
  -> GameLogParser
  -> TelemetryEvent
  -> reducer
  -> TelemetryState
  -> diagnostics / later API
```

The UI and server must not parse raw Star Citizen log lines.

The parser receives one raw complete line from the tailer and returns at most
one allowlisted `TelemetryEvent`. A timestamp is parsed only from a valid
RFC3339/RFC3339Nano value at the start of the line; missing or malformed
timestamps remain zero and are never replaced with system time.

A6 treats `location_change` as a last-observed location signal, not continuous
GPS/XYZ positioning. The A10 reducer preserves the raw location identifier,
the source, and the event timestamp as the observation time. Only a new
`location_change` may update that observation time; ordinary events and any
future heartbeat must not refresh it.

A7 parses `ship_boarded` and `ship_exited` from their channel notifications.
Their `raw` field is only the captured channel value, never the full Game.log
line. `ship` removes only a leading `@vehicle_Name` prefix and `owner` is the
channel value after the first ` : ` separator (or empty when no separator is
present). These events are observations, not fleet or inventory
synchronization. A10 records the current ship on boarding and clears it only
when an exit matches that current ship, so a stale exit cannot clear a newer
ship observation.

A8 parses Quantum Travel observations independently. `qt_target_selected` and
`qt_fuel_requested` carry an observed destination token exactly as captured;
they do not resolve it. `qt_arrived` has an empty data map and never infers a
destination. The parser retains no Quantum state. A10 reduces target selection
and fuel request to their observed destination, and marks arrival while
retaining a known destination; an arrival without prior QT state is represented
with an empty destination rather than fabricating one.

A9 treats Party join and leave notifications as two-line observations. A Party
header only arms one pending join or leave operation and emits nothing; a
matching continuation emits an event using the continuation timestamp and then
clears that pending operation. Recognized unrelated events and wrong opposing
continuations clear it, while unmatched lines leave it unchanged; a newer Party
header replaces the prior operation. `party_disbanded` is a single-line event
with an empty data map that also clears pending state. This is minimal parser
correlation, not Party membership state. A10 reduces those events into a
lexicographically sorted Party member set: joins are idempotent, unknown leaves
are no-ops, and disband clears the set.

## Suggested standalone repository layout

```text
verselink-telemetry/
  cmd/
    verselink-telemetry/
      main.go
  internal/
    gamelog/
      locator.go
      locator_windows.go
      locator_linux.go
      tailer.go
      parser.go
    telemetry/
      event.go
      state.go
      reducer.go
    location/
      resolver.go
    api/
      client.go
      pairing.go
      heartbeat.go
    config/
      config.go
    diagnostics/
      logger.go
  testdata/
    game-logs/
  docs/
  THIRD_PARTY_NOTICES.md
  README.md
```

## Game.log discovery

### Windows

Preferred strategy order:

1. RSI Launcher log discovery
2. running `StarCitizen.exe`
3. known installation locations
4. registry-based hints when useful
5. manual path override

The active channel may be LIVE, PTU, EPTU, or another future channel. The locator must not assume LIVE only.

The A3 locator performs one bounded, read-only discovery pass. It selects only a
regular `Game.log` that can be opened read-only, and returns the selected path,
the winning strategy, and local attempts for diagnostics. It first reads RSI
Launcher logs (including a rotated fallback), then uses a non-interactive
PowerShell CIM process query, bounded known installation roots, narrow registry
install hints, and finally a caller-supplied manual path. It does not use WMIC,
poll, tail, wait for the game, or scan disks recursively.

On non-Windows platforms the default locator returns an explicit unsupported
platform result and does not invoke Windows commands or perform discovery.
Linux discovery remains a Milestone G concern.

### Linux

The core parser and tailer remain platform-neutral. Only path discovery is platform-specific.

Potential discovery targets include:

- Wine prefixes,
- Lutris-managed prefixes,
- Proton-like prefix layouts,
- manual path override.

## Tailer requirements

The tailer opens `Game.log` read-only and must tolerate:

- game start after telemetry start,
- telemetry start while the game is already running,
- log truncation,
- log recreation,
- game restart,
- channel/path change,
- temporary file disappearance,
- partial line writes.

A polling model around 100–250 ms is acceptable for the first implementation.

The A4 tailer is live-only: when its initial `Game.log` already exists, it
attaches at EOF and does not replay history. If the initial file appears later,
or a caller explicitly switches to a new path/channel, it reads that new file
from byte zero. It buffers partial writes until `\n`, removes only a preceding
`\r` from CRLF, and preserves all other raw text. Truncation and replacement
clear the pending partial buffer and restart at byte zero. Temporary file
disappearance is recoverable; when the same identity returns it resumes at its
previous offset, otherwise it treats it as replacement. A4 has an explicit
path-change hook but does not poll the A3 locator and does not restore sessions.
Ordinary same-identity truncation is detected when the new size is below the
stored offset. A11 also keeps a bounded in-memory byte anchor immediately
before the current offset. If the same file truncates and regrows past the old
offset between polls, an anchor mismatch detects the lost continuity without
using modification time or retaining historic log content.

## Session restoration

On telemetry startup, A11 scans backwards in bounded blocks for the latest
complete `player_login` line and replays only complete lines from that boundary
through the restore snapshot. If no valid boundary exists, it replays no
history and starts with zero state. The restore uses the existing parser and
reducer; timestamps remain source timestamps with no system-time inference.

Restore and live tailing share one parser instance so pending Party correlation
can cross the handoff. The handoff offset is the byte immediately after the
last complete `\n`, not necessarily physical EOF. A trailing partial line is
therefore read from its beginning by the live tailer when completed. The tailer
is bound to the restore-time file identity and continuity anchor and begins at
that exact offset, preserving bytes appended before its first poll without
reprocessing restored complete lines.

A live `player_login` starts a fresh `TelemetryState` before that login is
reduced. Truncation, replacement, or continuity-anchor mismatch synchronously
resets both parser and state before any line from the new source is processed.
A temporary disappearance of the same unchanged file keeps state and resumes
at the prior offset. This remains local in-memory behavior: A11 adds no backend,
API integration, heartbeat, persistence, or end-user runtime wiring.

## Event model

Example:

```json
{
  "type": "location_change",
  "source": "game_log",
  "timestamp": "2026-09-21T10:00:00Z",
  "data": {
    "player": "ExampleHandle",
    "location": "RR_CRU_L1"
  }
}
```

Only allowlisted structured fields should later be synced to VerseLink.

## Telemetry state

Example:

```json
{
  "sessionActive": true,
  "playerHandle": "ExampleHandle",
  "shard": "pub_example",
  "location": {
    "raw": "RR_CRU_L1",
    "observedAt": "2026-09-21T10:00:00Z",
    "source": "game_log"
  },
  "ship": {
    "name": "RSI_Hermes",
    "owner": "ExampleHandle"
  },
  "quantum": {
    "destination": "LOC_HURSTON",
    "state": "target_selected"
  },
  "party": ["CrewMate"],
  "lastEventAt": "2026-09-21T10:00:02Z"
}
```

A location observed timestamp and the client's heartbeat timestamp are separate concepts.

## A10 reducer semantics

`Reduce(state, event)` is platform-neutral and stateless; all retained data is
part of `TelemetryState`. `player_spawned` activates the session, while no A10
event ends it. Supported events with valid source timestamps update
`lastEventAt` in processing order; zero timestamps never use system time or
replace a known valid value. A ship exit clears the current ship only when its
name matches and, when both are present, its owner also matches. Quantum state
uses only `target_selected`, `fuel_requested`, and `arrived`; arrival preserves
a known destination or records an empty one without inference. Party members
are a sorted set with idempotent joins, exact leaves, and full disband clearing.
A10 does not restore sessions, detect restarts, or rebuild historic state;
those boundaries remain A11.

## Server integration — later phase

Planned endpoints:

```text
POST   /api/telemetry/pair
POST   /api/telemetry/events
POST   /api/telemetry/heartbeat
GET    /api/telemetry/status
DELETE /api/telemetry/devices/:id
```

Planned persistence:

- `telemetry_devices`
- `telemetry_presence`
- `telemetry_events`
- location mapping table

## Privacy boundary

The client may parse more locally than is uploaded.

Server-side sharing controls must govern at least:

- online status,
- shard,
- location,
- current ship,
- QT destination,
- party information.

Future categories such as missions, medical state, crime, and economy require separate opt-in decisions.

## Security boundary

Explicitly out of scope:

- game process-memory reads,
- DLL injection,
- kernel drivers,
- network packet sniffing,
- keyboard hooks,
- automatic chat input,
- modification of Star Citizen files.

The initial telemetry source is read-only `Game.log`.
