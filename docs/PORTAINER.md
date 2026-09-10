# Portainer Deployment

## New installation

The public default stack is portable and uses the Named Volumes `verselink-postgres` and `verselink-logs`.

1. Open Portainer.
2. Open **Stacks** and select **Add stack**.
3. Choose **Git repository**.
4. Repository URL: `https://github.com/compumark/verselink.git`
5. Reference: `main`.
6. Compose path: `docker-compose.yml`.
7. Add `POSTGRES_PASSWORD` and `SINK_TOKEN_PEPPER` as Environment variables. If SCMDB synchronization is needed, also add `SCMDB_SINK_BASE_URL` with this deployment's public ingest base URL, for example `https://verselink.example.org/v1/scmdb`.
8. Deploy the stack.
9. Check container health and open VerseLink on port `3000` or through the reverse proxy.

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

For a Portainer **Web editor** deployment, use the self-contained GHCR example in the README. It uses direct quoted placeholders such as `'CHANGE_ME'`, `''`, and `https://verselink.example.org`, so it can be pasted and edited directly in Portainer. `PGPASSWORD` and `POSTGRES_PASSWORD` must be the same strong random password, and `SINK_TOKEN_PEPPER` must be a long random value that remains stable for an existing installation. Never commit real secrets.

The Web editor example is intentionally different from Docker Compose or `.env`-based deployment. Compose deployments may continue using `${VARIABLE}` interpolation with `.env.example` as their template; the environment variable names and meanings are unchanged.

Stable releases use fixed version tags, for example:

```text
ghcr.io/compumark/verselink:1.2.3
```

For the current stable release, `1.2.3` is the exact version and the recommended Production pin. `1.2` follows the latest stable patch in the 1.2 series, `1` follows the latest stable major version, and `latest` follows the newest published stable release.

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
