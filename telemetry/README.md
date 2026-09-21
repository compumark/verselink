# VerseLink Telemetry

VerseLink Telemetry is the planned read-only telemetry companion for
VerseLink. This repository currently contains the Milestone A / A1 project
scaffold only. It proves that the future telemetry component can build and run
as an independent Go module.

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

The current executable prints its identity and build defaults. A1 does not
locate, read, tail, or parse `Game.log`, access Star Citizen, use the network,
connect to VerseLink, persist telemetry, or expose an HTTP API.

## Planned direction

Later milestones may add a read-only `Game.log` locator and tailer, parsing,
telemetry events and state reduction, platform adapters, diagnostics, and a
future VerseLink API client. None of those features are part of A1.

The security boundary is explicit. VerseLink Telemetry will not use process
memory reading, DLL injection, kernel drivers, packet sniffing, keyboard hooks,
automated chat input, or modification of Star Citizen files. Its initial future
data source is `Game.log`, read-only.
