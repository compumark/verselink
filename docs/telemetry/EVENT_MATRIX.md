# VerseLink Telemetry — Event Matrix

Status: Reference / planning  
Created: 2026-09-21

## Source

The event catalogue below is derived from the current SC Bridge `sc-companion` parser documentation reviewed on 2026-09-21:

- `docs/parser-patterns.csv`
- `internal/logtailer/parser.go`
- `internal/events/bus.go`
- `DEVLOG.md`
- `TODO.md`

SC Bridge documents 57 implemented parser events and reports that all 57 fired at least once across a corpus of 180 Star Citizen logs from Jan–Mar 2026.

These are observed/parser-defined events, not an official CIG event API.

## Priority legend

- **P0** — required for first presence-capable telemetry core
- **P1** — valuable next-stage integration
- **P2** — future/optional
- **Local** — parse locally only unless a later use case justifies upload

## Session

| Event | Fields | Corpus hits | VerseLink use | Priority |
| --- | --- | ---: | --- | --- |
| `player_login` | handle, geid | 4599 | player/session identity | P0 |
| `server_joined` | shard | 279 | shard presence | P0 |
| `player_spawned` | — | 657 | active PU session signal | P0 |
| `entitlement_reconciliation` | details, status, phase | 210 | diagnostics | Local |

## Ships

| Event | Fields | Hits | VerseLink use | Priority |
| --- | --- | ---: | --- | --- |
| `ship_boarded` | ship, owner, raw | 330 | current ship / same ship | P0 |
| `ship_exited` | ship, owner, raw | 150 | clear current ship | P0 |
| `insurance_claim` | request_id | 752 | optional fleet history | P2 |
| `insurance_claim_complete` | result | 747 | optional claim state | P2 |
| `vehicle_impounded` | reason | 3 | activity history | P2 |
| `hangar_ready` | — | 372 | live hangar status | P1 |
| `ship_list_fetched` | count | 1403 | diagnostics only | Local |
| `ships_loaded` | count | 317 | diagnostics only | Local |
| `fatal_collision` | vehicle, zone | 2 | optional incident history | P2 |
| `low_fuel` | — | 6 | live crew alert | P1 |

## Missions

| Event | Fields | Hits | VerseLink use | Priority |
| --- | --- | ---: | --- | --- |
| `contract_accepted` | name | 570 | mission activity | P1 |
| `contract_completed` | name | 279 | mission history | P1 |
| `contract_failed` | name | 12 | mission history | P1 |
| `contract_available` | name | 90 | optional activity | P2 |
| `contract_shared` | name | 288 | group mission activity | P1 |
| `mission_ended` | mission_id, state | 297 | mission lifecycle | P1 |
| `end_mission` | mission_id, player, completion_type, reason | 343 | mission lifecycle detail | P1 |
| `new_objective` | name | 525 | active objective | P1 |
| `objective_complete` | description | 287 | objective progress | P1 |
| `objective_withdrawn` | description | 22 | optional mission history | P2 |

## Location

| Event | Fields | Hits | VerseLink use | Priority |
| --- | --- | ---: | --- | --- |
| `location_change` | player, location | 1260 | last observed location | P0 |
| `jurisdiction_entered` | jurisdiction | 660 | location context | P0 |
| `armistice_entered` | — | 774 | live zone state | P1 |
| `armistice_exited` | — | 635 | clear zone state | P1 |
| `armistice_exiting` | — | 9 | alternate exit signal | P1 |
| `monitored_space_entered` | — | 403 | security context | P1 |
| `monitored_space_exited` | — | 157 | security context | P1 |
| `monitored_space_down` | — | 3 | optional security context | P2 |
| `monitored_space_restored` | — | 3 | optional security context | P2 |
| `private_property_entered` | — | 34 | optional activity | P2 |
| `private_property_exited` | — | 27 | optional activity | P2 |
| `restricted_area_warning` | — | 18 | optional live warning | P2 |
| `restricted_area_exited` | — | 20 | clear warning | P2 |

Important: `location_change` is based on an observed location-inventory request. It is not continuous XYZ positioning. VerseLink should expose it as a **last observed location** with its own observation timestamp.

## Quantum Travel

| Event | Fields | Hits | VerseLink use | Priority |
| --- | --- | ---: | --- | --- |
| `qt_target_selected` | destination | 392 | intended destination | P0 |
| `qt_fuel_requested` | destination | 59 | stronger QT target signal | P0 |
| `qt_arrived` | — | 239 | travel completion signal | P0 |

`qt_arrived` contains no destination and must be correlated with prior QT state.

## Economy

| Event | Fields | Hits | VerseLink use | Priority |
| --- | --- | ---: | --- | --- |
| `money_sent` | recipient, amount, currency | 2 | optional group accounting | P2 |
| `fined` | amount, currency | 2 | optional activity | P2 |
| `transaction_complete` | — | 73 | insufficient context | Local |
| `rewards_earned` | count | 7 | optional progression | P2 |
| `refinery_complete` | location | 9 | Material/Mining workflow trigger | P1 |
| `blueprint_received` | name | 3 | Blueprint Inventory workflow trigger | P1 |

Economy information should not be uploaded by default.

## Combat & Health

| Event | Fields | Hits | VerseLink use | Priority |
| --- | --- | ---: | --- | --- |
| `injury` | severity, body_part, tier | 55 | future crew medical state | P2 |
| `incapacitated` | — | 4 | future rescue/presence state | P1/P2 |
| `actor_death` | actor, zone | 4 | optional incident history | P2 |
| `med_bed_heal` | actor, bed, vehicle, body-part flags | 21 | future medical feature | P2 |
| `crimestat_increased` | — | 8 | optional activity | P2 |
| `crime_committed` | crime | 13 | optional activity | P2 |
| `emergency_services` | — | 11 | future rescue context | P2 |
| `journal_entry_added` | entry | 10 | too generic initially | Local |

Medical/crime information requires explicit privacy review before any server sync.

## Party

| Event | Fields | Hits | VerseLink use | Priority |
| --- | --- | ---: | --- | --- |
| `party_member_joined` | player | 64 | current in-game party | P0 |
| `party_member_left` | player | 32 | current in-game party | P0 |
| `party_disbanded` | — | 2 | party reset | P0 |

The join/leave patterns are multi-line state-machine cases in the SC Bridge reference parser.

## First implementation allowlist

Milestone A should implement these 13 presence events first:

```text
player_login
server_joined
player_spawned
location_change
jurisdiction_entered
ship_boarded
ship_exited
qt_target_selected
qt_fuel_requested
qt_arrived
party_member_joined
party_member_left
party_disbanded
```

The following may be parsed early but are not required for the presence reducer:

```text
blueprint_received
refinery_complete
```

## Known future Game.log candidates

SC Bridge also documents currently unmatched/partially covered notification families including:

- Party subtypes
- Quantum Drive - Spooling
- Joined hangar queue
- Quantum Travel sub-states
- Ship Startup
- Exit Bed
- Quantum Travel - Calibration
- New Party Leader
- Friend Added
- Radar Ping
- Vehicle Retrieval
- Hunger & Thirst
- Stamina
- Chat
- Inventory

These are research candidates, not part of the initial contract.

## A2 fixture contract

A2 stores the implementation contract and sanitized input fixtures under
`telemetry/internal/gamelog` and `telemetry/testdata/events`. The fixtures are
minimal text examples derived from the approved event semantics; player names,
identifiers, and shard IDs are placeholders such as `TestPilot`,
`123456789`, and `pub_test_shard_001`. No real account data or large log
passages are included.

Each approved event has a positive fixture and at least one realistic negative
fixture. Expected output fields are stored in the machine-readable
`telemetry/testdata/events/expectations.json` catalogue. The fixture tests
validate the catalogue and file layout only; they deliberately do not parse
Game.log and do not contain production regexes.

Fixtures begin with sanitized RFC3339Nano timestamps in angle brackets, for
example `<2026-09-21T10:15:30.123Z>`. Later parser work should use a valid
line-start RFC3339/RFC3339Nano timestamp as the event timestamp. If the
timestamp is malformed or missing, the parser may still recognize the event,
but its timestamp must remain unset/zero; it must not invent the current system
time. A multi-line event uses the timestamp of the line that emits the final
event.

`party_member_joined` and `party_member_left` preserve ordered two-line input.
The first line creates pending state only; a valid continuation emits the final
event and clears pending state. An unrelated recognized event clears stale
pending state, and a continuation without a valid header must not emit a party
event. The A2 fixtures describe these cases but do not implement the state
machine.

Raw and normalized values are separate contract concerns. For ship events,
`raw` preserves the source text such as `@vehicle_NameRSI_Hermes : TestOwner`,
while later parser work is expected to normalize `ship` to `RSI_Hermes`.
`location_change` means last observed location, not continuous GPS or XYZ
coordinates. `qt_arrived` has no destination and must not infer one by itself.

`blueprint_received` and `refinery_complete` are reference-only future/P1
fixtures. They are not presence events and are not connected to Blueprint or
Material Inventory in A2.
