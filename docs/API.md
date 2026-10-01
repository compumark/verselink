# API

## Basis

Die Anwendung stellt die JSON-/POST-API am gleichen Host wie das Webinterface bereit. Der SCMDB-Sink kann über den separaten Ingestion-Host weitergeleitet werden. Eine offiziell dokumentierte öffentliche API gibt es derzeit nicht; die Endpunkte sind interne Web-/App-Endpunkte.

## Öffentliche Blueprint-Suche (Phase 1)

Die öffentliche Suche verwendet einen separaten, gruppenbezogenen Share-Token. Sie benötigt keine Browser-Session, funktioniert aber ausschließlich mit einem gültigen, aktivierten und nicht abgelaufenen Link.

Management ist authentifiziert und nur für den jeweiligen Gruppen-Owner oder einen globalen App-Admin möglich:

| Methode | Pfad | Zweck |
|---|---|---|
| POST | `/api/public-links` | Share-Link erstellen; Klartext-Token wird einmalig zurückgegeben |
| GET | `/api/public-links?group_id=<UUID>` | Share-Link-Metadaten auflisten |
| POST | `/api/public-links/revoke` | Share-Link deaktivieren |
| GET | `/api/public/groups/<share-token>/blueprints` | öffentliche, schreibgeschützte Blueprint-Suche |

Der öffentliche Response enthält ausschließlich `tag`, `name`, `category`, `subcategory`, `manufacturer` und `image_url`. Materialien, Quellen, Besitzer, Mengen, Benutzer-IDs, Gruppen-IDs, Tokens, Sessions und Sync-Zeitpunkte werden nicht ausgegeben. Mehrere aktive Gruppenmitglieder mit demselben Tag ergeben genau einen Eintrag.

Suchparameter: `q`, `category`, `subcategory`, `manufacturer`, `page` und `page_size`. Die Seitengröße ist auf 50 begrenzt. Unbekannte, deaktivierte oder abgelaufene Tokens liefern 404; eine einfache In-Memory-IP-Begrenzung liefert bei Überlast 429.

## Authentifizierung

- Sink: Token im Pfad `/v1/scmdb/<token>`; der Server speichert nur den HMAC-Hash. Die öffentliche Basis wird ausschließlich pro Deployment durch `SCMDB_SINK_BASE_URL` konfiguriert; ohne gültige Variable können keine neuen SCMDB-Sinks erzeugt werden.
- Browser: `POST /session` mit Sink-Token erzeugt eine Session-Cookie.
- Nachfolgende API-Aufrufe verwenden die Session-Cookie.
- Admin-Rechte werden serverseitig über Benutzerstatus, Gruppenrolle und `is_admin` geprüft.
- Beim Löschen eines Benutzers wird der zugehörige Token-Hash gesperrt. Der Token kann danach weder eine neue Session erzeugen noch per Sink einen Benutzer erneut anlegen.
- Nutzer können einen eindeutigen VerseLink-Anzeigenamen setzen. SCMDB-Name, Token und Benutzeridentität bleiben dabei unverändert.

## Endpunkte

### Personal Inventory (Phase 1)

Alle folgenden Endpunkte benötigen die bestehende `bp_session`-Session und greifen ausschließlich auf das Inventar des eingeloggten App-Benutzers zu:

| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/api/personalinventory/catalog` | aktive Katalogeinträge; optional `search`, `category`, `manufacturer` |
| GET | `/api/personalinventory/locations` | aktive Inventory-Locations |
| GET | `/api/personalinventory` | eigenes Inventar mit Item- und Location-Metadaten |
| POST | `/api/personalinventory` | Katalog-Item hinzufügen; JSON `{item_id, location_id, quantity}`; gleiche Kombination erhöht die Menge |
| PATCH | `/api/personalinventory/:id` | eigene Menge ändern; `quantity: 0` entfernt den Eintrag |
| DELETE | `/api/personalinventory/:id` | eigenen Eintrag entfernen |
| POST | `/api/personalinventory/patch-reset` | eigenes Inventar atomar auf aktive Home-Location konsolidieren |
| POST | `/api/personalinventory/wipe` | eigenes Inventar atomar vollständig löschen |
| GET | `/api/personalinventory/events` | eigene Patch-Reset-/Full-Wipe-History, neueste zuerst |

| Methode | Pfad | Zweck | Berechtigung |
|---|---|---|---|
| GET | `/healthz` | App-/DB-Healthcheck | öffentlich |
| OPTIONS | `/v1/scmdb/<token>` | CORS-Preflight | öffentlich |
| POST | `/v1/scmdb/<token>` | SCMDB-Envelope ingestieren | gültiger Sink-Token |
| POST | `/session` | Browser-Session starten | registrierter Token |
| POST | `/logout` | Session löschen | eingeloggte Session |
| GET/POST | `/api/profile` | eigenes VerseLink-Profil lesen bzw. Name, RSI-URL, Discord-Name und Sichtbarkeit speichern | Session |
| POST | `/api/profile/rsi-sync` | öffentlich sichtbaren RSI-Avatar und Dossierdaten manuell aktualisieren | Session |
| GET | `/api/public-profiles/<UUID>` | öffentlich freigegebene Profildaten für die eingebettete mobiGlas-Ansicht | öffentlich, nur bei Freigabe |
| GET | `/profile/<UUID>` | öffentlich freigegebenes Profil anzeigen | öffentlich, nur bei Freigabe |
| POST | `/api/admin/tokens/cleanup` | unkonfigurierte Tokens älter als 24 Stunden entfernen | globaler App-Admin |
| GET | `/api/me` | aktuelles Profil | Session |
| GET | `/api/blueprints` | zugängliche Blueprints | Session |
| GET | `/api/groups` | eigene Gruppen | Session |
| POST | `/api/groups` | Gruppe erstellen | Session |
| POST | `/api/groups/rename` | Gruppe umbenennen | Owner |
| POST | `/api/groups/leave` | Gruppe verlassen | Member |
| POST | `/api/groups/delete` | Gruppe löschen | Owner |
| POST | `/api/groups/transfer-owner` | Owner übertragen | Owner |
| POST | `/api/groups/remove-member` | Mitglied entfernen | Owner/Admin |
| POST | `/api/invites` | Einladung erstellen | Owner/Admin |
| POST | `/api/invites/join` | Gruppe beitreten | Session + Code |
| POST | `/api/invites/revoke` | Einladung widerrufen | Owner/Admin |
| GET | `/api/groups/invites` | Einladungen anzeigen | Owner/Admin |
| POST | `/api/sync/materials` | Materialsynchronisierung starten | Owner/Admin |
| GET | `/api/admin/state` | Gruppen/Benutzer anzeigen | globaler Admin |
| POST | `/api/admin/groups/transfer-owner` | Owner durch Admin ändern | globaler Admin |
| POST | `/api/admin/users/status` | Benutzer sperren/deaktivieren | globaler Admin |
| POST | `/api/admin/users/delete` | Benutzer und abhängige Daten löschen | globaler Admin |
| GET | `/api/material-inventory/matrix?group_id=<UUID>` | Netto-Bestände der Gruppe je Material | Gruppenmitglied |
| GET | `/api/material-inventory/matrix/material/<CODE>?group_id=<UUID>` | Netto-Zeilen einer Materialkarte | Gruppenmitglied |
| POST | `/api/material-inventory/contributions` | Material zum Gruppenlager hinzufügen | Gruppenmitglied |
| POST | `/api/material-inventory/withdrawals` | Menge aus einer konkreten Spieler-/Qualitäts-/Warehouse-Zeile entnehmen | Gruppenmitglied |

### Telemetry pairing (C3)

Both routes accept JSON with a 4 KiB body limit and return machine-readable
telemetry errors as `{"error":"code"}`. Rate-limited responses use HTTP 429,
`{"error":"rate_limited"}`, and an integer `Retry-After` header.

| Method | Path | Authentication | Purpose / limit |
|---|---|---|---|
| POST | `/api/me/telemetry/pairing` | Active `bp_session` account | Create a one-time pairing code; 5 requests per account per hour. |
| POST | `/api/telemetry/pair` | No browser session required | Exchange a one-time code for a device ID and credential; 20 attempts per socket source IP per 15 minutes. |

Pairing creation accepts `{"schema":1}` and returns HTTP 201 with a grouped
code and UTC expiry. The code is valid for 10 minutes; a replacement
invalidates the previous unused code. Claim accepts
`{"schema":1,"code":"7K3M-9D2F-6R8W-1Q5C","device_name":"Gaming PC"}`;
`device_name` is optional and defaults to `Telemetry device`. A successful
HTTP 201 claim returns a device UUID, normalized name, and one-time
`vlt_` Bearer credential. Pairing codes and credentials are persisted only as
domain-separated HMAC-SHA256 hashes using `SINK_TOKEN_PEPPER`; plaintext is
never stored or logged. A successful claim consumes the code once and returns
the credential once. Reused/invalidated codes return `409 pairing_code_used`;
expired codes return `410 expired_pairing_code`.

### Telemetry device authentication (C4)

C4 device authentication is used by the implemented heartbeat and presence
routes. These require exactly one case-sensitive `Authorization: Bearer vlt_…` credential;
browser cookies, query/body credentials, and account or recovery tokens are
not substitutes. The server reuses C3's domain-separated device HMAC and
checks the current device revocation and account status in PostgreSQL on every
authentication attempt, without caching. Outcomes are `invalid_device_credential`
(401, with a Bearer challenge), `device_revoked` (401), `account_inactive`
(403), or a minimal internal device/owner context on success. C6 and C7 expose
the protected device routes; C8 exposes owner-scoped browser-session device
management and private history. Presence accepts only the explicit schema-1
current snapshot:

```http
PUT /api/telemetry/presence
Authorization: Bearer vlt_<device credential>
Content-Type: application/json

{"schema":1,"revision":42,"session_active":true,"shard":"pu-test-01","location":{"raw":"RR_CRU_L1","observed_at":"2026-09-24T12:00:00.123Z"},"jurisdiction":"Stanton","ship":{"name":"RSI_Hermes"},"quantum":{"destination":"LOC_CRU_L1","state":"target_selected"},"party_count":2,"last_event_at":"2026-09-24T12:00:02.456Z"}
```

The server validates the complete schema-1 DTO and stores only the approved
current-state allowlist. `shard` and `party_count` are validated but are not
persisted or included in revision equality checks. Newer revisions replace the
single per-device snapshot transactionally; exact duplicates are idempotent,
while stale revisions and same-revision conflicts return `409` with the current
revision. The full contract is in
[`telemetry/CONNECTION_CONTRACT.md`](telemetry/CONNECTION_CONTRACT.md).

### Telemetry heartbeat (C6)

`POST /api/telemetry/heartbeat` requires the device Bearer credential and
`{"schema":1}`. It updates only the authenticated device's server-side
`last_seen_at` and returns a server receipt timestamp; it does not change
presence or gameplay timestamps. The request-count limit is 120 per device per
minute. `429 rate_limited` includes `Retry-After`; database failures return
`503 server_unavailable` rather than being disguised as authentication errors.

### Telemetry private presence (C7)

`PUT /api/telemetry/presence` requires the device Bearer credential and the
allowlisted schema-1 snapshot above. The body limit is 16 KiB and the limit is
120 requests per device per minute. Accepted higher revisions atomically
advance the device high-water mark and upsert current presence. Equal identical
snapshots are idempotent; stale and conflicting revisions return `409` with
the current revision. `shard` and `party_count` are validated but discarded;
they are not stored or included in revision comparison. A successful accepted
snapshot may append its privacy-limited C8 history projection in the same
transaction. Device revocation deletes current presence and prevents later
heartbeat, presence, and history writes.

### Telemetry device management and private history (C8, implemented)

The signed-in user's MobiGlass profile calls only owner-scoped browser-session
routes:

| Method | Path | Purpose / limit |
|---|---|---|
| GET | `/api/me/telemetry/devices` | List own device summaries; 60 requests per user per minute. |
| PATCH | `/api/me/telemetry/devices/:id` | Rename an own device; 30 mutations per user per minute. |
| DELETE | `/api/me/telemetry/devices/:id` | Revoke an own device; 30 mutations per user per minute. |
| GET | `/api/me/telemetry/history?limit=50&cursor=…` | Read own private history; 50 default, 100 maximum per page; 60 requests per user per minute. |
| DELETE | `/api/me/telemetry/history` | Delete all of the caller's history without changing devices or current presence; 30 mutations per user per minute. |

Device summaries never include credential material or hashes. A device revoke
transaction marks only that owned device revoked and deletes its current
presence row; C4 rejects later device-authenticated requests. Existing history
is retained through the device's revocation for the remaining rolling
90-day period, but the device cannot write further entries. History is made
only from successfully accepted C7 snapshots, is private to the owning
account, and contains only location raw identifier, jurisdiction, ship name,
observed time, server received time, and source device/revision metadata.
Identical projection snapshots are deduplicated; pagination order is
deterministic. Missing location/ship remains unknown and missing observation
time is displayed as server-received time. Expired history is cleaned at
startup and daily. Account deactivation blocks access and writes but does not
reset retention; hard account deletion cascades remaining history immediately.
No crew/friend, public, or administrative history route is provided.

## Request-Beispiele

Session:

```http
POST /session
Content-Type: application/x-www-form-urlencoded

token=<SCMDB-SINK-TOKEN>
```

Blueprint-Abfrage:

```http
GET /api/blueprints
Cookie: session=<SESSION>
```

Einladung:

```http
POST /api/invites
Cookie: session=<SESSION>
Content-Type: application/x-www-form-urlencoded

group_id=<UUID>&reusable=1
```

## Antworten und Fehler

Erfolg liefert je nach Endpunkt JSON mit `ok`, Datenobjekten oder Listen. Typische Fehlerstatus:

- 400: ungültige Eingabe oder abgelaufener Code
- 401: keine gültige Session / nicht registrierter Token
- 403: fehlende Rolle oder gesperrter Benutzer
- 404: unbekannter Pfad
- 413: zu großer Sink-Body
- 500: interner Fehler

Allgemeine Anwendungsrouten haben kein einheitliches globales Rate-Limit;
Telemetry-Routen verwenden die oben dokumentierten endpoint-spezifischen
Limits. Request-Beispiele enthalten absichtlich keine echten Secrets.
## Trading

`GET /trading` ist für eingeloggte Benutzer verfügbar. Die Seite ruft intern `GET /api/trading/routes?system=stanton&ship=railen` auf. Die Route nutzt ausschließlich die serverseitige UEX-API-2.0-Anbindung; `UEX_API_TOKEN` wird als Umgebungsvariable gesetzt und nie an den Browser zurückgegeben. UEX-Preisdaten werden fünf Minuten im Speicher gecacht.
