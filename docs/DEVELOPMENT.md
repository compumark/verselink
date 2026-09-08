# Entwicklung

## Umgebung

- Node.js 22+
- Docker Compose empfohlen
- PostgreSQL 16 über Compose oder kompatible Instanz
- Git

## Installation und Start

```powershell
Copy-Item .env.example .env
docker compose up -d --build
docker compose logs -f app
```

Ohne Docker müssen die PostgreSQL-Variablen gesetzt und Abhängigkeiten installiert werden:

```powershell
npm install
npm start
```

## Prüfungen

```powershell
node --check src/server.js
git diff --check
docker compose config --quiet
```

Das Projekt stellt ein Node-Testscript bereit. Browser-End-to-End-Tests fehlen noch und sollten als nächstes ergänzt werden.

```powershell
npm test
```

## Datenbank

Das Schema liegt als String in `src/server.js` und wird beim Start ausgeführt. Es gibt keine Seed-Daten und kein separates Migrationsverzeichnis. Schemaänderungen müssen deshalb besonders rückwärtskompatibel umgesetzt und dokumentiert werden.

## Typische Aufgaben

- UI/API ändern: zuerst die betreffende Route und die HTML-Funktion in `src/server.js` analysieren.
- Datenfeld ergänzen: Schema, INSERT/UPDATE, SELECT und UI gemeinsam prüfen.
- Berechtigung ändern: sowohl API- als auch UI-Zugriff testen; UI-Verbergen allein ist keine Autorisierung.
- Externe Synchronisierung ändern: Antwortformat, Fehler, Rate-Limits und Logging prüfen.

## Fehlerbehebung

App-Logs: `docker compose logs -f app`; Datenbank-Logs: `docker compose logs -f db`; Healthcheck: `/healthz`. Keine Secrets in Logausgaben oder Screenshots aufnehmen.

## Git-Workflow

1. `git status` und `git log` prüfen.
2. Kleine Änderung auf dem aktuellen Branch erstellen.
3. Syntax, Diff und relevante Laufzeit prüfen.
4. Dokumentation aktualisieren.
5. Diff auf Secrets prüfen.
6. Aussagekräftigen Commit erstellen.
7. Push nur nach ausdrücklicher Freigabe.

Empfohlenes Commitformat: kurzer imperativer englischer Satz, z. B. `Add group invite expiry validation`.
