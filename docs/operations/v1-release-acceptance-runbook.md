# D Hosting + D Database V1 — Batch 11 Release Acceptance Runbook

This runbook is the final customer-journey and release-readiness checklist for Batch 11. It is evidence-driven: a screen existing, a green unit test, or a successful CI build does not by itself prove that a customer workflow works against a running stack.

## 1. Dashboard surface audit

The final dashboard audit must be performed against both products after deploying the candidate build to a production-like staging environment.

### D Hosting
- [ ] Account sign-in, sign-out, and session restoration.
- [ ] Create, edit, archive, restore, and open a project.
- [ ] Create/open a website resource and inspect its settings.
- [ ] Upload one file and one folder; verify owner-scoped list, download, rename, and delete.
- [ ] Confirm uploaded-file quota is labelled separately from immutable deployment snapshots and runtime persistent volumes. Do not present it as total storage.
- [ ] Create a static deployment, inspect immutable deployment history, publish, and roll back to a previous version.
- [ ] Add a custom domain, complete TXT verification, and verify HTTPS/ingress status. Do not treat a pending domain as active.
- [ ] Create/update/delete environment variables; confirm secret values are never returned after creation and are redacted from logs/errors.
- [ ] Connect D Database, select a website-specific assignment, change the assignment, and revoke the connection.
- [ ] Inspect runtime status, readiness reason, logs, and persistent storage/backup controls. An unavailable runtime must be shown as unavailable; never imply Node execution is active while the execution gate is closed.
- [ ] Confirm every action has loading, success, empty, and actionable error states; destructive actions require confirmation.

### D Database
- [ ] Account sign-in, sign-out, and session restoration.
- [ ] Create, edit, archive, restore, and open a project and database resource.
- [ ] Create a table; add/rename/drop a column; inspect indexes, foreign keys, and constraints.
- [ ] Create, read, update, delete, and paginate records; verify transaction-backed operations where exposed.
- [ ] Upload, list, download, rename, and delete a file.
- [ ] Create a scoped API key and verify the raw secret is displayed once only; copy/save it, refresh the page, and confirm it is not retrievable from list APIs/UI.
- [ ] Revoke an API key and verify it can no longer authenticate.
- [ ] Inspect automatic backup history and restore a completed backup. Verify a safety backup is created before restore.
- [ ] Confirm permissions, project ownership, loading/error/empty states, and destructive-action confirmations.

## 2. Full customer journey — required staging evidence

Use disposable test accounts, projects, websites, and database resources. Never use customer data or production credentials for this test.

1. Create a new customer account and project in D Hosting.
2. Create a static website, upload an HTML page plus an image/document, deploy an immutable version, and open it through the staging hostname.
3. Verify the image/document is served correctly; update the website and deploy a second version.
4. Roll back to the first version and verify the first content is served again.
5. Create a D Database account/project/resource and create a table with a primary key, a foreign key, a constraint, and an index.
6. Create a least-privilege API key, verify it works only for its permitted resource/actions, then revoke it and verify rejection.
7. Authorize D Hosting to connect to D Database and assign that connection to the test website.
8. On the dedicated Linux runtime host only, deploy a minimal Node.js website through the isolated builder/runtime agent. It must not be exposed through ingress until readiness succeeds.
9. From that running Node.js website, write and read a record using only its assigned database credentials. Confirm a different website cannot use the assignment.
10. Confirm credentials are absent from dashboard responses, browser-visible page data, runtime logs, application errors, and public deployment artifacts.
11. Upload an image/document to the website and retrieve it through the published website route.
12. Write a test file to the website's persistent runtime storage, restart/replace the runtime, and verify the file survives.
13. Create and verify an encrypted persistent-storage backup; restore it into the isolated test website and verify the restored content.
14. Run the D Database automatic backup worker, inspect backup history, restore a completed backup, and verify the restored records. Confirm the pre-restore safety backup exists.
15. Revoke the D Hosting database connection, verify the website no longer receives database credentials, and verify the website cannot read/write the database.
16. Delete the disposable website/resource and confirm the documented tombstone/retention behavior.

## 3. Automated CI acceptance

The final combined branch must have green GitHub Actions for:
- D Database API tests and typecheck.
- D Database dashboard typecheck, product-configuration tests, and production build.
- D Hosting API tests and typecheck.
- D Hosting dashboard typecheck and production build.
- Runtime-agent tests and typecheck.
- Real PostgreSQL platform backup/restore integration, including corrupt-archive rejection without partial target modification.
- Rootless Podman Linux smoke test, including persistent-volume survival across runtime replacement and tenant data isolation.

Record the final commit SHA and corresponding successful workflow run IDs in the release record. A passing CI run does not replace the live staging journey above.

## 4. Operational release blockers — explicit sign-off required

These checks cannot be claimed from repository CI alone:
- [ ] Dedicated Linux host provisioned with supported cgroup v2 and rootless Podman.
- [ ] XFS project quotas (prjquota) enabled and verified for each website runtime.
- [ ] Private ingress and agent-to-control-plane authentication verified.
- [ ] Trusted runtime image pinned and approved.
- [ ] Actual host readiness, resource limits, restart/reconciliation, and second-tenant isolation verified.
- [ ] Production website object-storage configuration and migration accepted. V1 currently uses PostgreSQL-backed hosting_object_blobs; local filesystem storage is development-only. Do not claim S3-compatible provider lifecycle guarantees.
- [ ] Real Node.js website successfully reads/writes its assigned D Database on the dedicated host.
- [ ] Real persistent-volume restart and encrypted backup/restore cycle demonstrated on the selected host/storage configuration.
- [ ] Database backup schedule, retention, off-host copy, and restore procedure accepted by the operator.
- [ ] Security review and rollback plan signed off.

**Safety gate:** Until all required operational checks are evidenced and approved, keep customer Node.js execution disabled. Do not enable execution, change production credentials/roles, run production storage migrations, provision production infrastructure, or deploy to production as part of this code batch.

## 5. Release decision

- **Code complete:** Batch 11 code changes and dashboard wiring have been reviewed; CI is green on the final combined branch.
- **Staging accepted:** Every required customer journey in section 2 has evidence and no unresolved severity-1/security/data-loss issue.
- **Production ready:** Only after all operational blockers in section 4 are signed off.

Do not collapse these three decisions into a single complete status. Record the approver, date, commit SHA, CI run IDs, staging evidence location, and any accepted limitations.


## 6. Batch 11 repository CI evidence

- Candidate commit: `87fedd7e6f6075a0c4e5c62795dfeb167eb713a7`.
- GitHub Actions run: `1156` (run ID `44165719308`), completed successfully.
- Successful jobs: D Database API tests/typecheck; D Database dashboard configuration tests/typecheck/build; D Hosting API tests/typecheck; D Hosting dashboard typecheck/build; runtime-agent tests/typecheck; real PostgreSQL platform backup/restore and corrupt-archive safety test; rootless Podman Linux smoke test with persistent-volume survival.
- This evidence verifies the automated repository suite on the candidate branch. It does not certify the live staging customer journey or production Linux host operational gates in section 4.
