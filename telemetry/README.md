# VerseLink Telemetry

VerseLink Telemetry is a Windows tray client and server-side connection for
private, allowlisted gameplay presence. The client reads Star Citizen's
`Game.log` locally, derives a structured current state, and—after explicit
pairing with a configured VerseLink instance—sends authenticated heartbeat and
schema-1 presence requests. The server stores current per-device presence and
the owner's bounded private history; it does not receive raw logs or parser
event streams.

The Go client lives in `telemetry/` and the VerseLink API/persistence live in
the existing Node.js server. They remain separate from `companion/`, which is
an independent OCR project.

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

Milestone A provides the sanitized parser contract, regression corpus, and
local telemetry reducer. Milestone B adds the foreground runtime, Windows
tray, settings, pairing UX, secure Credential Manager storage, and local live
monitor. Milestone C implements the pairing/device lifecycle, heartbeat,
presence ingest, and private device/history management described below.

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

The local diagnostics and live monitor summarize structured state without
retaining raw Game.log lines or GEIDs. Connection secrets are excluded from
settings and diagnostics.

## Connection and privacy boundary

The client sends only the explicit schema-1 presence DTO over HTTPS to the
configured VerseLink origin. Pairing credentials are device-scoped and stored
in the current Windows user's Credential Manager. Heartbeat health is separate
from gameplay state; network outages do not stop local log monitoring.
Presence starts private to its owning account. C8 history is an allowlisted
projection retained for 90 days, survives device revocation for the remaining
retention period, and can be deleted by its owner. See
[`CONNECTION_CONTRACT.md`](CONNECTION_CONTRACT.md) for the normative contract
and [`C9_TESTER_GUIDE.md`](C9_TESTER_GUIDE.md) for safe DEV validation.

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

To provide a one-process development/admin override for the selected log,
set `VERSELINK_GAME_LOG_PATH` before launching. This explicit override takes
priority over saved tray settings and automatic discovery:

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

### Live telemetry monitor (C0)

Choose **Open live telemetry** from the tray menu to keep a native Windows
monitor window open while testing. It displays the current runtime phase,
effective Game.log path, discovery strategy and channel; processed-line, parser
event and source-reset counters; session/player/shard and last-event time;
location/time/jurisdiction; ship/owner; Quantum Travel destination/state; and
Party member count. Values update locally from detached structured runtime
snapshots at approximately one-second intervals. The monitor does not open,
tail, or parse `Game.log` itself. Missing values are shown as **Unknown**.

**Copy current status** copies a deterministic plain-text snapshot using the
Windows Unicode clipboard. It includes only the listed structured fields and
Party count. It excludes Party identities, raw log lines, raw event maps,
GEIDs, credentials, cookies, passwords, and tokens. The monitor itself makes
no network request; paired connection workers send only heartbeat and the
allowlisted current-presence DTO.

The monitor intentionally reports the telemetry core's current observations
without compensating for known live compatibility limitations: shard
detection may be unavailable in some logs (#48), ship exit may not be
confirmed in the current live test (#49), and Party reconstruction can be
incomplete in some scenarios. These issues are separate from the monitor.

B2 itself did not provide persistent settings or a settings UI. Windows
autostart and a service were outside B2. B6 later defines portable manual
release packaging; it does not add an installer or automatic updater. Known
live compatibility investigations for
shard detection (#48) and ship-exit confirmation (#49) remain separate work.

## B3 local Game.log settings

The Windows tray menu now includes **Settings...**. Settings are stored locally
at `%LOCALAPPDATA%\VerseLink\Telemetry\settings.json`; no telemetry events,
raw log lines, GEIDs, Party member names, credentials, or API secrets are saved
there. The versioned settings file contains only the selected mode and, in
manual mode, the Game.log path.

Automatic discovery is the default when no settings file exists. In Settings,
choose **Manual Game.log** and use **Browse...** to select a readable regular
file named `Game.log`. The app validates the path read-only; selecting a folder,
another filename, missing file, or unreadable file is rejected. Select
**Automatic discovery** to clear the manual override. Changes are saved
atomically and take effect after restarting VerseLink Telemetry.

Game.log selection priority is:

1. a valid `VERSELINK_GAME_LOG_PATH` environment override,
2. a valid persisted manual path,
3. the existing automatic locator strategy order.

An invalid environment override does not stop telemetry or change saved
settings. VerseLink next tries a valid saved manual path, if configured, and
otherwise uses automatic discovery. An invalid saved manual path remains
configured while the runtime falls back to automatic discovery. The tray status
and diagnostics retain the relevant local warning alongside the effective path
and strategy. A malformed or unsupported settings file uses automatic defaults,
reports a warning, and is left untouched until the user saves a new
configuration.

The effective channel is derived from the path shape
`...\StarCitizen\<channel>\Game.log`, so LIVE, PTU, EPTU, and future channel
directory names can be shown without storing a separate channel setting.
Settings are local only and are never uploaded.

## B4 Windows startup and application lifecycle

The tray Settings window includes **Start with Windows**. It is off by
default. Enabling it writes one VerseLink-owned value to the current Windows
user's `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` key. The value
contains the absolute path to this executable and the fixed `--autostart`
argument. No administrator rights, service, scheduled task, or shell command
is used. The setting is stored in the registry, not duplicated in
`settings.json`.

Settings reads the current registry value when opened and after changes. If the
value points to a different or moved executable, it is shown as needing
attention. **Repair** explicitly changes it to the currently running
executable; **Disable** removes only VerseLink Telemetry's named Run value.
Normal application startup never edits the registry. If the executable is
moved or deleted, the old value can become stale and must be repaired or
disabled in Settings from the new executable.

The app creates a per-user, per-interactive-session Windows mutex before
loading settings, accessing Credential Manager, creating the tray, or starting
runtime/network workers. A second manual launch shows “VerseLink Telemetry is
already running” and exits without starting workers. A duplicate started with
`--autostart` exits silently. The existing per-device revision lock remains a
separate protection for device revision state.

Exit, an unexpected tray-loop exit, and a confirmed Windows session end use the
same shutdown path. A session-end query is answered promptly without starting
shutdown, so an aborted sign-out leaves the app running. Shutdown stops new UI
and pairing actions, cancels pairing and the shared runtime context, then waits
for Runtime, Heartbeat, Presence, and Pairing under one 8-second total budget.
Only after workers finish are pairing results drained, windows/tray resources
cleaned up, and locks released. There is no network flush. If workers exceed
the budget, the process exits with code 2 without running cleanup under live
workers; Windows releases process-owned handles and locks. The timeout is
recorded only in the bounded in-memory lifecycle list and emitted through
`OutputDebugString`; it is not persisted or available after process exit. No
raw logs, credentials, codes, headers, GEIDs, or presence payloads are recorded.

Missing Game.log discovery continues to retry every 15 seconds, and the
existing restore, tailing, rotation, truncation, and source-reset behavior is
unchanged. Changing the selected Game.log path still requires restarting
VerseLink Telemetry. No B4 path starts a second runtime or queues old presence
snapshots for a later send.

### B4 Windows DEV smoke test

Use a disposable development executable and account/device. The automated
registry adapter test uses a unique temporary key under the current user's
`Software` tree; it does not touch the real Run key. The manual checks below
are separate and have not been performed by the automated suite:

1. Open Settings, verify Start with Windows is off, enable it, save, reopen,
   and confirm the actual registry state. Disable it and confirm it remains off
   after the next sign-in.
2. Enable it again, sign out and in, and confirm exactly one tray icon and one
   set of workers. Manually launch the executable a second time and confirm
   the informational duplicate-start message with no duplicate network updates.
3. Exit normally and relaunch. Then terminate the process from Task Manager and
   relaunch; the mutex must be released by Windows in both cases.
4. Start VerseLink Telemetry before Star Citizen; verify it finds Game.log when
   Star Citizen starts later. End the game, allow log rotation/truncation, and
   restart it; verify monitoring and source-reset diagnostics remain coherent.
5. Start pairing and choose Exit; verify pairing is canceled/drained and the
   process ends. Test Windows sign-out twice: cancel after the query, then
   confirm sign-out; only the confirmed end should stop the tray.
6. Move the executable. Verify Settings reports the old startup entry, then
   test explicit Repair and Disable. Confirm no other Run value changes.
7. With the existing DEV pairing active, verify startup, shutdown, and relaunch
   do not duplicate presence updates or disturb the device revision lock.

## B5 local diagnostics export

Choose **Export troubleshooting package...** from the Windows tray menu. A
confirmation explains the contents before the native Save dialog opens. The
result is a deterministic schema-1 JSON snapshot, bounded to 16 KiB, written
only to the user-selected local path. Canceling either dialog writes nothing;
save failures are reported without exposing operating-system error details.
The export is never uploaded or sent to a support/backend endpoint.

The package includes app/build/Go/platform metadata, coarse runtime phase,
discovery strategy and channel category, Game.log availability, session and
gameplay-state presence flags, Quantum Travel state category, Party count,
aggregate line/event/reset counters, connection-state category, up to 12
allowlisted lifecycle codes, and up to 24 structured local application-log
entries (maximum 4 KiB). The application log is a thread-safe 64-entry ring
whose records contain only a UTC timestamp, fixed severity, and fixed event
code; it never accepts message text or telemetry values. The whole export is
limited to 16 KiB. It excludes absolute paths, raw Game.log lines,
player handles, shard/location/destination names, ship-owner and Party names,
GEIDs, device identifiers, credentials, cookies, pairing codes, tokens,
headers, and free-form warnings/errors. Unknown categories are normalized to
safe fallback values and unknown lifecycle entries are omitted. The schema is
documented in `docs/telemetry/ARCHITECTURE.md`.

## C5 VerseLink pairing

Open **Settings... → VerseLink connection** to pair this Windows client with a
VerseLink account. Generate a one-time pairing code in the authenticated
VerseLink profile, enter it in Settings, and select **Connect**. This client
never asks for a VerseLink password, browser cookie, browser session, or account
token. A successful claim stores the device credential only in the current
Windows user's Credential Manager; `settings.json` contains only the explicit
server URL and non-secret device ID/name. If Credential Manager storage fails,
the app does not show Connected or save the credential elsewhere. Because the
code is single-use, after a timeout check whether the code was consumed before
requesting a replacement and retrying manually.

The client does not infer a public production host. Configure the instance URL
in the Settings field, or set `VERSELINK_APP_URL` in the client process
environment (it takes precedence). This is separate from the server's
deployment environment and is not inherited automatically. Without either
source, pairing remains unavailable. Production URLs must use HTTPS. For an
explicit local development server only, set
`VERSELINK_TELEMETRY_ALLOW_HTTP=1`; HTTP is still accepted only for
`localhost`/loopback addresses. Do not use this override for production.

The Settings status follows the authenticated heartbeat state; local pairing
storage alone is shown as Connecting until the server accepts a heartbeat.
**Disconnect locally** removes
the local Credential Manager entry and local device metadata only; it does
not revoke the device on VerseLink. Remote revoke/device management is
available in the C8 VerseLink device-management UI.
Local Game.log monitoring continues to work when the VerseLink server is
unavailable. The C5 per-device OS lock is held while a paired app instance is
running; a second instance cannot manage that same local device simultaneously.

## C6 heartbeat and connection health

While paired and running, the client sends an authenticated heartbeat
immediately and every 30 seconds. Credentials are read from the current
Windows user's Credential Manager and sent only in the Authorization header;
they are never written to settings or diagnostics. Connection health is shown
as Not connected, Connecting, Connected, Temporarily offline, Authentication
failed, or Device revoked, with the last successful server heartbeat timestamp
available in Settings. Network loss does not interrupt local Game.log parsing
or clear gameplay state.

Requests have a 10-second timeout. Network/timeouts and server failures retry
with capped exponential backoff and full jitter; Retry-After governs rate-limit
retries. Authentication failure or revocation stops heartbeat traffic. After
resolving an inactive account, restart the client to authenticate again; a
revoked device must be paired as a new device. Application shutdown cancels active
requests and pending retry waits. Server `last_seen_at` and its 90-second online
window represent connection health only—not an active Star Citizen session or
shared gameplay presence.

## C7 private presence snapshots

While paired, the Windows tray client sends an authenticated
`PUT /api/telemetry/presence` only when the mapped current snapshot changes.
It maps `TelemetryState` into the versioned schema-1 allowlist; player handle,
ship owner, Party identities, parser events, raw log lines, local paths, and
diagnostics are never included. The server validates `shard` and `party_count`
but deliberately discards them; neither field is persisted or triggers a client
snapshot revision by itself. The server persists only one
latest private snapshot per device with a server receipt timestamp. A durable
per-device revision advances under the existing C5 OS lock; a retry reuses the
same revision and body, while a `409` high-water response is reconciled before
retry. Presence failures do not stop local monitoring or C6 heartbeat.

Presence ingestion does not provide peer sharing or a parser-event stream.
Owner-only reads are limited to the C8 private history API. Account
deactivation transactionally removes current presence without revoking
devices; hard device or account deletion cascades through the ownership schema.

The security boundary is explicit. VerseLink Telemetry will not use process
memory reading, DLL injection, kernel drivers, packet sniffing, keyboard hooks,
automated chat input, or modification of Star Citizen files. `Game.log` is
read-only and is never uploaded.

## C9 end-to-end verification

The PostgreSQL integration suite includes a composed C3–C8 path covering
pairing, device heartbeat, multiple accepted presence revisions, private
history persistence, and revocation isolation. The Go connection tests cover
client-side mapping, durable revisions, retry/recovery, authentication failure,
and cancellation with controlled HTTP servers. These automated checks do not
replace the manual Windows DEV acceptance procedure in
[`C9_TESTER_GUIDE.md`](C9_TESTER_GUIDE.md); no production endpoint or database
is used by that procedure.

## B6 Windows releases and manual updates

Each stable Telemetry release uses its own `telemetry-vMAJOR.MINOR.PATCH` tag
(for example, `telemetry-v0.1.0`), separate from VerseLink server/web release
tags. The executable embeds and displays the normalized app version
`vMAJOR.MINOR.PATCH`. The portable ZIP contains only
`verselink-telemetry.exe` and `INSTALLATION.txt`; diagnostics show the
release version and source commit. Source/DEV builds retain useful `dev` and
`unknown` fallbacks.
The workflow triggers only on the `telemetry-v*` tag namespace and publishes
a `VerseLink Telemetry v...` release with the ZIP and a `.sha256` sidecar. See
[`WINDOWS_RELEASE_INSTALL.txt`](WINDOWS_RELEASE_INSTALL.txt) for concise
installation, update, and rollback steps.

Download only from the official VerseLink GitHub Releases page. Verify the
archive using PowerShell:

```powershell
Get-FileHash .\verselink-telemetry-vX.Y.Z-windows-amd64.zip -Algorithm SHA256
```

Compare the hash with the matching sidecar. Since both files are distributed
from the same release, this catches accidental corruption but does not
independently authenticate publisher identity or release provenance. B6
artifacts are not Authenticode-signed; Windows SmartScreen may show an
unknown-publisher warning. No signing key or certificate is configured.

For a manual update, exit the tray app, back up the old executable, verify and
extract the new ZIP to a temporary folder, and replace only
`verselink-telemetry.exe`. Launch the new version and keep the backup until it
starts successfully. If startup fails, exit it and restore the backup. Settings
remain in `%LOCALAPPDATA%\VerseLink\Telemetry\settings.json`; paired
credentials remain in the current user's Windows Credential Manager. Neither
is included in or changed by the ZIP. B6 does not poll for releases, download
in the background, or automatically replace files.
