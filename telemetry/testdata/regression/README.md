# Telemetry regression corpus

This corpus is synthetic, sanitized, small, and purpose-built. Never place a
personal or complete `Game.log` in this directory. Raw logs must remain outside
Git.

Each fixture should contain only the minimum complete lines required for its
regression scenario. Player handles, GEIDs, shards, and other identifiers must
be obvious placeholders such as `TestPilot`, `CrewMate`, `123456789`, or
`pub_test_shard_001`.

`manifest.json` is the source of expected event counts and is the only list of
files read by the corpus runner. New supported parser events require explicit
corpus coverage and review. The root `.gitignore` allowlists only the four
reviewed `.log` files; additional logs remain ignored by default.

Expected counts must be positive. A case that expects no events uses an empty
`expectedEventCounts` object; explicit zero-count entries are rejected as
ambiguous manifest noise.

The existing `testdata/events/` fixtures define minimal per-event contracts.
This directory complements them with realistic multi-line sequences used for
parser, restore, reducer, and diagnostics regressions.
