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
           |                 +-- Diagnostics (local)
           v
    Explicit schema-1 presence DTO
           |
         HTTPS
           v
    VerseLink Server
      +-- Browser-authenticated pairing
      +-- Per-device authentication/revocation
      +-- Heartbeat (connection health)
      +-- Presence snapshot (gameplay state)
           |
           v
    telemetry_presence (latest snapshot per device)
           |
      later Phase D: privacy / sharing API
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

## A12 regression corpus and local diagnostics

A2 and A12 serve different test layers. The A2 `testdata/events/` fixtures are
minimal per-event contracts, while the A12 `testdata/regression/` corpus holds
small, realistic multi-line sequences. Every A12 sequence is synthetic and
sanitized; personal or complete `Game.log` files must never be committed.

The versioned corpus manifest explicitly lists the only files the runner may
read and defines expected event counts for each case. Collectively, those
expectations cover all 13 current P0 parser contracts derived from
`ApprovedEventContracts`. Unknown lines, Party headers, and other no-event
lines are normal parser input, not parse failures. A regression failure is a
manifest expectation mismatch such as a missing, unexpected, or incorrectly
counted event. Reports retain only case metadata and aggregate counts, never
raw Game.log content.

Each Session also exposes local lifetime counters for complete lines presented
to the parser, emitted parser events, and source resets. These counters include
startup replay and live processing and remain monotonic across truncation,
replacement, and continuity-loss resets even though parser and telemetry state
are cleared. A thread-safe diagnostics snapshot includes a deep copy of current
state and can be formatted as a concise deterministic local summary. It does
not include GEIDs, raw lines, event data maps, network delivery, backend/API
integration, persistence, or an end-user diagnostics UI.

## VerseLink connection — Milestone C contract

Milestone C is planned as a one-time pairing flow, dedicated revocable
per-device Bearer credentials, a connection-health heartbeat, and an explicit
versioned current-presence DTO. The local Go reducer remains authoritative for
Game.log interpretation; the server receives neither raw logs nor an event
stream. `telemetry_presence` stores only the latest accepted schema-1 snapshot
per device. `telemetry_devices` and short-lived pairing records own device and
pairing lifecycle. Phase C does not require `telemetry_events` or a telemetry
status GET endpoint.

The normative endpoint, request/response, error, rate-limit, lifecycle,
ordering/idempotency, and privacy contract is in
[`CONNECTION_CONTRACT.md`](CONNECTION_CONTRACT.md). This architecture document
summarizes that contract; it does not define a second copy of its field-level
details. C3 implements only the pairing-creation and pairing-claim routes;
C4 adds the reusable device-authentication layer described below. Heartbeat,
presence, and device-management routes remain future work.

### C2 persistence foundation (implemented)

The repeat-safe startup schema in `src/server.js` creates `telemetry_devices`
and `telemetry_pairing_codes`. Both are owned through `app_users` foreign keys
with `ON DELETE CASCADE`. Device and pairing secrets are represented only by
unique lowercase HMAC-SHA256 hashes; plaintext credentials and pairing codes
are not persisted. `telemetry_devices.last_presence_revision` stores the
per-device revision high-water mark independently of current presence rows.
The `telemetry_presence` table and snapshot upsert remain C7 scope. C2 adds
schema only—no pairing or telemetry HTTP endpoints, auth middleware, or secret
generation logic.

### C3 pairing API (implemented)

The authenticated VerseLink profile can request a one-time, ten-minute pairing
code. The server returns its grouped Crockford representation once and stores
only a domain-separated HMAC lookup value. Issuing a replacement invalidates
the previous open code transactionally. The unauthenticated claim route
normalizes the submitted code, applies bounded request-count rate limits, and
atomically consumes the live code while creating its device and returning the
new device credential once; only that credential's HMAC is stored. Account
deactivation invalidates open pairing codes in the same transaction, and a
bounded daily cleanup removes aged lifecycle records. The existing MobiGlass
profile provides the pairing-code utility. C5 still owns the Windows code-entry
UI and secure credential storage; C4 owns device Bearer authentication; C7
owns `telemetry_presence` and snapshot ingestion.

### C4 device authentication (implemented)

`src/telemetry-device-auth.js` accepts exactly one case-sensitive
`Authorization: Bearer vlt_…` value in the approved credential shape. It
reuses C3's domain-separated HMAC-SHA256 function and performs an indexed
credential-hash lookup joined to the current owning account on every call.
There is no authentication cache or application-side secret comparison. On
success, callers receive only the device ID and owning app-user ID. Unknown
credentials return `invalid_device_credential`; a committed device revocation
returns `device_revoked` before account-status evaluation; any non-active
account returns `account_inactive`. Database/dependency errors remain distinct
from authentication failures.

Device Bearer auth is separate from browser `bp_session` auth in both
directions. C4 adds no protected HTTP route, heartbeat, presence behavior, or
device-management/revocation API. Future C6/C7 handlers consume this helper;
C8 / Issue #94 owns the user-facing device management and remote-revocation
API/UI.

### C5 Windows pairing client (implemented locally; review pending)

The native tray Settings window accepts an explicit VerseLink instance URL,
optional device name, and one-time C3 pairing code. A client-side
`VERSELINK_APP_URL` environment value takes precedence; otherwise the saved,
validated instance URL is used. The server's deployment variable is not
automatically available to a standalone Windows process, and no production
hostname is embedded in the client. Missing configuration disables pairing.
Production targets require HTTPS, normal system certificate/hostname
validation, and no URL credentials, query, or fragment. HTTP is permitted only
with the explicit `VERSELINK_TELEMETRY_ALLOW_HTTP=1` development override and
a loopback host. Pairing is a single bounded request to C3's
`POST /api/telemetry/pair`; redirects and cookie jars are disabled, the total
timeout is 10 seconds, and response reads are capped. A timeout is ambiguous:
the client never retries a claim automatically.

The one-time `vlt_` value is held in a wipeable byte buffer and written only to
a per-user Windows Credential Manager Generic Credential target derived from
the normalized server URL and server-issued device ID. The target contains no
secret and isolates devices as well as server instances. Settings version 2
retains backward compatibility with version-1 Game.log settings and stores
only instance URL, device UUID/name, and other non-secret local configuration.
Credential-store failures never fall back to settings, files, registry, or
DPAPI. Pairing confirmation says the credential is stored locally; it does not
claim C4 authentication/revocation status, which requires C6's first heartbeat.

Local Disconnect deletes the Windows Credential Manager entry and local
device metadata only. It does not call the server and explicitly does not
revoke the remote device; remote device management belongs to C8. The existing
local Game.log runtime remains independent of network availability.

C5 creates a durable per-device revision-state file and holds an exclusive OS
lock associated with the paired device for the process lifetime. A stable
sibling lock file is used because the JSON state file is atomically replaced;
this keeps the OS lock identity stable across replacement. All processes use
the same lock path derived from the device ID. Neither lock nor state files
contain credentials or other secrets. The state file is written via synced
temporary file and write-through atomic replacement on Windows. The revision
allocator is present for future snapshot creation but is not called by C5: no
revision is incremented until C7 has an actual presence snapshot to send. C5
adds no heartbeat, presence upload, authentication probe, management route, or
server-side code.

## Privacy boundary

The client may parse more locally than is uploaded.

Server-side sharing controls must govern at least:

- online status,
- shard,
- location,
- current ship,
- QT destination,
- party information.

Server ingestion is not user-to-user sharing. Presence remains private to the
owning account until Phase D defines explicit opt-in, field-level visibility,
and server-side viewer authorization. The C1 schema initially excludes the
player handle, ship owner, and Party identities; it permits Party count only.

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
