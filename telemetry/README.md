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

The current executable prints its identity and build defaults. A3 adds an
internal, read-only Windows `Game.log` locator for later callers. A4 adds an
internal, read-only live line tailer: it emits only newly appended complete raw
lines, buffers partial writes, and accepts an explicit path-change hook. It
does not parse lines, restore sessions, persist a path, or expose end-user
configuration/UI yet.

## Planned direction

Later milestones may add parsing, telemetry events and state reduction,
platform adapters, diagnostics, and a future VerseLink API client. None of
those features are part of A4.

The security boundary is explicit. VerseLink Telemetry will not use process
memory reading, DLL injection, kernel drivers, packet sniffing, keyboard hooks,
automated chat input, or modification of Star Citizen files. Its initial future
data source is `Game.log`, read-only.
