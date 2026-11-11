# D Database Backup and Recovery

## Design
- Backups use a configurable S3-compatible object-storage provider (Cloudflare R2 or another compatible service).
- Credentials are server-only environment secrets. The bucket must be private and the access key must be scoped to the D Database backup bucket/prefix.
- Backup objects use generated keys under a D Database-specific prefix. Never use customer-provided object keys.
- PostgreSQL backup and restore operations run on the deployed D Database worker host using PostgreSQL client tools. Application servers must not assume local disk is durable.
- A backup is marked completed only after the dump is uploaded and its SHA-256 checksum and object metadata are recorded.
- Restore must verify the downloaded object's checksum before invoking PostgreSQL restore tooling.
- Retention cleanup may delete only completed, expired backup objects belonging to D Database.
- Metadata records project/resource ownership, lifecycle state, checksum, size, timestamps and retention expiry. Object identifiers are never authorization credentials.

## Required deployment configuration
Set the S3-compatible endpoint, region, bucket, access key ID, secret access key and backup prefix as server environment secrets. Also install compatible pg_dump and pg_restore binaries on the worker host and ensure they match the deployed PostgreSQL major version.

## Operational safety
- Keep D Database and D Hosting on separate storage credentials and prefixes.
- Do not store provider credentials in PostgreSQL or return them from APIs.
- Do not mark backups available until upload and integrity verification succeed.
- Restore is destructive and must be an explicit authenticated action with resource ownership checks and a pre-restore safety backup.
- Configure the worker scheduler and retention policy before claiming automatic backups are active.
