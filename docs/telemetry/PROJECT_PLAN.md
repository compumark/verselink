# VerseLink Telemetry — Project Plan

Status: Planning  
Created: 2026-09-21

## Goal

Build a standalone, lightweight VerseLink Telemetry client that reads Star Citizen `Game.log`, parses a controlled allowlist of events, derives a local gameplay/presence state, and later connects that state to VerseLink through a dedicated device-authenticated API.

The existing `companion/` OCR project is intentionally independent and is not part of this plan.

## Working principles

- GitHub is the source of truth for implemented state.
- One issue should produce one clearly reviewable result.
- Architecture changes outside an issue's scope must be discussed before implementation.
- Parser behavior is covered by positive, negative, and regression tests.
- Raw `Game.log` lines are never uploaded by default.
- No process-memory reading, DLL injection, keyboard hooks, packet sniffing, or game-file modification.
- Presence and location sharing are opt-in and enforced server-side.

## Milestone A — Telemetry Core

Goal: prove that a local client can reliably find, tail, parse, and reduce Star Citizen log events without any VerseLink backend dependency.

| ID | Work item | Status |
| --- | --- | --- |
| A1 | Project scaffold | COMPLETE |
| A2 | Event specification and parser fixtures | COMPLETE |
| A3 | Windows Game.log locator | COMPLETE |
| A4 | Robust Game.log tailer | COMPLETE |
| A5 | Session event parser | COMPLETE |
| A6 | Location event parser | IN REVIEW |
| A7 | Ship event parser | TODO |
| A8 | Quantum Travel event parser | TODO |
| A9 | Party event parser | TODO |
| A10 | Telemetry state reducer | TODO |
| A11 | Session restore / restart handling | TODO |
| A12 | Regression corpus and diagnostics | TODO |

Initial server-relevant events:

- `player_login`
- `server_joined`
- `player_spawned`
- `location_change`
- `jurisdiction_entered`
- `ship_boarded`
- `ship_exited`
- `qt_target_selected`
- `qt_fuel_requested`
- `qt_arrived`
- `party_member_joined`
- `party_member_left`
- `party_disbanded`

Parsed but initially not used for presence:

- `blueprint_received`
- `refinery_complete`

Exit criteria:

- all A1–A12 work items are merged,
- supported events have regression tests,
- the client can reconstruct current state from a live or fixture log,
- no VerseLink HTTP/backend integration is required.

## Milestone B — Windows Client

Goal: turn the core into a usable Windows background application.

Planned work:

- local diagnostics view,
- tray application,
- settings and manual log-path override,
- start with Windows,
- connection/game-state indicators,
- local logs and troubleshooting export,
- release packaging and updater strategy.

## Milestone C — VerseLink Connection

Goal: securely connect a local device to a VerseLink account.

Planned work:

- `telemetry_devices`,
- short-lived pairing codes,
- per-device random credentials,
- revocation,
- heartbeat API,
- event ingest API,
- payload schema validation and rate limiting,
- current presence persistence.

No browser session cookie or VerseLink password is stored by the telemetry client.

## Milestone D — Crew Presence

Goal: expose useful, privacy-controlled presence in the MobiGlass shell.

Planned work:

- privacy model,
- presence API,
- location resolver,
- Crew / Presence MobiGlass application,
- same-shard indicator,
- same-party indicator,
- same-ship indicator,
- current ship,
- last observed location,
- QT destination/state.

## Milestone E — Advanced Telemetry

Potential additions after presence is stable:

- `blueprint_received`,
- `refinery_complete`,
- mission lifecycle,
- medical/incapacitated state,
- hangar and vehicle retrieval,
- richer Quantum Travel states.

## Milestone F — Positioning

Optional coordinate support based on user-triggered `/showlocation`:

- clipboard parser,
- XYZ state,
- timestamped coordinate history,
- coordinate-to-location mapping,
- optional map features.

The client must not automate chat input or inject commands into the game.

## Milestone G — Linux

Goal: reuse the same parser/state/API core with Linux-specific platform adapters.

Planned work:

- Wine/Proton/Lutris-style log discovery,
- manual path configuration,
- Linux packaging,
- optional X11/Wayland clipboard adapters,
- Linux CI.

Linux support is best-effort because Star Citizen itself is not officially supported on Linux.

## Definition of Done

Every implementation issue must satisfy:

- [ ] Scope implemented
- [ ] Tests added where applicable
- [ ] Existing tests pass
- [ ] Formatting/static checks pass
- [ ] No unrelated changes
- [ ] Documentation updated when behavior/contracts change
- [ ] Security/privacy impact reviewed
- [ ] Implementation report provided
- [ ] PR reviewed and merged

## Implementation report format

Codex implementation tasks should finish with:

```text
IMPLEMENTATION REPORT

Branch:
Starting HEAD:

Scope completed:
-

Files changed:
-

Tests added:
-

Tests executed:
-

Test result:

Static/diff checks:

Known limitations:
-

Out of scope / untouched:
-

Git status:

Commit:
NOT CREATED

Push:
NOT PERFORMED

READY FOR REVIEW
```
