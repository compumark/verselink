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
GEIDs, credentials, cookies, passwords, and tokens. Nothing is transmitted to
a backend; VerseLink account connection and upload are not implemented.

The monitor intentionally reports the telemetry core's current observations
without compensating for known live compatibility limitations: shard
detection may be unavailable in some logs (#48), ship exit may not be
confirmed in the current live test (#49), and Party reconstruction can be
incomplete in some scenarios. These issues are separate from the monitor.

B2 itself did not provide persistent settings or a settings UI. Windows
autostart, a service, an installer/updater, and network telemetry remain out
of scope. Known live compatibility investigations for
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

## C5 VerseLink pairing (review pending)

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

The Settings status means the claim response was safely stored locally; C5
does not yet probe server authentication or revocation. C6 will establish
authenticated heartbeat/connection health. **Disconnect locally** removes
the local Credential Manager entry and local device metadata only; it does
not revoke the device on VerseLink. Remote revoke/device management is C8.
Local Game.log monitoring continues to work when the VerseLink server is
unavailable. The C5 per-device OS lock is held while a paired app instance is
running; a second instance cannot manage that same local device simultaneously.

The security boundary is explicit. VerseLink Telemetry will not use process
memory reading, DLL injection, kernel drivers, packet sniffing, keyboard hooks,
automated chat input, or modification of Star Citizen files. Its initial future
data source is `Game.log`, read-only.
