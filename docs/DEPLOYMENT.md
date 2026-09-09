# Deployment

## Dienste

`docker-compose.yml` startet:

- `verselink-app`: selbst gebautes Node.js-Image, Port 3000
- `verselink-db`: `postgres:16-alpine`, intern Port 5432

Der App-Service wartet auf den PostgreSQL-Healthcheck.

## Build und Compose

```powershell
docker compose build
docker compose up -d
docker compose ps
docker compose logs -f app
```

## Portainer

Stack über das GitHub-Repository anlegen, Branch `main` und Compose-Datei `docker-compose.yml` wählen. Für bestehende Synology-Bind-Mount-Installationen zusätzlich `docker-compose.bind.yml` als Override verwenden. Die vollständige Anleitung steht in [PORTAINER.md](PORTAINER.md).

## Variablen

Pflicht: `POSTGRES_PASSWORD`, `SINK_TOKEN_PEPPER`. Optional: `APP_ADMIN_USER_IDS`, `DISCORD_WEBHOOK_URL`, `DATABASE_URL` und PostgreSQL-Verbindungswerte. `APP_ADMIN_USER_IDS` ist eine kommagetrennte Liste unveränderlicher `app_users.id`-UUIDs; eine leere oder fehlende Liste vergibt keine Adminrechte.

`SCMDB_SINK_BASE_URL` ist erforderlich, wenn SCMDB-Synchronisierung verwendet werden soll. Der Wert muss als öffentlich erreichbare `http://`- oder `https://`-Ingest-Basis beim Deployment gesetzt werden, beispielsweise `https://verselink.example.org/v1/scmdb`. Es gibt keinen Default und keinen Production-Fallback. Fehlt der Wert oder ist er ungültig, startet VerseLink weiterhin, aber das Erstellen neuer SCMDB-Sinks ist deaktiviert. Für Self-Hosting muss die eigene URL gesetzt werden; Reverse Proxy, TLS und öffentliche Erreichbarkeit müssen SCMDB den Zugriff auf diesen Endpoint erlauben. Geheimnisse nur im Portainer-Environment oder einer nicht versionierten `.env`.

## Netzwerk, Ports und Storage

App: NAS-intern und Reverse-Proxy-Ziel `3000`. DB: nur Compose-intern `5432`. Persistenter Mount:

```text
verselink-postgres:/var/lib/postgresql/data
```

Die portable Standardinstallation verwendet die Named Volumes `verselink-postgres` und `verselink-logs`. Bestehende Synology-Stacks verwenden den Override `docker-compose.bind.yml` und setzen ausschließlich `POSTGRES_DATA_PATH` sowie `APP_LOG_PATH` auf die bereits vorhandenen Hostpfade.

Öffentliche Hostnames, Tunnel und TLS werden außerhalb von Compose konfiguriert. Die öffentliche Ingest-URL ist keine eingebaute Anwendungseinstellung, sondern wird ausschließlich über `SCMDB_SINK_BASE_URL` gesetzt.

## Erstinstallation

1. Zielordner für den PostgreSQL-Mount anlegen.
2. Stack mit sicheren Variablen deployen.
3. `/healthz` prüfen.
4. Login öffnen, Sink-Token erzeugen und in SCMDB konfigurieren.
5. In SCMDB einen Blueprint-/Profil-Resync auslösen.

## Update und Rollback

Vor dem Update Datenbank sichern. Danach neuen Git-Commit pollen/redeployen und Healthcheck sowie Logs prüfen. Für Rollback den vorherigen Commit in Portainer referenzieren und neu deployen. Keine Datenbank-Volumes löschen.

## Backup und Restore

Regelmäßig den Bind-Mount mit Hyper Backup sichern. Alternativ `pg_dump`/ `psql` verwenden; konkrete Beispiele stehen im README. Restore zunächst in einer kontrollierten Umgebung testen.

## Logging und Fehlerbehebung

```powershell
docker compose logs -f app
docker compose logs -f db
docker compose ps
```

Bei `Invalid URL` PostgreSQL-Verbindung prüfen; bei 404 den Reverse Proxy; bei fehlenden Blueprints Sink-Token und SCMDB-Resync.
