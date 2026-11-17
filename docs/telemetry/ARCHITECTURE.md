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

## B4 Windows application lifecycle

The Windows tray entry point acquires a named mutex in the `Local` namespace,
including the current user's SID, before it loads settings or starts the tray,
Credential Manager access, telemetry Runtime, Heartbeat, or Presence workers.
This limits the client to one process per interactive user session. The
per-device revision file lock remains independent and continues to protect
revision updates for one paired device.

Windows autostart is opt-in and stored only as the VerseLink-owned
`VerseLinkTelemetry` value in the current user's `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run`
key. It points at the absolute executable path and passes only the fixed
`--autostart` switch. Registry state is authoritative. A value that no longer
matches the running executable requires an explicit Repair or Disable action;
startup does not silently replace it. No service, scheduled task, elevation,
shell invocation, or settings-file mirror is used.

Application shutdown is coordinated on the tray's UI thread without blocking
its message loop. The same controller handles user Exit, message-loop failure,
confirmed `WM_ENDSESSION`, and partial startup cleanup. `WM_QUERYENDSESSION`
is answered promptly and has no shutdown side effect; an aborted session end
therefore leaves the client active. On a confirmed end, new UI/pairing actions
are disabled, pairing is canceled, then Runtime/Heartbeat/Presence are
canceled through their shared context. The app waits for all four worker
classes under one 8-second deadline. It drains a completed pairing result,
destroys UI/tray resources, releases the per-device revision lock, and then
releases the application mutex only after workers have ended.

If the deadline expires, the client records a bounded in-memory event, emits
`OutputDebugString`, and exits with code 2 immediately. The event is not
persisted and cannot be reopened from the next process. It does not flush
network requests or release locks while workers may still be active. Process
termination lets Windows reclaim the mutex and file handles. Lifecycle events
contain fixed event names only; the recent in-memory list is bounded. No
credentials, pairing codes, request data, GEIDs, raw Game.log lines, or
presence payloads enter lifecycle diagnostics.

The existing 15-second locator retry, session restore, live tailer, and source
reset behavior are reused unchanged. A Game.log path setting still takes
effect after an application restart. B4 does not create a second runtime,
queue stale presence data, or change Heartbeat/Presence protocol behavior.

## B5 local diagnostics export

The tray offers an explicit, user-confirmed local troubleshooting export. It
serializes a dedicated schema-1 allowlist from detached runtime/connection
snapshots rather than reusing the richer on-screen diagnostics text. The JSON
has a fixed field order, is capped at 16 KiB, and is saved only to the path
chosen in the native Save dialog. No network or backend path is involved.

The schema contains application/build/Go/platform metadata; coarse runtime
phase, discovery strategy, Game.log availability and channel category; boolean
session/location/jurisdiction/ship indicators; a Quantum Travel state
category; Party count; aggregate line/event/reset counters; a connection-state
category; at most 12 recent lifecycle codes; and a separate bounded excerpt of
structured local application-log records. The in-memory logger is a
thread-safe 64-entry ring. It accepts only fixed severity and event-code enums;
there is no message, path, map, or raw-data field. The export includes at most
24 recent app-log entries, capped at 4 KiB total, with only UTC timestamp,
severity, and an allowlisted event code. The complete JSON export is capped at
16 KiB. It excludes absolute paths, Game.log content, handles,
shard/location/destination names, ship owner, Party names, identifiers,
credentials, tokens, pairing codes, HTTP data, and free-form warning/error
text. Unknown enum and lifecycle/log values are replaced or omitted. Export
cancellation writes nothing; save errors are reported locally.

Schema-1 has these fixed top-level fields: `schema_version`, `application`,
`runtime`, `counters`, `connection`, `recent_lifecycle_events`, and
`application_logs`.
`application` contains `name`, `version`, `commit`, `go_version`, `os`, and
`architecture`. `runtime` contains `phase`, `discovery_strategy`,
`game_log_available`, `channel`, `session_active`, `location_known`,
`jurisdiction_known`, `ship_known`, `quantum_state`, and `party_count`.
`counters` contains `lines_processed`, `parser_event_count`, and
`source_reset_count`; `connection` contains only `state`. Each
`application_logs` element has exactly `timestamp`, `severity`, and
`event_code`. The enum fields use fixed values, with unknown inputs normalized
to `unknown` or `other_or_unknown`. The lifecycle and application-log arrays
contain only known event codes.

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
integration, or persistence. B5 adds a separate local, bounded export from an
explicit user action; it does not change the underlying diagnostics snapshot.

## VerseLink connection — Milestone C contract

Milestone C implements one-time pairing, dedicated revocable per-device Bearer
credentials, a connection-health heartbeat, an explicit versioned
current-presence DTO, and private device/history management. The local Go
reducer remains authoritative for Game.log interpretation; the server receives
neither raw logs nor an event stream. `telemetry_presence` stores only the
latest accepted schema-1 snapshot per device. `telemetry_devices` and
short-lived pairing records own device and pairing lifecycle. Phase C does not
require `telemetry_events` or a telemetry status GET endpoint.

The normative endpoint, request/response, error, rate-limit, lifecycle,
ordering/idempotency, and privacy contract is in
[`CONNECTION_CONTRACT.md`](CONNECTION_CONTRACT.md). This architecture document
summarizes that contract; it does not define a second copy of its field-level
details. C3 implements the pairing-creation and pairing-claim routes; C4 adds
the reusable device-authentication layer described below. C6 implements the
connection-health heartbeat. C7 validates an explicit schema-1 snapshot,
transactionally advances the per-device revision high-water mark and upserts
one private current-presence row. It validates but discards `shard` and
`party_count`; those fields are neither stored nor used for duplicate
comparison. The Windows client maps reducer state through a DTO allowlist and
uses C5's durable per-device revision lock. C8 adds a private, allowlisted
`telemetry_presence_history` projection only after a C7 snapshot is accepted;
this is not a raw parser-event stream.

### C2 persistence foundation (implemented)

The repeat-safe startup schema in `src/server.js` creates `telemetry_devices`
and `telemetry_pairing_codes`. Both are owned through `app_users` foreign keys
with `ON DELETE CASCADE`. Device and pairing secrets are represented only by
unique lowercase HMAC-SHA256 hashes; plaintext credentials and pairing codes
are not persisted. `telemetry_devices.last_presence_revision` stores the
per-device revision high-water mark independently of current presence rows.
The `telemetry_presence` table and snapshot upsert were added by C7. C2 added
the device/pairing schema only—no pairing or telemetry HTTP endpoints, auth
middleware, or secret generation logic.

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
directions. C4 provides the shared authentication layer used by the C6
heartbeat, C7 presence, and C8 revocation flows. Owner-scoped device management
and private-history routes use browser-session authentication instead.

### C5 Windows pairing client (implemented)

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
revoke the remote device; remote device revocation is available through the
C8 VerseLink device-management UI. The local Game.log runtime remains
independent of network availability.

C5 creates a durable per-device revision-state file and holds an exclusive OS
lock associated with the paired device for the process lifetime. A stable
sibling lock file is used because the JSON state file is atomically replaced;
this keeps the OS lock identity stable across replacement. All processes use
the same lock path derived from the device ID. Neither lock nor state files
contain credentials or other secrets. The state file is written via synced
temporary file and write-through atomic replacement on Windows. C7 uses the
revision allocator when a changed snapshot is ready to send; retries preserve
the same durable revision and request body. C5 itself adds no heartbeat or
server-side route.

### C6 heartbeat and connection health (implemented)

`POST /api/telemetry/heartbeat` reuses C4 device authentication for each
request and refreshes only that device's `telemetry_devices.last_seen_at` from
the database server clock. Requests are limited to 120 per device per minute
with the bounded request-count limiter. Before C4 authentication, a syntactically
valid credential is mapped to an ephemeral bucket using the existing
domain-separated credential HMAC; malformed or missing Bearer credentials use
the direct socket peer. This value is only a limiter key: every admitted request
still performs fresh C4 database authentication. A separate in-flight guard
admits at most four auth lookups per direct socket peer and eight globally,
without a waiting queue. Each request consumes its one request-count unit before
the guard; saturation returns the existing `429 rate_limited` response with
`Retry-After: 1` and does not start an auth lookup. This reuses the documented 429
contract rather than adding an endpoint or response shape. The response
timestamp is server receipt metadata; heartbeat never changes gameplay
timestamps, reducer state, or presence data.

The paired Windows tray client reads the credential for its validated server
and device target from Windows Credential Manager for each attempt. It sends
an immediate heartbeat and then schedules 30-second intervals. Transient
transport/timeout and server failures use capped full-jitter exponential
backoff; `Retry-After` controls 429 retries. Authentication failures and
revocation stop authenticated retries until pairing configuration changes.
Shutdown cancels pending waits and in-flight HTTP requests. Connection state
and the last successful server receipt are shown in Settings, the tray status,
and the existing local live monitor. Local Game.log tracking remains
independent of network health.

The server's online TTL is 90 seconds and means connection health only. It does
not imply an active gameplay session or shared presence; C7 owns snapshot
ingestion and `telemetry_presence` persistence.

### C7 presence snapshot ingest and persistence (implemented)

`PUT /api/telemetry/presence` requires the C4 Bearer credential and applies a
bounded request-count limit before authentication. The server validates every
required schema-1 field, including `shard` and `party_count`, then explicitly
projects only the approved current-state columns. Those two validated fields
are discarded and do not affect client meaningful-change detection, stored
state, or server idempotency comparison. A per-device row is replaced only
when a strictly newer revision is accepted; revision high-water update and
upsert share one PostgreSQL transaction. Exact duplicates preserve the
original receipt timestamp, while stale/conflicting revisions return the
server high-water for durable client reconciliation. Account deactivation
deletes the account's presence rows transactionally without revoking its
devices; reactivation permits the same non-revoked credentials to resume.
The Windows tray maps live reducer snapshots through a dedicated allowlist,
uses C5's locked durable revision file, and retries an unchanged request with
the same revision/body. C8 transactionally adds an allowlisted history row
only for an accepted C7 revision; equal retries, stale/conflicting requests,
failed auth, revoked devices, inactive accounts, and database failures do not
write history. No player handle, ship owner, Party identity, raw parser/log
data, or peer sharing is introduced.

### C8 device management and private history (complete)

The MobiGlass profile lists and renames only the authenticated user's devices,
derives online status from the existing 90-second heartbeat TTL, and offers
deliberate per-device revocation. Revocation locks the owned device and
transactionally marks it revoked while deleting its current presence row; the
history is retained for the remainder of its 90-day retention. C4 auth checks
reject later heartbeat/presence requests, while other devices remain
unchanged.

History contains only device/revision identity, location raw identifier,
jurisdiction, ship name, event observed time, and server received time. It is
owner-only, keyset-paginated in deterministic receipt-time/ID order, and kept
for 90 days from server receipt. The owner may delete all history at any time
without changing devices or current presence. The timeline labels receipt
time when no observation time exists, and shows unknown location/ship instead
of inferring values. Expired rows are hidden immediately; physical cleanup
runs in bounded batches in the background at startup and daily. Account
deactivation blocks access and new writes while rows age normally;
reactivation exposes only unexpired rows. Hard account deletion cascades
remaining history immediately. No parser-event stream or peer sharing is
added.

### Telemetry location catalog and exact resolution (Issue #126)

The history's original `location_raw` and `jurisdiction` values remain
immutable. `location_raw` is resolved only by an exact byte-for-byte key in
`telemetry_location_catalog` with `status='verified'`; there is no fuzzy
matching or fallback to a same-named location. The history endpoint joins this
global reference table at read time, so admins can correct future display of
already-retained history without rewriting telemetry snapshots. A disagreement
between legacy telemetry jurisdiction and an approved mapping displays
jurisdiction as `Unknown` until the catalog record or source is reviewed.

Place, parent, game system, jurisdiction, and faction/affiliation are separate
catalog fields. The live Windows monitor uses the same exact-key bundle and
resolver as Web History. It shows the raw key secondarily, never treats
`TelemetryState.Jurisdiction` as authoritative, and keeps operating with the
raw key plus `Unknown` display dimensions when no fresh catalog entry exists.
The reducer clears its previous jurisdiction observation on a location
transition, preventing a value from one system/location from being carried into
the next presence snapshot. This corrects the stale-value cause of false UEE
display; existing historical values are not bulk-rewritten.

The device endpoint `GET /api/telemetry/v1/location-catalog` reuses C4 device
Bearer authentication, returns a bounded versioned bundle with ETag, and has a
separate 24-request/day/device limit. It does not mutate heartbeat or presence
timestamps or receive any gameplay fields. The Windows client uses a
server-specific local JSON cache with an atomic write, restrictive permissions,
and a maximum 24-hour validity; refresh is scheduled independently every 12
hours, not per event.

Admin catalog routes are protected by the existing admin session check, and
writes also require the configured exact VerseLink Origin. The panel exposes no
user IDs, device IDs, credentials, history rows, or user activity. Admins can
search/edit exact keys, mark reviewed entries verified, and preview unknown
keys. External imports are proposal-only and cannot create a raw-key mapping.
The Star Citizen Wiki `/api/locations` response currently exposes UUID, slug,
name, system/star, parent, type, jurisdiction, affiliation, `updated_at`, and
game-data `version`, but no internal telemetry `location_raw` key; a name or
hierarchy resemblance is therefore never an exact match. Its records can only
populate review proposals. UEX terminal records are likewise treated as
reference proposals, not key mappings. Import is server-side, bounded by
timeout, per-page and page-count limits, idempotent, and writes only to the
proposal table, preserving all manually reviewed catalog rows. See
[`LOCATION_CATALOG.md`](LOCATION_CATALOG.md) for field mapping and source
limitations. No external service is called by Windows or by per-entry history
resolution.

### C9 end-to-end verification (in review)

C9 adds a PostgreSQL-backed server integration scenario that composes real C3
pairing and claim, C6 heartbeat, C7 revisioned presence ingest, C8 private
history, and per-device revocation in one isolated test schema. Existing Go
tests independently exercise snapshot mapping, durable revisions, retry
identity, outage recovery, `Retry-After`, cancellation, and authentication-stop
behavior through controlled HTTP servers. The manual Windows DEV procedure is
documented in [`../../telemetry/C9_TESTER_GUIDE.md`](../../telemetry/C9_TESTER_GUIDE.md);
it remains a separate acceptance check and is not implied by automated tests.

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

## B6 Windows release packaging and manual update contract

Telemetry release tags use exactly `telemetry-vMAJOR.MINOR.PATCH` (no leading
zeroes, pre-release suffix, or build suffix), independently of the VerseLink
server/web app's `vMAJOR.MINOR.PATCH` tags. The tag-only GitHub Actions
workflow triggers only on the `telemetry-v*` namespace, cross-builds the
Windows amd64 tray executable with the GUI subsystem, and embeds the normalized
application version (`vMAJOR.MINOR.PATCH`) and full source commit in linker
metadata. DEV/source builds
retain `dev` and `unknown` fallbacks. Build flags disable VCS stamping and
trim source paths and pin the Go toolchain to 1.27.1. The ZIP uses fixed
timestamps, fixed member order/permissions, and stored (uncompressed) entries
to avoid compressor-version drift. The workflow builds and packages the same
commit twice in separate directories and requires byte-identical ZIPs before
publishing.

The chosen format is a portable ZIP, not an installer. It contains exactly
`verselink-telemetry.exe` and `INSTALLATION.txt`; no settings, credentials,
logs, update manifests, signatures, helper executable, or other files are
packaged. The workflow publishes the ZIP and a SHA-256 sidecar only for a
valid stable Telemetry tag. The release uses the full `telemetry-v...` tag and
a `VerseLink Telemetry v...` title; the ZIP filename uses the normalized app
version. The workflow has `contents: write` only to create that release; main
app tags, pull requests, and ordinary branch pushes do not trigger it.
No release signing key or GitHub secret is used or required.

The SHA-256 sidecar detects accidental transfer/storage corruption. Since
the checksum is published beside the archive, it is not an independent
publisher-authentication or release-provenance proof. B6 binaries are not
Authenticode-signed. Windows may show SmartScreen's unknown-publisher warning;
users should obtain artifacts only from the official VerseLink Releases page
and verify the adjacent checksum. No trusted-publisher signing claim is made.

First installation is a user-level extraction to a writable folder, followed
by launching the tray executable; no elevation or service is used. Manual
updates require the user to exit the application, keep a copy of the previous
executable, verify and extract the new ZIP, replace only the executable, and
launch it. After confirming startup, the backup may be discarded. If startup
fails, exit the new process and restore the previous executable. The package
does not include or modify `%LOCALAPPDATA%\VerseLink\Telemetry\settings.json`
or Windows Credential Manager entries, so settings and paired credentials
survive replacement and rollback.

Automatic release checks were outside the B6 packaging scope and are added by
B7 as a notification-only lookup. Background downloads, downloaded-package
application, self-replacement, helper processes, and automatic update rollback
remain out of scope. No updater trust mechanism or signed update manifest is
implemented.

## B7 startup release-availability check

Stable Telemetry builds start a best-effort worker that requests the public
GitHub releases list at
`https://api.github.com/repos/compumark/verselink/releases?per_page=100`.
The worker has a five-second deadline and accepts at most 1 MiB of JSON. It
does not follow redirects, authenticate, or include client-specific headers
beyond fixed Accept and application User-Agent values. The check skips invalid
or development build metadata. It selects the highest numeric, stable version only from
non-draft, non-prerelease `telemetry-vMAJOR.MINOR.PATCH` tags; repository
server/web releases and malformed tags are ignored.

The result crosses to the native UI only as validated installed/available
version values through the tray window message queue. A newer version causes
one notification per process and changes the tray tooltip to identify the
available version. The **View release** action opens a compile-time fixed
`https://github.com/compumark/verselink/releases` URL, never an API-provided
URL. The worker is canceled with app shutdown; queued completion is discarded
once shutdown begins. API, network, timeout, cancellation, and JSON errors are
silent. No identifiers, credentials, telemetry, response text, or release
assets are sent or persisted. The app does not download, install, replace, or
roll back binaries; users follow the B6 checksum-verified manual update and
rollback procedure.
