# VerseLink Telemetry Connection Contract

Status: Proposed implementation contract (C1, in review)
Applies to: Milestone C (C2–C9)
Last updated: 2026-09-24

This document is the normative API, security, payload, privacy, and lifecycle
contract for the first VerseLink Telemetry connection. It describes future
behavior; it does not document implemented endpoints. If this contract changes,
update it and the related decisions before dependent implementation proceeds.

## 1. Scope and connection model

```text
VerseLink user
  -> existing authenticated browser session
  -> one-time pairing code (shown once)
  -> Windows Telemetry client
  -> one telemetry_devices row with its own revocable credential
  -> device-authenticated heartbeat and current-presence snapshot
  -> VerseLink / PostgreSQL
```

Each device belongs to exactly one `app_users.id`. A user may pair multiple
devices. Revoking one device affects only that device; it does not change the
VerseLink password, invalidate browser sessions, or revoke another device.
Device authentication never substitutes for browser authentication, and a
browser session never substitutes for device authentication.

The Phase-C data flow is:

```text
local TelemetryState -> allowlisted schema-1 presence DTO -> HTTPS -> latest
telemetry_presence row
```

The server does not parse Game.log and Phase C does not upload parser-event
streams. Receiving a private snapshot is not the same as sharing it with other
users. Phase D owns server-enforced, default-off field visibility and group
sharing rules. Pairing/connection authorizes the client to send the approved
snapshot to the account's private server-side presence record; it does not
enable peer visibility.

## 2. Credentials and pairing

### 2.1 Pairing code

The server generates exactly 10 cryptographically random bytes and encodes
their 80 bits as 16 Crockford Base32 characters, displayed as four groups of
four, for example `7K3M-9D2F-6R8W-1Q5C`. The alphabet is
`0123456789ABCDEFGHJKMNPQRSTVWXYZ` (32 symbols; excludes I, L, O, U). The
format has 80 bits of entropy, exceeds the approximately 50-bit baseline, and
is intended only for manual entry—not as a long-lived credential.

Normalization before lookup:

- ASCII letters are uppercased.
- ASCII hyphen-minus and ASCII whitespace (space, tab, CR, LF) are removed.
- Exactly 16 remaining characters from the stated alphabet are required.
- Crockford aliases such as O→0 or I/L→1 are not accepted; other punctuation,
  Unicode lookalikes, and invalid symbols are rejected.
- `canonical_code` is exactly the 16 normalized Crockford Base32 characters
  and contains no domain prefix. For example, `7K3M-9D2F-6R8W-1Q5C` normalizes
  to `7K3M9D2F6R8W1Q5C`. The HMAC domain prefix is applied exactly once in
  §2.3; separators and accepted whitespace therefore do not affect lookup.

There is at most one unconsumed, non-invalidated pairing-code record per
account (including an expired-but-not-yet-cleaned record). Creating a new code
atomically invalidates any previous unconsumed code for that account before
creating the new one. A code expires exactly 10 minutes after server creation
time. Successful claim atomically marks it consumed and creates its device in
the same database transaction. Expired, invalidated, or consumed codes can
never be revived. Concurrent claims can create at most one device. Cleanup
deletes expired/consumed/invalidated records 30 days after their respective
expiry/transition time; correctness must not depend on cleanup having run.

Only an HMAC representation is persisted (see §2.3). The plaintext code is
returned once by the authenticated code-creation endpoint and must not be
logged, placed in a URL, or returned by any later endpoint.

### 2.2 Device credential

On successful claim the server generates 32 random bytes using the operating
system CSPRNG and returns exactly:

```text
vlt_<43-character unpadded base64url encoding of those 32 bytes>
```

This is 256 bits of random secret material. The prefix `vlt_` is distinct from
the repository's `vl_` VerseLink account token and `vlr_` recovery token
formats. The credential is sent only in the successful claim response, then
only in `Authorization: Bearer …` over HTTPS. It must never be placed in a
URL, persisted in plaintext by the server, logged, or returned again by
device-list, rename, heartbeat, or presence responses. Device management
returns neither the credential nor its hash. Credential rotation is not part
of this contract; revoke and pair a new device instead.

The client stores the secret using the secure per-user store specified by C5
(Windows Credential Manager). It must not put the secret in `settings.json`.
Non-secret device ID/name and the presence revision may be stored separately.

### 2.3 Server-side secret representation and pepper

Use the existing stable deployment `SINK_TOKEN_PEPPER`; do not add another
environment secret for C1. Store lowercase hexadecimal HMAC-SHA256 outputs.
For pairing, `canonical_code` is only the normalized 16-character code; apply
the domain prefix exactly once as follows:

```text
HMAC-SHA256(SINK_TOKEN_PEPPER, "verselink-telemetry-pairing:" + canonical_code)
HMAC-SHA256(pepper, "verselink-telemetry-device:" + full_credential)
```

The different domain prefixes prevent cross-purpose representation reuse and
follow the existing repository pattern (`verselink-auth:`, `session:`, and
`public-link:`). `SINK_TOKEN_PEPPER` is already required at server startup and
is stable deployment configuration; changing it invalidates existing HMAC
representations, so normal secret-rotation policy applies. Raw pairing codes
and device credentials are not stored. A unique index is required for device
credential hashes; pairing HMACs are also unique. Authentication computes the
HMAC from the supplied credential and performs indexed lookup; any
application-side secret comparison must use a constant-time comparison.
If a newly generated credential or pairing code collides with an existing
unique HMAC, discard it and generate a fresh secret before returning anything;
never attach the existing row or reveal the collision to the caller.

## 3. Authentication and account lifecycle

### 3.1 Authentication separation

Device routes require exactly one credential in:

```http
Authorization: Bearer vlt_…
```

The scheme and credential format are case-sensitive as shown. A missing,
malformed, unknown, or invalid credential returns `401 invalid_device_credential`
and a Bearer `WWW-Authenticate` challenge. Do not accept `bp_session`, another
cookie, account password/token, SCMDB token, query parameter, or request-body
credential on device routes. Do not accept a telemetry credential as a browser
session on `/api/me/...` or any other browser-authenticated route.

After resolving the HMAC to a device, every protected request checks both
`revoked_at IS NULL` and the current owning account status. An authentication
decision for a request that begins after the revocation/deactivation
transaction commits must reject it; an already in-flight request may finish.

### 3.2 Status behavior

| Condition | HTTP | Error |
| --- | ---: | --- |
| Missing/malformed/unknown device credential | 401 | `invalid_device_credential` |
| Known credential whose device is revoked | 401 | `device_revoked` |
| Known device whose `account_status` is not `active` (`blocked` or soft-deleted) | 403 | `account_inactive` |
| Browser route with no valid active browser session | 401 | Existing browser API behavior; telemetry mutations use the stable envelope below |
| Device credential presented to browser route | 401 | Existing browser unauthenticated behavior |
| Browser cookie presented without device bearer on device route | 401 | `invalid_device_credential` |

The account-status check is server-side and repeated for device requests. Any
`account_status` other than `active` (including `blocked` and `deleted` before
hard deletion) rejects device authentication and new pairing-code creation.
Changing an account to a non-active status invalidates its outstanding pairing
codes and transactionally deletes all `telemetry_presence` rows for its devices.
Claiming one of those invalidated codes returns
`409 pairing_code_used`, without disclosing the account status. A temporary
block does **not** set `revoked_at` or delete the device row, credential HMAC,
or its `last_presence_revision`.
When the account returns to `active`, a device not explicitly revoked may
authenticate again; an explicitly revoked device remains permanently revoked
and requires a new pairing. Hard account deletion cascades/removes device,
pairing, and presence records, including credential lookup material, so no
device credential survives as independently usable.

## 4. HTTP API contract

All paths are under the existing VerseLink API host. JSON requests use
`Content-Type: application/json`. Browser-authenticated mutations retain the
application's same-origin/CSRF protections; they do not enable permissive
cross-origin credentialed requests. Every API below is a future contract, not
an implemented route. Control/management JSON request bodies are capped at
4 KiB; presence is capped separately at 16 KiB.

The canonical safe device summary used by list and rename responses is:

```json
{"id":"uuid","name":"Gaming PC","created_at":"2026-09-24T12:00:00Z","last_seen_at":null,"revoked_at":null,"online":false}
```

`id` is a server UUID; timestamps are RFC3339 UTC strings or `null` as shown;
`online` is the server-derived heartbeat-TTL value and is always false for a
revoked device. This object never contains an account ID, credential,
credential hash, or gameplay field.

### 4.1 Browser-authenticated routes

| Method and path | Auth | Request | Success response | Main errors | Initial limit | Secret behavior |
| --- | --- | --- | --- | --- | --- | --- |
| `POST /api/me/telemetry/pairing` | Active `bp_session` and `account_status=active` only | `{"schema":1}` | `201 {"schema":1,"code":"…","expires_at":"…"}` | 401, `account_inactive` 403, `unsupported_schema` 400, `rate_limited` 429, `server_unavailable` 503 | 5 creations per `app_user_id` per hour | The newly generated one-time pairing code is returned once; no credential is returned here. |
| `GET /api/me/telemetry/devices` | Active `bp_session` only | None | `200 {"schema":1,"devices":[<device summary>,…]}` | 401, 429, 503 | 60 requests per user per minute | Never returns credential or hash. Only own devices. `online` derives from heartbeat TTL. |
| `PATCH /api/me/telemetry/devices/:id` | Active `bp_session` only | `{"schema":1,"name":"Gaming PC"}` | `200 {"schema":1,"device":<device summary>}` | 400 `invalid_payload`/`unsupported_schema`, 401, 404 `not_found` (not found or not owned), 429, 503 | 30 mutations per user per minute | Name only; no credential/hash. |
| `DELETE /api/me/telemetry/devices/:id` | Active `bp_session` only | None | `204` after marking revoked; repeat revoke is idempotent `204` | 401, 404 (not found or not owned), 429, 503 | 30 mutations per user per minute | Revokes only the addressed device; no secret is accepted or returned. |

Device names are optional at claim and default to `Telemetry device`; if
provided or later renamed they are trimmed using Unicode White_Space rules,
non-empty, and limited to 64 Unicode code points after trimming. Invalid
Unicode (including unpaired surrogates) or empty/overlong names are
`invalid_payload`. List and mutation responses include only the device UUID,
name, creation/last-seen
timestamps, revoked state, and derived online status. They do not expose
`app_user_id`, credential material, client filesystem data, or gameplay data.
An ID belonging to another account is indistinguishable from an unknown ID
(`404`) to prevent device-existence disclosure.

### 4.2 Pairing claim

`POST /api/telemetry/pair` is unauthenticated by browser session. It accepts
only the one-time code and an optional user-selected device name:

```json
{"schema":1,"code":"7K3M-9D2F-6R8W-1Q5C","device_name":"Gaming PC"}
```

Success is `201`:

```json
{"schema":1,"device_id":"uuid","device_name":"Gaming PC","device_credential":"vlt_…","token_type":"Bearer","created_at":"2026-09-24T12:00:00Z"}
```

`device_id` is the new server UUID. The successful response also includes
`device_name` (the trimmed submitted name or `Telemetry device` when omitted)
so the client can display the paired identity without another request.

The response is the sole plaintext delivery of this device credential. The
claim endpoint is limited to 20 attempts per source IP per 15 minutes. Pairing
codes have enough entropy that this limit supports ordinary retry/typing
correction while preventing practical online guessing. Do not trust
`X-Forwarded-For` unless the immediate peer is a configured trusted proxy.

Malformed JSON or an invalid device name returns `400 invalid_payload`; an
unsupported schema returns `400 unsupported_schema`. The limiter returns
`429 rate_limited` with `Retry-After`; a temporary transactional/dependency
failure returns `503 server_unavailable`. Failed claims never disclose an
account or device owner.

Pairing-code responses distinguish `400 invalid_pairing_code` (malformed or
unknown code), `410 expired_pairing_code`, and `409 pairing_code_used` (already
consumed or invalidated by issuing a replacement). Precedence is deterministic:
malformed/unknown is 400; for a known record, consumed or invalidated is 409;
otherwise an expired code is 410; only then may a live code be claimed. This
distinction is useful
for the one-time UX and does not create a practical enumeration oracle for an
80-bit code under the claim rate limit; none of these responses identifies an
account or device. A concurrent losing claim returns `409 pairing_code_used`.
The code is consumed only in the same transaction that successfully creates
the device. A transactional/server failure rolls back consumption, while the
client may safely retry before expiry.

### 4.3 Device-authenticated routes

| Method and path | Auth | Request | Success response | Main errors | Initial limit | Secret behavior |
| --- | --- | --- | --- | --- | --- | --- |
| `POST /api/telemetry/heartbeat` | Device Bearer only | `{"schema":1}` | `200 {"schema":1,"ok":true,"received_at":"…"}` | 400 unsupported schema, 401 invalid/revoked credential, 403 inactive account, 429, 503 | 120 per device per minute | Credential only in Authorization header; never echoed. |
| `PUT /api/telemetry/presence` | Device Bearer only | Schema-1 snapshot in §5 | Newer: `200 {"schema":1,"accepted":true,"revision":42,"received_at":"…"}`; exact duplicate: `200 {"schema":1,"accepted":false,"revision":42}`; lower revision: `409 stale_revision`; same revision/different snapshot: `409 revision_conflict` (both include current revision) | 400 `unsupported_schema`/`invalid_payload`, 401 invalid/revoked credential, 403 inactive account, 413 `payload_too_large`, 429, 503 | 120 per device per minute; max body 16 KiB | Credential only in Authorization header; body has no secret. |

All listed limits count requests/attempts, not only failures: successful
pairing-code creation, every pairing claim attempt, and successful as well as
failed heartbeat/presence requests each consume a unit in their respective
bucket. Initial enforcement is per process and bounded in memory. The existing
`createRateLimiter` helper currently tracks `recordFailure()` counts; C3/C6/C7
must not use that failure-only behavior unchanged for request-count limits.
They may extend the existing bounded in-memory limiter with request-count
semantics where appropriate or add a small repository-consistent bounded
in-memory request limiter. Limits remain best-effort across multiple server
replicas and process resets; they are not a substitute for pairing-code
entropy, atomic single-use database operations, request-size limits, or
authentication. Phase C does not require distributed/global enforcement. A
future shared limiter may strengthen enforcement without changing API
semantics. IP keys use the socket peer unless a trusted-proxy policy explicitly
establishes the client address.

## 5. Schema-1 current presence DTO

This is a network DTO, not a JSON serialization of the Go `TelemetryState`.
Names, types, nullability, and allowed values below are independent of Go
struct layout. C7 maps the local reduced state explicitly into this allowlist.

```json
{
  "schema": 1,
  "revision": 42,
  "session_active": true,
  "shard": "pu-test-01",
  "location": {"raw":"RR_CRU_L1","observed_at":"2026-09-24T12:00:00.123Z"},
  "jurisdiction": "Stanton",
  "ship": {"name":"RSI_Hermes"},
  "quantum": {"destination":"LOC_CRU_L1","state":"target_selected"},
  "party_count": 2,
  "last_event_at": "2026-09-24T12:00:02.456Z"
}
```

All keys shown are required in schema 1. Fields whose values may be unknown
must be explicitly `null`, not omitted. Constraints:

| Field | Type and constraints |
| --- | --- |
| `schema` | Required integer exactly `1`. |
| `revision` | Required positive JSON integer from 1 through 9,007,199,254,740,991 (`Number.MAX_SAFE_INTEGER`); monotonically increases per device for each newly generated snapshot. Persist as BIGINT. |
| `session_active` | Required boolean or `null`. Before a usable structured diagnostics/session snapshot exists it is `null`; once available it is exactly `TelemetryState.SessionActive`. `false` means the structured reducer state is not session-active, not that the device is offline. The key may not be omitted. |
| `shard` | Required string or `null`; at most 128 UTF-8 bytes. |
| `location` | Required object or `null`. If object: required `raw` string (1–256 UTF-8 bytes) and `observed_at` RFC3339Nano timestamp. |
| `jurisdiction` | Required string or `null`; at most 128 UTF-8 bytes. |
| `ship` | Required object or `null`. If object: required `name` string (1–128 UTF-8 bytes). `null` means ship is unknown/not currently represented; it must not be interpreted as explicit on-foot state. |
| `quantum` | Required object or `null`. If object: required `destination` string or `null` (max 256 UTF-8 bytes), and required `state` enum `target_selected`, `fuel_requested`, or `arrived`. |
| `party_count` | Required integer from 0 through 100 or `null`. Before a usable structured diagnostics/session snapshot exists it is `null`; once available it is exactly `len(TelemetryState.Party)`. `0` means the locally reconstructed set currently contains zero members. The key may not be omitted. |
| `last_event_at` | Required RFC3339Nano timestamp or `null`; this is the source-derived local last-event time. |

Timestamps must be valid RFC3339/RFC3339Nano with an explicit UTC offset; no
server receipt or heartbeat time may be substituted for a source observation
timestamp. C7 validates types, required keys, ranges, UTF-8 byte bounds, and
timestamp syntax before persistence. The entire presence body is capped at
16 KiB. Unknown JSON object members are ignored for forward-compatible
additive evolution, but all schema-1 required fields must be present and
valid. If the runtime does not yet have a usable structured diagnostics/session
snapshot, C7 sends `null` for both fields; it does not infer or add
`SessionKnown`/`PartyKnown` flags to the Go reducer in C1. Once a structured
snapshot is available, C7 maps `SessionActive` and the length of `Party`
directly, including `false` and `0`. `party_count` is the count of the locally
reconstructed Party member set, not a guarantee that Star Citizen's complete
current Party membership has been observed; parser/reconstruction compatibility
work remains separate. Party identities remain local-only. Phase D may revisit
Party semantics. New optional fields may be added only with a documented default/absence
meaning that does not change existing field semantics. Removing/renaming a
field, changing a type/nullability/meaning, or making an optional field
required is breaking and requires a new integer schema version. An unknown or
unsupported schema receives `400 unsupported_schema`; it is never silently
interpreted as schema 1.

No `player_handle` is uploaded initially: the paired device already belongs to
an `app_user_id`, and no C1/C7 need justifies sharing a second gameplay
identity. Client/build metadata is also omitted until an operational need and
collection rationale are approved.

The allowlist explicitly excludes player handle; ship owner; Party names/IDs;
GEIDs; Game.log path; discovery strategy; local diagnostics counters; raw
parser event data; raw log lines; settings; filesystem details; credentials;
and browser/session tokens. Party count is the only Party field. No Party
fingerprint or same-party inference is part of Phase C. Ship owner is not
uploaded. The schema has no on-foot enum; `ship: null` remains unknown/not
represented, and a later explicit unknown/aboard/on-foot field can be added as
an optional schema-1 field only if it does not reinterpret existing null, or
introduced in schema 2 if semantics require a breaking clarification. C1
does not depend on #96.

## 6. Ordering, retries, and idempotency

The client maintains a per-device `revision` counter. Before sending a newly
created presence snapshot it atomically increments the counter and durably
persists that value locally; it must not send a snapshot until that persistence
succeeds. Only one process may write for a given device at a time: C5 acquires
an exclusive OS file lock on the per-device revision-state file before
enabling network sync and releases it at shutdown (the OS releases it after an
unexpected process exit); another process using the same local device identity
must remain unsynced until it acquires the lock. This prevents two processes
from allocating the same revision. Skipped numbers after a crash are valid.
Retries of the same snapshot use the same revision and identical body. A
changed snapshot always receives a new revision. The counter is non-secret
metadata and survives ordinary client restart; C5 stores it separately from
the credential.

C2 stores `last_presence_revision` on the device row (initially zero), so
ordering survives deletion/rebuild of the current-presence row. C7 must
atomically compare/update that value and upsert the current snapshot in one
transaction:

- `incoming revision > last_presence_revision`: accept and replace the latest
  state, update the device revision, set server `received_at` to receipt time.
- `incoming revision == last_presence_revision` and the validated DTO is
  semantically identical to the stored snapshot: treat as an idempotent
  duplicate; do not rewrite payload or refresh `received_at`; return 200 with
  `accepted:false` and the current revision. JSON key order/whitespace and
  ignored unknown members do not affect semantic comparison.
- `incoming revision == last_presence_revision` but the DTO differs: do not
  change state or `received_at`; return `409 revision_conflict` with the
  current revision. The client must persist `current_revision` and retry its
  latest snapshot at current+1; never retry the conflicting body at the same
  revision.
- `incoming revision < last_presence_revision`: treat as stale; do not change
  state or `received_at`; return 409 `stale_revision` with the current
  revision, so a client restored from an older settings backup can reconcile.

The server never orders snapshots by Game.log timestamps or request arrival
alone. A sequential new process/runtime uses the same durably stored per-device
counter and continues above the server high-water mark; it does not reset the
counter or introduce a new runtime identity. Therefore an old delayed request
from the previous runtime remains lower than an accepted new-runtime snapshot
and is rejected. A restored older local settings backup may have a counter
below the server value: the 409 response includes `current_revision` but no
current presence payload; the client persists that value and retries its
current snapshot at current+1. The server rejects non-positive, non-integer,
or out-of-range revisions as `invalid_payload`. The safe-integer ceiling keeps
the JSON number exact through the existing JavaScript server parser while
leaving ample counter space. If the counter reaches 9,007,199,254,740,991, the
client must pair a new device rather than wrap. This
mechanism handles duplicate delivery, delayed retries, and sequential client
process restart while remaining implementable without a server-issued
session/epoch protocol.

## 7. Heartbeat and online state

The paired client sends a heartbeat every 30 seconds while connected and
running, with a bounded request timeout and retry/backoff owned by C6. A
successful authenticated heartbeat sets `telemetry_devices.last_seen_at` to
the server's receipt time. The device is online while
`last_seen_at >= server_now - 90 seconds`; otherwise it is offline. A newly
paired device with no successful heartbeat is offline. Online is connection
health, independent of `session_active`.

Temporary network loss does not end a gameplay session or clear the latest
presence row. C5/C6 use a 10-second per-request timeout for pairing, heartbeat,
and presence calls. Network failures, timeouts, and 5xx responses are
transient: retry with exponential backoff starting at 1 second, capped at 60
seconds, with full jitter; a supplied `Retry-After` takes precedence, bounded
to 1–300 seconds. A 429 is retried no earlier than `Retry-After`. Do not
automatically retry other 4xx responses. Any 401/403 on a device-authenticated
call stops authenticated retries and exposes the authentication-failed or
device-revoked state; the user must re-pair or resolve account status. Pairing
claim may be manually retried after a transient failure while its code remains
valid. Cancellation/shutdown cancels in-flight requests and scheduled retries.
This policy must not create an unbounded fast loop. Heartbeat receipt time is
never copied into `location.observed_at`, `last_event_at`, QT observation
times, or any other gameplay-derived time. Heartbeat updates device connection
metadata only. Accepted presence has its own server `received_at`, distinct
from all source timestamps.

## 8. Endpoint error contract

Telemetry API errors use this stable JSON envelope and do not include stack
traces or raw input:

```json
{"error":"invalid_payload"}
```

Do not require a free-form message; clients map machine codes to localized
text. For every 429 response include `Retry-After` as a non-negative integer
number of seconds until the relevant limiter window resets. Never include a
secret, hash, account identifier, or payload value in an error response. The
only safe additional error metadata is `current_revision` for
`stale_revision` and `revision_conflict`.

| Code | HTTP | Meaning |
| --- | ---: | --- |
| `invalid_pairing_code` | 400 | Malformed or unknown normalized pairing code. |
| `expired_pairing_code` | 410 | Known code past its server expiry. |
| `pairing_code_used` | 409 | Code already claimed or invalidated by replacement. |
| `invalid_device_credential` | 401 | Missing, malformed, or unknown Bearer credential. |
| `device_revoked` | 401 | Credential maps to a revoked device. |
| `account_inactive` | 403 | Owning account is disabled/inactive. |
| `unsupported_schema` | 400 | Schema version is unknown or unsupported. |
| `invalid_payload` | 400 | Invalid JSON, missing/invalid fields, or invalid values. |
| `stale_revision` | 409 | Client must reconcile its revision with server metadata. |
| `revision_conflict` | 409 | Revision was already used for a different snapshot; client must reconcile and send latest state at a higher revision. |
| `not_found` | 404 | Device does not exist or is not owned by the authenticated account. |
| `payload_too_large` | 413 | Request exceeds its endpoint body limit. |
| `rate_limited` | 429 | Request limit reached; includes `Retry-After`. |
| `server_unavailable` | 503 | Temporary server/dependency unavailability; client may retry with backoff. |

Do not reveal whether an account, device belonging to another account, or
credential hash exists. Pair-code invalid/expired/used are distinguished only
because the claimant already possesses a high-entropy one-time secret and the
claim limiter bounds guesses; none returns ownership information.

## 9. Persistence ownership and retention

| Record | Owner and key | Required responsibilities | Lifecycle/cleanup |
| --- | --- | --- | --- |
| `telemetry_devices` | C2; server-generated UUID primary key; FK `app_user_id` to `app_users`; unique credential HMAC | Device name; credential HMAC only; `created_at`; `last_seen_at` server receipt time; `revoked_at`; `last_presence_revision` (BIGINT, default 0); only explicitly approved optional metadata. | Explicit revocation is retained as a tombstone while the account exists. A temporary non-active account status does not revoke/delete this device or its HMAC; auth is suspended until reactivation. Hard account deletion removes the row/lookup material and dependent data. Multiple device rows per account are supported; no credential is shared between devices. |
| `telemetry_pairing_codes` | C2; server-generated UUID primary key; FK owner to `app_users`; unique code HMAC | HMAC only; `created_at`, `expires_at`, `consumed_at`, and `invalidated_at`. | C3 atomically consumes once. A new code invalidates the prior unconsumed/non-invalidated code for that account. Expired, consumed, or invalidated rows are cleaned 30 days after expiry/transition; they can never become valid again. Account deactivation invalidates open codes; deletion cascades/removes them. |
| `telemetry_presence` | C7; one current row keyed by `device_id` FK to `telemetry_devices` | Exact schema-1 allowlist, latest `revision`, and server `received_at`; owner is derived through device, not duplicated. | Upsert only when revision advances. No historical snapshots/event stream. Delete rows transactionally when the owning account becomes non-active and on explicit device revocation; cascade on hard account/device deletion. Never retain raw logs. |
| `telemetry_events` | Not part of Phase-C MVP; no C1/C2-C8 table or ingestion route | None. | Historical/event ingestion may be reconsidered in a future phase only with a concrete approved requirement and privacy/retention design. |

Schema initialization follows the repository's repeat-safe startup-schema
convention; C2 must not add a repository-wide migration framework. Required
uniqueness: device credential HMAC; pairing code HMAC; at most one
unconsumed/non-invalidated pairing-code record per account; one presence row
per device.
Indexes must support credential lookup, account device listing, pairing
expiry/cleanup, and presence-by-device. Do not persist client IP addresses.

Any account status other than `active` immediately blocks device auth and code
creation, invalidates outstanding pairing codes, and transactionally deletes
all of that account's `telemetry_presence` rows. Blocking does not set device
`revoked_at`; device rows, credential HMACs, and each device's
`last_presence_revision` remain. Reactivation permits
non-revoked devices to authenticate again. Hard account deletion cascades
device, pairing, and presence records in the same transaction; no credential
lookup material survives independently. Explicit device revocation remains
permanent regardless of later account reactivation.

## 10. Revocation and disconnect

Remote revocation is a server-side transition setting `revoked_at`; the server
checks it on every authenticated request. Once committed, all subsequent
heartbeat/presence requests fail with `401 device_revoked`. A revoked
credential cannot reactivate itself. Revoking one device leaves other devices
and browser sessions unchanged. C5/C6 must surface a clear **Device revoked**
connection state and stop retrying authenticated requests until the user pairs
again.

Local Disconnect in C5 means deleting the local credential and returning the
client to Not connected; by itself it does not revoke the server record. The
UI must say this clearly and offer/point to remote revocation separately.
Conversely, remote revocation does not remotely uninstall or terminate the
local application. Device cleanup/removal never returns or regenerates the old
secret.

## 11. Privacy boundary

| Local only (never upload in Phase C) | May be sent to VerseLink private device/presence APIs | Not shared to other users until Phase D explicitly opts in |
| --- | --- | --- |
| Raw Game.log lines and raw parser event maps | `schema`, `revision`, `session_active` | All server-held current presence starts private to the account; no peer/group read endpoint is part of Phase C. |
| GEIDs and Party member names/IDs | `shard` | Phase D must enforce account opt-in server-side, field-level preferences, and authorization for each viewer. |
| Game.log path, discovery strategy, local settings/filesystem information | `location.raw`, `location.observed_at`, `jurisdiction` | Pairing or successful ingestion alone never makes presence visible to another user. |
| Parser/line counters and local diagnostics | `ship.name`, `quantum.destination`, `quantum.state`, `party_count`, `last_event_at` | Visibility defaults off. Receiving data is not sharing it. |
| `player_handle`, ship owner, client IP | Server-generated device ID for authentication context only; server-generated `received_at` and heartbeat `last_seen_at` are persistence metadata, not gameplay payload fields | Phase D defines independently controllable sharing for online state, shard, location, ship, QT, and Party count. |
| Device credential, pairing code, HMAC/hash, browser cookie, password, account/recovery token | No credential or pairing secret appears in presence payloads. Pairing code/device credential appear only in their one-time protocol responses. | No raw log, GEID, Party identity, player handle, or ship owner becomes shareable through C1. |

`player_handle` is deliberately excluded: account ownership is already known
from the device relation, and C1 has no approved use for a second identity.
Ship owner and Party identities are excluded. Party count alone is permitted.
The server must validate the allowlist and must not accept/persist arbitrary
client fields just because JSON contains them.

## 12. Logging and transport

Never log or echo:

- `Authorization` header or `vlt_` credential;
- raw pairing code or its HMAC;
- device credential HMAC;
- browser cookie/session value, VerseLink password/account token, or recovery
  token;
- raw Game.log line or raw parser event data.

Safe structured log metadata may include request ID, route, device UUID,
`app_user_id` only where consistent with current logger policy, error
category, HTTP status, and duration. Never put credentials/codes in URLs or
request log bodies. C4 must extend/review `src/logger.js` redaction for the
`vlt_` token value shape and secret field names before device auth ships; it
must also ensure pairing code values are not emitted even when embedded in an
error/message. Existing key-name redaction is defense in depth, not permission
to log a secret.

Production client/server communication requires HTTPS with ordinary platform
TLS certificate and hostname validation. Do not add certificate pinning or
custom cryptography. A redirect must not downgrade credential-bearing
requests to HTTP or another origin. Explicit development localhost/DEV
configuration may use HTTP only where the existing development environment
requires it; production configuration rejects non-HTTPS base URLs.

## 13. Ownership by implementation issue

- **C2 (#88):** repeat-safe device/pairing schema, constraints/indexes,
  `last_presence_revision`, ownership/account-delete behavior.
- **C3 (#89):** authenticated code creation, normalization/HMAC, replacement
  invalidation, atomic one-time claim, device credential generation/one-time
  response, claim errors and rate limits.
- **C4 (#90):** dedicated Bearer middleware, account/revocation checks,
  browser/device separation, immediate revocation, logger redaction updates.
- **C5 (#91):** pairing UI, HTTPS API client, secure Windows credential storage,
  durable per-device revision counter, explicit local Disconnect semantics.
- **C6 (#92):** 30-second heartbeat, timeout/backoff, `last_seen_at`, 90-second
  online TTL, connection-state reporting and rate limit.
- **C7 (#93):** explicit DTO mapping/validation, null mapping until a usable
  structured snapshot exists, locally reconstructed Party count semantics,
  16 KiB cap, atomic revision ordering/idempotency, latest presence upsert,
  timestamps/privacy checks.
- **C8 (#94):** own-device list/rename/revoke UI and APIs; no credential
  material in management responses.
- **C9 (#95):** contract-level end-to-end and failure/privacy verification.

No endpoint, table, Windows networking code, or environment variable is
implemented by C1. The old `/api/telemetry/events`,
`/api/telemetry/status`, and `telemetry_events` proposal is superseded for
Phase C by the routes and current-snapshot model above; event history requires
a separately approved future-phase design.
