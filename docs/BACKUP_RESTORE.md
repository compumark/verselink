# Backup and Restore

## Backup

Create a PostgreSQL dump before upgrades or redeployments. Current values:

- Container: `verselink-db`
- Database: `blueprints`
- User: `blueprints`

```powershell
docker exec verselink-db pg_dump -U blueprints -d blueprints > verselink.sql
```

Back up the `.env` or Portainer Environment configuration separately and securely. Logs are optional. Synology Hyper Backup or Snapshots may protect the configured host directories, but a PostgreSQL dump is recommended for a consistent portable database backup.

## Restore

Restore only after checking the target database and keeping a copy of the current backup:

```powershell
Get-Content .\verselink.sql | docker exec -i verselink-db psql -U blueprints -d blueprints
```

For existing Synology deployments, confirm `POSTGRES_DATA_PATH` still points to the original PostgreSQL directory before starting the stack. No production password belongs in this document.
