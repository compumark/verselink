# Telemetry Location Catalog

Issue #126 adds exact-key location resolution for private C8 history and the
Windows Live Monitor. This is global reference data, not user telemetry.

## Contract and trust rules

- `location_raw` remains the immutable telemetry key. Display resolution is a
  read-time projection; stored presence/history rows are not rewritten.
- Matching is byte-for-byte exact. There is no alias, fuzzy, substring, or
  hierarchy-based lookup in the runtime resolver.
- Only catalog rows marked `verified` with `match_type` `exact` or `manual` are
  included in the device bundle or used by Web History.
- A missing mapping displays the raw ID and `Unknown` for system, jurisdiction,
  and affiliation. A null/unknown field remains `Unknown`.
- Game system, parent, jurisdiction, and faction/affiliation are distinct.
  System, affiliation, raw ID, and a historic telemetry jurisdiction are never
  fallbacks for a confirmed jurisdiction.
- If a historical telemetry jurisdiction conflicts with the current verified
  mapping, the derived jurisdiction is `Unknown` and the resolution status is
  `conflict`.
- `location_change` clears the previous jurisdiction observation in the local
  reducer so a prior place's value is not carried into subsequent snapshots.
  Existing historic snapshots are left untouched.

## Data sources investigated

| Source | Fields observed | Contains internal `location_raw`? | Use and limits |
| --- | --- | --- | --- |
| Star Citizen Wiki API `/api/locations` | `uuid`, `slug`, `name`, `description`, `system`, `star`, `parent`, `type`, `jurisdiction`, `affiliation`, `updated_at`, `version` | No | Suggestion-only. `system`/`star` and place hierarchy can help an admin review, but a similar name is not proof of the Game.log key. Jurisdiction and affiliation may be null. API lists are paginated; the importer follows only same-origin/same-path next links, at most 5 pages, 1000 proposals, 2 MiB/page and 4 MiB total, with an 8-second deadline. Wiki import is disabled unless the operator explicitly enables `TELEMETRY_LOCATION_WIKI_IMPORT_ENABLED=1` after checking source terms; the API quickstart requests attribution and says commercial use is not permitted under the RSI Fandom FAQ. |
| Existing VerseLink UEX terminal integration `/2.0/terminals` | Existing code consumes `terminal_name`, `star_system_name`, `planet_name`, `space_station_name` / city/outpost names and availability fields | No verified raw Game.log key was found | Suggestion-only. UEX terminal names and hierarchy are not an exact telemetry key. The source endpoint could not be independently inspected during this implementation; its field mapping follows the existing VerseLink UEX consumer. Import requires the existing server-side `UEX_API_TOKEN`; no token is sent to browser/client. |
| Star Citizen game-data localization keys | Potentially exact internal-key to localized-name mapping | Not supplied/verified in repository | Not imported. No extracted dataset with provenance, version, or redistribution permission was available, so no key-to-name match is asserted. Admin may enter a key only when independently confirmed. |

Imports are idempotent proposal upserts keyed by `(source, external_id)` and
never write `telemetry_location_catalog`. They preserve admin-reviewed entries
because proposal storage is separate. Imports are bounded by timeout, response
bytes, and page count. The server continues serving the last approved DB
catalog if an external source is unavailable; catalog reads never call external
services.

## VerseLink APIs

- `GET /api/telemetry/v1/location-catalog`: existing C4 device Bearer auth,
  no event/presence payload, versioned schema-1 bundle, ETag/304, 24 requests per
  device per day. Only verified rows are returned; at most 4000 entries.
- `GET /api/admin/telemetry/location-catalog?q=...`: active admin session;
  global reference rows only, bounded to 500 results.
- `POST /api/admin/telemetry/location-catalog`: active admin plus exact
  configured VerseLink Origin; inserts/updates an exact manually reviewed key
  and increments the bundle version transactionally.
- `GET .../suggestions` and `POST .../import/{wiki|uex}`: admin-only proposal
  workflows; writes require same-origin protection. No user/device/history
  identifiers are read or returned.

The Windows client makes a separate catalog GET at startup and on a 12-hour
refresh schedule; it does not change heartbeat or presence schedules and sends
no telemetry state with this request. A local server-specific cache is
atomically written with restrictive permissions and expires after at most 24
hours. On network failure with a still-valid cache, cached verified mappings
remain usable; after expiry, the client falls back to raw ID plus Unknown
fields. Web history resolves in one indexed exact-key join per page, with no
HTTP calls per row.

## Admin workflow

Admins can search catalog entries across raw key/name/system/jurisdiction/
affiliation, edit fields, inspect provenance/status/update time, test an exact
raw-key preview, and explicitly mark a corrected entry verified. External
proposals have no raw key. Applying a proposal copies its descriptive fields
into an unverified draft; the admin must supply the independently confirmed
internal key and review it before it can resolve telemetry.
