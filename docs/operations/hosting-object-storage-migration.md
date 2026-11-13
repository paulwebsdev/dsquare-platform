# D Hosting website object-storage migration

This migration moves legacy local website uploads and local immutable deployment snapshots into the configured private S3-compatible bucket. It does not create a bucket or change provider access policies.

## Preconditions

- Stop website uploads and deployments during the migration window.
- Configure the D Hosting server's HOSTING_OBJECT_STORAGE_BUCKET, HOSTING_OBJECT_STORAGE_REGION, HOSTING_OBJECT_STORAGE_ACCESS_KEY_ID, and HOSTING_OBJECT_STORAGE_SECRET_ACCESS_KEY in the server's secret manager or protected environment. Never paste credentials into chat or commit them.
- Configure an HTTPS HOSTING_OBJECT_STORAGE_ENDPOINT only when required by the selected S3-compatible provider.
- Ensure the bucket is private, public access is blocked, encryption/versioning/retention/lifecycle and off-site backup policy are configured according to the provider's production guidance.
- Take and verify a PostgreSQL backup and a filesystem backup before migration.
- Run the command from apps/d-hosting/server with the same database and HOSTING_STORAGE_ROOT used by the running D Hosting service.

## Dry run (default)

    npm run migrate:website-object-storage

The command is read-only with respect to the database and local files. It reports how many legacy objects can be migrated and how many referenced files are missing. It validates file type, path containment, file size and source metadata. A missing object makes the command exit with status 2; investigate and repair those records before cutover.

## Apply

After reviewing the dry-run output and confirming backups:

    npm run migrate:website-object-storage -- --apply

The script serializes concurrent migration runs with a PostgreSQL advisory lock. For each object it verifies the source size, calculates SHA-256, uploads under an owner/project/website-scoped key, verifies the uploaded object metadata and size, updates the corresponding database reference in a transaction, and only then removes the local source file. If a database update fails, the newly uploaded object is removed where possible and the source is retained. Existing S3 keys are left unchanged.

The script handles legacy hosting_files rows and local UUID-keyed deployment-manifest entries. It checks both historical deployment snapshot layouts: <root>/<website>/<key> and <root>/<website>/deployments/<deployment>/<key>.

## After migration

- Re-run the dry run; it should report no remaining migratable local objects and no missing referenced files.
- Verify sample file downloads, static deployment previews, deployment rollback, and Node deployment artifact availability.
- Compare database manifests and object counts against the backup.
- Keep the filesystem backup until all application and restore checks pass. Do not delete the old storage root manually.
- Confirm bucket versioning, lifecycle, retention, private access and restore procedures with the actual provider. CI mocks and a successful migration do not constitute provider disaster-recovery acceptance.

Do not enable public Node execution or begin production cutover solely because this script succeeds. Dedicated Linux isolation and the remaining V1 release gates still apply.