# Portainer Deployment

## New installation

The public default stack is portable and uses the Named Volumes `verselink-postgres` and `verselink-logs`.

1. Open Portainer.
2. Open **Stacks** and select **Add stack**.
3. Choose **Git repository**.
4. Repository URL: `https://github.com/compumark/verselink.git`
5. Reference: `main`.
6. Compose path: `docker-compose.yml`.
7. Add `POSTGRES_PASSWORD` and the installation's existing `SINK_TOKEN_PEPPER` as Environment variables. Do not rotate or strengthen the Sink pepper to enable VerseKit. If enabling VerseKit, also set `VERSEKIT_ENABLED=true`, `VERSEKIT_GROUP_ID`, the public HTTPS `VERSEKIT_PUBLIC_URL`, and an independent `VERSEKIT_TOKEN_PEPPER` with at least 32 UTF-8 bytes (for example, generate a 64-character value using `openssl rand -hex 32`). Use different VerseKit peppers for DEV and PROD and keep each stable after use. Optional `VERSEKIT_ORDERS_WRITE=true` and `VERSEKIT_BLUEPRINTS_READ=true` activate those capabilities in either environment; unset or malformed values leave them disabled. The old `VERSEKIT_DEV_*` flags are deprecated DEV-only fallbacks, overridden by a set new flag. If SCMDB synchronization is needed, also add `SCMDB_SINK_BASE_URL` with this deployment's public ingest base URL, for example `https://verselink.example.org/v1/scmdb`. To enable optional private registration DMs, add both `DISCORD_BOT_TOKEN` and `DISCORD_ADMIN_USER_ID` (the recipient's Discord user snowflake). The bot must be able to DM that user; delivery is best-effort and never blocks registration.
8. Deploy the stack.
9. Check container health and open VerseLink on port `3000` or through the reverse proxy.

## Logging

VerseLink writes JSONL access logs as `YYYY-MM-DD_access.log` and application logs as
`YYYY-MM-DD_verselink.log` below `LOG_DIR` (default: `/app/logs`). Set
`LOG_LEVEL=INFO` to choose the startup default (`ERROR`, `WARN`, `INFO`, or `DEBUG`) and
`LOG_RETENTION_DAYS=30` to control cleanup of only these VerseLink-created files.

An existing VerseLink administrator can temporarily change the effective level in the
MobiGlass Admin Center. This override is not stored in PostgreSQL: it expires at its
chosen reset time, can be reset manually, and is always lost when the process/container
restarts, returning to `LOG_LEVEL`.

No GHCR image is required; Portainer builds the app from the repository Dockerfile.

## SCMDB synchronization

`SCMDB_SINK_BASE_URL` is not required for VerseLink itself, but it is required to create SCMDB Sync Sinks. It has no default and no Production fallback. If it is absent, empty, or invalid, VerseLink continues running while SCMDB synchronization is disabled.

Configure the value in Portainer's environment for the specific deployment:

```text
# Self-hosted
SCMDB_SINK_BASE_URL=https://verselink.example.org/v1/scmdb

# DEV
SCMDB_SINK_BASE_URL=https://your-dev.example.org/v1/scmdb

# Official Production deployment
SCMDB_SINK_BASE_URL=https://your-production.example.org/v1/scmdb
```

The configured endpoint must be publicly reachable by SCMDB. These are deployment examples, not application defaults.

## Existing Synology / VerseLink deployment

Do not redeploy an existing bind-mount installation until `POSTGRES_DATA_PATH` and `APP_LOG_PATH` point to the existing directories. A wrong PostgreSQL path can make the application appear empty because PostgreSQL may use a different data directory; the original data is not automatically deleted.

Before the first redeploy:

1. Create a PostgreSQL backup.
2. Verify the existing PostgreSQL host path: `/volume1/verselink/postgres`.
3. Verify the existing log host path: `/volume1/verselink/logs`.
4. Set these Portainer Environment variables:

   ```text
   POSTGRES_DATA_PATH=/volume1/verselink/postgres
   APP_LOG_PATH=/volume1/verselink/logs
   ```

5. Set the Compose path to `docker-compose.bind.yml` for this existing installation. Portainer can deploy this file directly; no CLI-only override operation is required.
6. Redeploy only after both variables are present.
7. Verify existing users, groups, orders, inventories, database contents, logs, and `/healthz`.

No data copy, move, export/import migration, or volume migration is required. Container targets remain `/var/lib/postgresql/data` and `/app/logs`.

## Using GHCR images

The repository also publishes Docker images through GitHub Container Registry. This is an additional distribution option; the existing Git/build deployment remains supported.

For a Portainer **Web editor** deployment, use the self-contained GHCR example in the README. It uses direct quoted placeholders such as `'CHANGE_ME'`, `''`, and `https://verselink.example.org`, so it can be pasted and edited directly in Portainer. `PGPASSWORD` and `POSTGRES_PASSWORD` must be the same strong random password. Keep the existing `SINK_TOKEN_PEPPER` unchanged; configure the separate `VERSEKIT_TOKEN_PEPPER` only when enabling VerseKit. Never commit real secrets.

### Enabling VerseKit on an existing installation

Keep the existing `SINK_TOKEN_PEPPER` exactly as configured. For first activation, use a separate DEV or PROD `VERSEKIT_TOKEN_PEPPER`, set the existing fixed `VERSEKIT_GROUP_ID` and public HTTPS origin, and set `VERSEKIT_ENABLED=true`. Missing or short VerseKit peppers fail startup closed. If VerseKit credentials may have been issued with the former shared pepper, first set `VERSEKIT_ENABLED=false` on every app replica and redeploy/restart all instances (or stop all app containers). Check every host/node and ensure no old enabled container remains. Merely blocking incoming VerseKit traffic does not stop the enabled adapter's scheduled cleanup timer. Then follow the read-only assessment and separately confirmed apply procedure in [the VerseKit integration guide](integrations/versekit-org-standard-v1.md). Apply requires `VERSEKIT_ENABLED=false` in the cleanup process and an explicit all-instances-quiesced confirmation. The cleanup affects only VerseKit grants, token families, token rows, and consent challenges; it is never run by application startup.

Changing `VERSEKIT_TOKEN_PEPPER` invalidates VerseKit clients' existing grants, access/refresh tokens, consent challenges, and Orders cursors. Clients must reconnect. Keep the previous image and environment for rollback, but restore with VerseKit disabled; never change the Sink pepper as part of rotation or rollback.

The Web editor example is intentionally different from Docker Compose or `.env`-based deployment. Compose deployments may continue using `${VARIABLE}` interpolation with `.env.example` as their template; the environment variable names and meanings are unchanged.

Stable releases use fixed version tags, for example:

```text
ghcr.io/compumark/verselink:1.4.0
```

For VerseLink 1.4.0, `1.4.0` is the exact version and the recommended Production pin. `1.4` follows the latest stable patch in the 1.4 series, `1` follows the latest stable major version, and `latest` follows the newest published stable release.

The convenience tag follows the most recently published stable release:

```text
ghcr.io/compumark/verselink:latest
```

Development images from pushes to `main` use:

```text
ghcr.io/compumark/verselink:dev
ghcr.io/compumark/verselink:sha-<shortsha>
```

`latest` is not updated by normal pushes to `main`. A separate test stack should be used for development and bugfix testing; do not reuse production container names, host ports, PostgreSQL data, or log paths.

After the first successful GHCR publish, check the package in GitHub under **Packages → Settings → Visibility**. The workflow does not change package visibility automatically; public installations require the package to be publicly accessible.
