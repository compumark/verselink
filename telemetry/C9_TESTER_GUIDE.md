# C9 Windows DEV end-to-end test guide

This guide is for a deliberately configured, non-production VerseLink DEV
instance and dedicated test account/device only. It does not authorize or
describe testing against production. Do not use a production account, database,
credential, pairing code, or `latest` image. C9 does not require B6 packaging.

## Prerequisites

- A Windows build of the VerseLink Telemetry tray application from the build
  under test.
- An explicitly identified DEV base URL and a DEV VerseLink profile where you
  can create pairing codes and manage your own devices.
- A dedicated disposable DEV account and device. Use a synthetic Game.log if
  no Star Citizen session is available; never attach a personal full log to a
  report.
- If database persistence must be inspected, authorized read-only access to the
  DEV database and the telemetry schema. Never put database credentials in
  screenshots or reports.

If any DEV endpoint, test account, or client is unavailable, mark the manual
test **NOT RUN** and stop before making a network request.

## Configure and pair

1. Start the built `verselink-telemetry-tray.exe` as the normal Windows user;
   do not run it elevated. Open **Settings → VerseLink connection**.
2. Enter the explicitly supplied DEV origin (for example, the DEV HTTPS
   origin; do not infer or substitute a production hostname). HTTPS with normal
   Windows certificate validation is required. For a local loopback DEV only,
   HTTP requires the explicit `VERSELINK_TELEMETRY_ALLOW_HTTP=1` override.
3. In the dedicated DEV account's VerseLink profile, create a one-time pairing
   code. Enter it in Settings with a recognizable test-device name and select
   **Connect**. The code is one-use; never retry an ambiguous timeout until
   checking whether the code was consumed.
4. Confirm the client reports a paired/connected state after its first
   successful heartbeat. The credential must be stored in the current user's
   Windows Credential Manager, not in `settings.json`.

## Verify Game.log monitoring and presence

1. Open **Live Monitor**. Confirm the configured/selected Game.log source and
   local parser state. Start with the client before the game, and also repeat
   with an existing game session if available. A sanitized synthetic log is
   acceptable for deterministic local parsing checks.
2. Confirm the connection/heartbeat state independently from gameplay state.
   A connected heartbeat does not mean a game session is active. Missing
   jurisdiction, ship, Quantum Travel, Party count, or timestamps may
   legitimately display as **Unknown** when the source has not observed them.
3. In a DEV Star Citizen session, produce at least two real location changes
   with enough time for the client to observe them. Confirm the local monitor
   updates, then verify the DEV database has the latest `telemetry_presence`
   row for this device and accepted revisions in the owner's
   `telemetry_presence_history`.
4. Compare the allowed fields only: location raw identifier and observation
   time, jurisdiction, ship name, revision, and server `received_at` (plus the
   explicitly modeled current snapshot fields). `shard` and `party_count` are
   validated on input but are not persisted. No raw Game.log line, parser event
   map, GEID, Party identity, local path, credential, or pairing code belongs
   in database output.

## Verify revocation and device isolation

1. In the DEV profile's device management, revoke the test device. Confirm the
   client reports **Device revoked** or the documented authentication-failed
   state and stops authenticated retries.
2. Confirm a subsequent heartbeat and presence request using that device is
   rejected as `401 device_revoked` with a Bearer challenge. Confirm the current
   presence row is removed and the existing private history remains until its
   retention expiry. Do not capture or publish the Authorization header.
3. Optional isolation check: pair a second dedicated DEV device under the same
   test account. Revoke the first device and verify the second can still
   heartbeat and submit presence. Never reuse the first device's credential.

## Verify outage and recovery safely

Use only a DEV instance for which you are authorized to perform a brief
availability test. Prefer a controlled local proxy or an announced DEV
maintenance window. Do not stop shared or production services.

1. With the client monitoring a local log, make the DEV endpoint temporarily
   unreachable through the approved test mechanism. Confirm the client reports
   temporary unavailability, bounded retry/backoff, and continued local
   Game.log monitoring.
2. Restore DEV connectivity without changing pairing. Confirm heartbeat and
   changed presence resume and the DEV current row/history advance once per
   accepted state, without a request storm or duplicate-history flood.
3. Stop the app cleanly and verify no further requests are made. Restart and
   confirm the persisted revision continues above the server high-water mark.

## Report parser compatibility observations (#48 / #49)

For a #48-style observation (Shard is not detected in a particular game/log
state) or a #49-style observation (ship exit is not confirmed), report against
the existing issue rather than expanding C9 or changing parser scope. Include
the game version and channel, approximate time with timezone or UTC, steps to
reproduce, expected behavior, actual behavior, and whether the Live Monitor
shows a different state. Do not post raw Game.log lines or files, GEIDs,
pairing codes, device credentials, browser cookies, Authorization headers, or
private account/device identifiers. Share only sanitized observations and
redacted screenshots; never attach a full log.

## Evidence and privacy

Record the build version, DEV environment label (not secret URL components),
test steps, approximate times, visible state transitions, and PASS/FAIL/NOT
RUN. Before sharing any screenshot, redact account email/name, device IDs if
not needed, pairing codes, credentials, Authorization headers, cookies,
database connection strings, hostnames/IPs, filesystem paths, GEIDs, Party
names/IDs, and any raw Game.log content. Never attach a full Game.log, database
dump, `settings.json`, or credential-store export. If a failure requires server
evidence, share only sanitized status/error codes and authorized redacted
server-side metadata.
