# D Hosting + D Database V1 — Final Integration Batches 9–11

This is the acceptance contract for the final three code batches. It distinguishes code that exists from capabilities that are operationally enabled. Passing unit tests alone does not make V1 ready.

## Scope

The final integration must deliver a complete customer journey:

1. A customer creates an account and a project.
2. The customer creates a static or Node.js website in D Hosting.
3. The customer uploads website assets and deploys an immutable version.
4. A Node.js website is built by the isolated builder, started by the private runtime agent, and routed through private ingress only after readiness checks pass.
5. The customer creates a D Database resource and manages tables, columns, records, indexes, constraints, relationships, and transactions from the D Database dashboard.
6. The customer authorizes D Hosting to use the database and assigns that connection to a specific website.
7. The website receives scoped database credentials as runtime environment variables; credentials are never exposed in dashboard responses or logs.
8. The customer manages website environment variables, domains, deployments, runtime status/logs, and persistent storage from D Hosting.
9. The customer manages database API keys, permissions, backup history, and restore operations from D Database.
10. A real deployed website can read and write its own database records, serve uploaded images/documents, and survive a restart and a verified backup/restore cycle.

## Batch 9 — End-to-end deployment and database connection

- Connect the immutable deployment API, isolated Node builder, private runtime agent, and deployment activation flow into one tested pipeline.
- Ensure build failures never replace the currently active deployment.
- Ensure activation occurs only after runtime readiness and ingress cutover can be safely completed or rolled back.
- Finish the per-website D Database connection assignment flow and verify least-privilege runtime credentials.
- Correct customer-facing dashboard copy so it describes only capabilities that are actually enabled; remove stale notices that contradict working assignment functionality.
- Add integration tests for static and Node deployment paths, database assignment, credential injection/redaction, and failure-before-activation behavior.

## Batch 10 — Runtime, storage, and lifecycle safety

- Complete runtime-agent configuration and readiness gates, container isolation, private networking, persistent-volume attachment, restart/reconciliation, stop/restart, and cleanup behavior.
- Keep execution disabled unless every required Linux isolation, storage quota, trusted image, ingress, and agent-health prerequisite is satisfied. No unsafe automatic enablement or silent fallback.
- Enforce a transactional per-website uploaded-file quota (100 MiB default, configurable between 1 MiB and 10 GiB), with the website row locked during reservation so concurrent uploads cannot exceed quota; retain the 10 MiB per-file limit and owner-scoped metadata operations. This quota currently measures original customer-upload records, not duplicate immutable deployment snapshots or private runtime persistent storage; dashboard labels must not imply it is total platform storage.
- Use the S3-compatible website object-storage adapter for customer file uploads/downloads/deletes. A dry-run-by-default migration command now covers legacy local upload records and UUID-keyed deployment-manifest snapshots; production apply remains an operator-controlled step with verified backups and a maintenance window (see docs/operations/hosting-object-storage-migration.md). Object keys are scoped by owner/project/website/object IDs; objects use private bucket access and server-side encryption. Production startup fails closed unless bucket, region, access key, and secret key are configured. Local filesystem storage remains development-only; existing local files require an explicit migration before production cutover. Verify provider lifecycle, backup/retention policy, and restore procedures. Database rows should store metadata/references; binary image, video, audio, and document contents belong in object/file storage rather than ordinary relational rows.
- Verify static assets and customer uploads are not confused with runtime source artifacts or private runtime persistent data.
- Verify custom-domain verification, HTTPS/ingress routing, deployment rollback, runtime logs, and secret redaction through the dashboard.
- Add recovery tests for interrupted builds, failed starts, agent loss, storage errors, and failed ingress cutover.

## Batch 11 — Dashboard completion and release acceptance

- Audit both React dashboards against the customer-facing requirements below; add missing screens, actions, loading/error states, and backend wiring rather than treating existing components as proof of completion.
- D Hosting dashboard: website/project management; uploads and storage usage; deploy/publish/rollback; custom domains and HTTPS state; environment variables/secrets; database connections and per-website assignment; runtime status/logs; persistent storage and backup controls; relevant website settings.
- D Database dashboard: database/resource management; table/column/record workbench; indexes/foreign keys/constraints/transactions; connection details and permissions; API-key create-once/revoke flow; settings; automatic backup history and verified restore.
- Confirm secrets are shown only once when created, never returned by list APIs, and redacted from logs and errors.
- Run a production-like end-to-end acceptance suite covering the full customer journey above, including image/document upload and retrieval, a real Node backend database read/write, deployment rollback, and backup restore.
- Update operational docs and environment templates. Keep Linux production setup and actual host provisioning as a separate, explicitly deferred operational step until all code batches and CI acceptance are complete.

## Known audit findings at the start of these batches

- The dashboards already contain components for deployments, custom domains, environment variables, database API keys, backups, and database connections. Their existence is not proof that all flows are complete or correctly wired.
- The D Hosting database-connections screen currently tells customers that per-website assignment and live application access are not enabled. This wording must be reconciled with the server-side assignment/runtime-connection implementation and verified behavior.
- The runtime agent has builder/runtime endpoints, but container execution is guarded by an explicit `executionEnabled` flag and the provider is intentionally not enabled before Linux isolation and end-to-end acceptance. This safety gate must remain.
- Website file uploads currently use a local filesystem root and a 10 MiB per-file limit. This is not by itself proof of durable, scalable object storage or storage metering. The final batches must explicitly verify the intended storage backend and lifecycle.
- The D Database API-key screen and backup-history/restore screen exist. Their authorization, ownership boundaries, secret handling, automatic scheduler configuration, and restore behavior must be included in end-to-end tests.

## Release gate

Do not mark V1 complete, enable customer Node execution, or start production Linux setup until all three batches are implemented, CI is green on the final combined branch, and the end-to-end acceptance journey is demonstrated. Do not merge any draft PR without explicit approval.


## Remaining storage-accounting limitation

The uploaded-file quota currently accounts for the original rows in `hosting_files`. Immutable deployment snapshots can duplicate bytes in object storage, and runtime persistent volumes are separately metered. Before offering a single combined storage quota or customer-facing total-storage figure, add reference-aware object accounting or eliminate duplicate snapshots and reconcile it against provider inventory. Do not describe the current uploaded-file quota as the total storage consumed by a website.


## Code-level audit updates — 2026-11-13

The current dashboard wiring has been inspected on the final integration branch:

- D Hosting navigation exposes Database Connections. The website Resource Workbench wires deployment history, custom domains, environment variables, Node runtime status, runtime logs, and persistent runtime storage. Uploaded-file usage is labelled separately from total object/runtime storage.
- D Database navigation exposes API Keys. The database Resource Workbench wires the schema/table workbench and backup history/restore controls.
- D Database API-key list SQL selects only public metadata fields (it does not select the token hash or raw token); creation returns the raw key once with `Cache-Control: no-store`; revoke is owner/resource scoped. Both API-key and backup routes are mounted behind authentication and project-ownership middleware.
- D Database backup history returns metadata only. Restore calls the verified restore service, which creates a safety backup before applying the selected backup.
- D Hosting database-connection revocation now uses a separately tested transaction helper: assignment rows are deleted and the local connection status is changed atomically after D Database confirms remote credential revocation.
- Added tests that prove a failed/revoked assigned-database lookup prevents any artifact upload or runtime-start request, and that failed Node runtime readiness triggers cleanup of the built artifact and temporary source bundle.

These are source-level wiring and automated-test checks. They do not replace browser acceptance against a running stack, real provider validation, or a real Node-to-D Database read/write test.

## External acceptance blockers (not safely executable from repository CI)

- A real S3-compatible provider and private bucket must be selected and configured by the operator. No provider credentials are stored in this repository or chat. CI uses deterministic SDK mocks; it does not prove a particular provider's SSE, lifecycle, versioning, retention, or disaster-recovery behavior.
- The documented legacy migration must be dry-run, backed up, and applied during a maintenance window against the actual deployment's filesystem and database.
- A real deployed Node website must perform read/write operations against its assigned D Database on the dedicated Linux host, including restart and backup/restore verification.
- Dedicated-host Linux isolation, XFS quota enforcement, private ingress, agent health, and operator approval flags must pass before customer Node execution can be enabled.

Until these are demonstrated, Batches 9–11 remain in acceptance and D Hosting + D Database V1 must not be called production-ready.
