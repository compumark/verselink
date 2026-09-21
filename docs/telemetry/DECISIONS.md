# VerseLink Telemetry — Architecture Decisions

This file records project-level decisions that should not be silently changed by implementation tasks.

---

## ADR-001 — Telemetry is separate from the OCR Companion

Date: 2026-09-21  
Status: Accepted

### Decision

VerseLink Telemetry is developed as a separate project/subproject from the existing `companion/` OCR prototype.

### Reason

OCR/screenshot extraction and continuous `Game.log` telemetry have different runtime, platform, release, and security requirements.

### Consequences

- existing `companion/` code is not a dependency,
- Telemetry may use a different language/toolchain,
- both clients may later integrate with VerseLink independently.

---

## ADR-002 — Prefer a standalone Telemetry repository

Date: 2026-09-21  
Status: Accepted for A1; future extraction remains planned

### Decision

Prefer a future standalone repository such as `compumark/verselink-telemetry` rather than permanently coupling the desktop client to the VerseLink web-server repository.

### Reason

This enables:

- independent releases,
- separate Windows/Linux binaries,
- independent CI,
- smaller checkout/release scope,
- independent issue tracking and updater lifecycle.

### Transition

Planning documentation starts in the main VerseLink repository. The implementation repository may be created as part of A1.

For A1, the implementation is intentionally located in `telemetry/` inside
the VerseLink repository. It is a standalone Go module and is technically
independent from the Node.js application. The existing `companion/` OCR
project remains entirely separate. Moving the module to
`compumark/verselink-telemetry` later should mainly require repository and CI
relocation, not code redesign.

---

## ADR-003 — Go is the preferred implementation language

Date: 2026-09-21  
Status: Accepted for A1

### Decision

Use Go for the new Telemetry client unless A1 identifies a blocking reason.

### Reason

- self-contained binaries,
- low resource use,
- Windows/Linux support,
- strong fit for file tailing/background processes,
- simple HTTP and concurrency model.

### Alternatives considered

- .NET 8
- Node.js

The existing Windows-only OCR stack is not a reason to force Telemetry onto .NET.

A1 validates this choice with a minimal standalone Go module under
`telemetry/`, using only the standard library.

---

## ADR-004 — Game.log is the initial telemetry source

Date: 2026-09-21  
Status: Accepted

### Decision

Initial telemetry reads Star Citizen `Game.log` in read-only mode.

### Explicitly excluded

- process-memory reading,
- DLL injection,
- game hooks,
- packet sniffing,
- game-file modification,
- automated chat input.

---

## ADR-005 — Events and current state are separate models

Date: 2026-09-21  
Status: Accepted

### Decision

Parsed `TelemetryEvent` objects are reduced into a separate `TelemetryState`.

### Reason

A log line reports an event, while VerseLink needs a coherent current state.

Examples:

- `ship_boarded` sets current ship,
- `ship_exited` clears it,
- QT events build a travel state,
- party events maintain a member set.

The MobiGlass UI must consume state/API models, not raw Game.log semantics.

---

## ADR-006 — Location is last-observed, not continuous GPS

Date: 2026-09-21  
Status: Accepted

### Decision

A Game.log `location_change` is stored and displayed as a last-observed location with a distinct `location_observed_at` timestamp.

### Reason

The observed parser source is a location inventory request and does not provide continuous XYZ coordinates.

A heartbeat must never make an old location appear newly observed.

---

## ADR-007 — Device authentication is independent of browser sessions

Date: 2026-09-21  
Status: Accepted

### Decision

The future Telemetry client uses pairing plus revocable per-device credentials.

It must not store:

- VerseLink passwords,
- browser session cookies.

The server stores only a secure representation/hash of long-lived device credentials.

---

## ADR-008 — Privacy is opt-in and server-enforced

Date: 2026-09-21  
Status: Accepted

### Decision

Presence data is shared only according to explicit user preferences enforced by the server.

Initial privacy controls should independently cover:

- online status,
- shard,
- location,
- ship,
- QT destination,
- party information.

Mission, medical, crime, and economy telemetry require separate future review.

---

## ADR-009 — SC Bridge is a reference, not a fork

Date: 2026-09-21  
Status: Accepted

### Decision

Use SC Bridge's public parser documentation and observed patterns as a reference, while implementing VerseLink-specific architecture and state handling.

If substantial MIT-licensed SC Bridge code is copied, preserve the required copyright/license notice in VerseLink's third-party notices.

---

## ADR-010 — GitHub is the implementation source of truth

Date: 2026-09-21  
Status: Accepted

### Decision

When planning notes, chats, or prior Codex output conflict with the repository, use this order:

1. merged code on `main`,
2. current architecture documentation,
3. open GitHub issues and PRs,
4. project plan,
5. planning chat,
6. old Codex transcripts.

Each implementation issue should end with a standardized implementation report and be reviewed before merge.
