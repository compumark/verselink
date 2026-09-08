# Upgrading VerseLink

## Before upgrading

1. Read the release notes and changelog.
2. Create a PostgreSQL backup using [BACKUP_RESTORE.md](BACKUP_RESTORE.md).
3. Securely save the `.env` or Portainer Environment configuration.
4. Check the current storage configuration.

## Existing bind-mount users

Before redeploying, verify:

```text
POSTGRES_DATA_PATH=<existing PostgreSQL host path>
APP_LOG_PATH=<existing log host path>
```

For the current Synology installation:

```text
POSTGRES_DATA_PATH=/volume1/verselink/postgres
APP_LOG_PATH=/volume1/verselink/logs
```

Do not rely on a missing variable or a new Named Volume for an existing installation.

## Portainer

1. Pull the latest repository revision.
2. Keep the existing Environment variables.
3. Confirm the two storage variables before redeploying a bind-mount stack.
4. Redeploy the stack.
5. Check health and logs.

## Verification

Verify `/healthz`, login, existing users and groups, orders, inventories, database contents, and application logs. If the application appears empty, stop and verify the PostgreSQL path before making further changes.
