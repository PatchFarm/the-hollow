# Database migrations

<!-- Created by The Hollow as a starting point: edit freely. `hollow upgrade` never changes it. -->

This project's migrations use **django**. The pipeline handles them in three places:

1. **Pull requests.** CI applies every migration to a throwaway database, so a migration that does not run never merges. The Migration safety check reads new migrations and fails on changes that break the code already running, unless the pull request has the `allow-destructive-migration` label.
2. **Deploys.** The server first backs the database up with `pg_dump`, then applies the migrations inside the new image, with the environment's `.env`, before starting it. If the backup fails, nothing is migrated or deployed (except on the first deploy, which goes ahead with a warning). If the migrations fail, the deploy stops and the previous version keeps running.
3. **Rollbacks.** When a deploy fails its health check, the pipeline puts the previous code back. It does not undo migrations: the database stays migrated, so every migration has to work with both the old code and the new.

## Expand, migrate, contract

During a deploy the old code keeps running against the new schema for a while, and after a rollback it runs there again. So change the schema in steps that are each safe for whatever code is running:

1. **Expand.** Add what the new code needs (a column, a table, an index) without removing or changing anything the old code uses. Release it.
2. **Migrate.** Release code that writes to both the old and the new place, backfill the existing rows, then switch reads to the new place.
3. **Contract.** Once no running code uses the old column or table, drop it in a later release. This is the step that needs the `allow-destructive-migration` label.

| Change | Safe way |
|---|---|
| Rename a column or table | Add the new one, write to both, backfill, read from the new one, then drop the old one in a later release. |
| Drop a column or table | Stop using it in the code and release that. Drop it in a later release. |
| Change a column's type | Add a column with the new type, backfill, switch to it, then drop the old one. |
| Make a column NOT NULL | Backfill every row and make the code always write it, then add the constraint. |
| Add a NOT NULL column | Give it a default, or add it as nullable, backfill, then make it NOT NULL. |

When a contract step is ready, add the `allow-destructive-migration` label to its pull request. The Migration safety check then reports the change as a warning and passes.

## Restoring a backup

Before each deploy migrates, the server saves a backup to `/srv/app/<environment>/backups/` and keeps the newest seven. To restore one:

```bash
pg_restore --clean --if-exists --no-owner --dbname "<database URL>" backups/<file>.dump
```

Use a `pg_restore` at least as new as the one that made the backup (PostgreSQL 18).

Stop the app first, and restore the code that matches the backup too.
