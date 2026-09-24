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

---

## ADR-011 — Telemetry uses dedicated per-device bearer credentials

Date: 2026-09-24
Status: Accepted for Milestone C

### Decision

Each paired installation authenticates with a server-issued `vlt_` credential
in `Authorization: Bearer`. It is independent from browser sessions, VerseLink
account/recovery tokens, and SCMDB credentials. The credential is returned
only during successful pairing, stored server-side only as a
domain-separated HMAC-SHA256 using the existing `SINK_TOKEN_PEPPER`, and
independently revocable.

### Reason

This extends ADR-007 without reusing or redesigning browser authentication.
Domain separation follows existing token-HMAC conventions without adding a
second deployment secret.

---

## ADR-012 — Pairing uses one short-lived, one-time human code

Date: 2026-09-24
Status: Accepted for Milestone C

### Decision

Pairing uses a 16-character Crockford Base32 code (80 bits), displayed in four
groups, case-insensitive after normalization, and valid for 10 minutes. Only
one unconsumed code per account is active; issuing another invalidates the
previous one. Claim atomically consumes the code while creating the device.
Only a domain-separated HMAC is persisted; plaintext is returned once.

### Reason

The format is practical to enter while its entropy and claim rate limit make
online guessing impractical. Single-active-code behavior simplifies recovery
and prevents stale codes from remaining valid.

---

## ADR-013 — Phase C sends current presence snapshots, not parser events

Date: 2026-09-24
Status: Accepted for Milestone C

### Decision

The local reducer maps an explicit allowlist into the latest current-presence
snapshot. Phase C does not ingest raw `TelemetryEvent` streams and does not
require `telemetry_events`. The server never receives raw Game.log lines.

### Reason

The product needs current state for later presence, not a historical event
warehouse. This reduces data collection, ingestion volume, parser coupling, and
retention risk. Event history can be reconsidered only with an approved later
requirement.

---

## ADR-014 — Network presence is a versioned explicit DTO

Date: 2026-09-24
Status: Accepted for Milestone C

### Decision

Presence uses an explicit JSON DTO with integer `schema: 1`; it is never a
blind serialization of Go `TelemetryState`. Schema-1 fields, nullability,
validation, compatibility, body limit, and error behavior are defined in
`CONNECTION_CONTRACT.md`. Compatible optional additions preserve existing
meaning; breaking changes use a new schema version.

### Reason

Wire compatibility must not depend on internal Go field names/layout or
silent server inference.

---

## ADR-015 — Heartbeat time is separate from gameplay observation time

Date: 2026-09-24
Status: Accepted for Milestone C

### Decision

Heartbeat is connection health only: clients send every 30 seconds, server
`last_seen_at` uses receipt time, and online TTL is 90 seconds. Heartbeat must
never update location, `last_event_at`, QT, or any other gameplay observation
timestamp.

### Reason

Connection reachability is not a new gameplay observation. This extends the
existing location timestamp boundary in ADR-006.

---

## ADR-016 — Phase-C presence is minimal and private by default

Date: 2026-09-24
Status: Accepted for Milestone C

### Decision

The initial upload allowlist excludes `player_handle`, ship owner, Party
identities, GEIDs, paths, diagnostics counters, raw event data, and raw logs.
It permits Party count only. Server ingestion remains private to the owning
account; Phase D must implement explicit server-enforced opt-in and per-viewer
authorization before any field is shared with other users.

### Reason

Pairing and connection do not imply consent to expose identity or presence to
other players. This extends ADR-008 without prematurely designing Phase-D
sharing or same-party behavior.

---

## ADR-017 — Presence retries use a durable per-device revision

Date: 2026-09-24
Status: Accepted for Milestone C

### Decision

Each device monotonically increments and durably persists a positive
JavaScript-safe integer presence revision (1 through 9,007,199,254,740,991)
before sending a new snapshot. C2 stores it as BIGINT on the device row. The
server accepts only a revision greater than the stored per-device high-water
mark; duplicate/stale retries cannot overwrite newer state. C2 stores the
high-water mark with the device so presence-row cleanup cannot reset ordering.

### Reason

Server receipt order and Game.log timestamps alone cannot safely order delayed
retries across process restarts. The safe-integer ceiling preserves exact JSON
number semantics in VerseLink's JavaScript server; a durable per-device
counter plus a single-writer client lock is deterministic and requires no
separate session/epoch handshake.

---

## ADR-018 — Production telemetry transport is HTTPS and secret-safe

Date: 2026-09-24
Status: Accepted for Milestone C

### Decision

Production telemetry requests use HTTPS with normal platform TLS validation;
no certificate pinning or custom cryptography is introduced. Secrets remain
out of logs, URLs, and management responses. C4 extends logger redaction for
the `vlt_` credential form and protects pairing-code values.

### Reason

This uses standard transport security and the repository's existing
domain-separated HMAC/logger conventions while keeping future API behavior
consistent with the privacy boundary.
