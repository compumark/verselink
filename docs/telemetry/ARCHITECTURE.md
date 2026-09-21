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
  -> parser
  -> TelemetryEvent
  -> reducer
  -> TelemetryState
  -> diagnostics / later API
```

The UI and server must not parse raw Star Citizen log lines.

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

## Session restoration

On telemetry startup, state should be rebuilt from the current Star Citizen session instead of replaying an entire historic log.

Preferred model:

1. scan backwards for the latest reliable session/login marker,
2. replay from that point,
3. reduce events into current state,
4. continue live tailing.

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
