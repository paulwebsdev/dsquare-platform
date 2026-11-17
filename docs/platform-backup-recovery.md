# Full-platform backup recovery

This is an isolated recovery workflow, not an in-place production restore.

## Before restoring

1. Obtain the completed backup's object key, byte size, and SHA-256 from the product's platform-backup metadata.
2. Download that exact object from the private backup bucket using an approved operator credential. Never expose storage credentials in chat, shell history, tickets, or logs.
3. Verify the downloaded file size and SHA-256 against metadata with wc -c and sha256sum.
4. Create a fresh, empty PostgreSQL database on a local/isolated recovery instance. Use a name such as dsquare_restore_hosting_20261117 or dsquare_restore_database_20261117.
5. Use a dedicated local restore role and connect to the isolated instance only.

## Run the product restore guard

D Hosting:
    bash apps/d-hosting/server/scripts/restore-platform-backup.sh ./platform.dump dsquare_restore_hosting_20261117

D Database:
    bash apps/d-database/server/scripts/restore-platform-backup.sh ./platform.dump dsquare_restore_database_20261117

The script rejects non-loopback PostgreSQL hosts, source/application URL variables, database names without the dsquare_restore_ prefix, invalid archives, and targets containing user relations. It restores without --clean and in one transaction, so a failed restore rolls back rather than partially replacing existing objects.

## After restore

- Run product-specific schema/migration integrity checks against the isolated database.
- Verify key account/project/resource counts and representative relationships.
- Verify external object-storage data separately. A PostgreSQL platform dump does not include website uploads or database resource backup objects.
- Keep the recovered database isolated until an operator completes the recovery review.

## Important scope

The scheduled workers create and verify PostgreSQL custom-format archives and store metadata/checksums. These scripts safely restore a downloaded archive, but do not fetch from private storage or promote a recovered database. Live private-bucket credentials and production recovery approval remain operator-controlled.
