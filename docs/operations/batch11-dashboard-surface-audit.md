# Batch 11 — Dashboard surface wiring audit

Audited against the Batch 10 integration branch before final release acceptance.

## D Hosting route map

- App navigation exposes Overview, Projects, Resources, Database Connections, Usage & Billing, Activity, and Settings.
- Projects and Resources route through ProjectManager / ProjectResources into the website ResourceWorkbench.
- The website ResourceWorkbench exposes website file upload/download/rename/delete, runtime status and validation, per-website D Database assignment, and the website resource workbench.
- Database Connections is a dedicated navigation surface for OAuth-style connect/list/revoke operations.
- Resource-level deployment history, publishing/rollback, custom domains, environment variables, runtime logs, and persistent storage controls are mounted through the website resource workbench.

## D Database route map

- App navigation exposes Overview, Projects, Resources, API Keys, Usage & Billing, Activity, and Settings.
- Projects and Resources route through ProjectManager / ProjectResources into the database ResourceWorkbench.
- The database ResourceWorkbench exposes table/column/record operations, pagination, and file upload/download/rename/delete; database backup history/restore is part of the resource workbench.
- API Keys is a dedicated navigation surface for scoped key creation, one-time secret display, copy, list, and revoke.

## Audit limitations and release evidence

- This is a source-level component/navigation audit only. It does not claim a browser session was run or that a live backend/provider/host was exercised.
- CI typecheck/build and API tests verify compilation and automated contracts, not visual layout, browser accessibility, or the full interactive customer journey.
- The D Hosting overview deliberately labels storage as not measured. Do not replace that with a total-storage figure: uploaded-file quota, immutable deployment snapshots, and runtime persistent volumes are distinct accounting categories.
- Node.js execution must continue to display its actual runtime gate/readiness reason and remain disabled until the dedicated Linux host acceptance is signed off.
- The staging checklist and required proof are in v1-release-acceptance-runbook.md.

## Final acceptance rule

Treat dashboard code wiring, automated CI, staging journey, and production host sign-off as separate gates. No source audit or CI-only result may be represented as production readiness.