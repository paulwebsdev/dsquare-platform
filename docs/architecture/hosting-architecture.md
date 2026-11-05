# DSquare Platform — D Hosting Architecture

## 1. Purpose

This document defines how D Hosting accepts, builds, deploys, serves and manages customer websites and applications.

D Hosting is a separate product from D Database. It may use approved shared platform services, but it must maintain its own product data, permissions, deployment records, resources and operational boundaries.

## 2. Core Decisions

- D Hosting supports customer website projects and controlled deployments.
- Frontend hosting and backend hosting are distinct capabilities with separate security boundaries.
- Customer projects, deployments, domains, logs and resources are tenant-owned.
- Deployment discovery or upload does not authorize execution.
- Customer-provided code must never run inside the main platform process.
- Backend execution requires an isolated runtime with explicit resource and network controls.
- Production deployments must be versioned, observable and reversible where technically possible.
- Platform administration and customer actions must be authorized and audited.

## 3. Product and Tenant Boundaries

- D Hosting maintains its own database, credentials, migrations, permissions and resource records.
- Every project, deployment, domain, runtime, log and background job must have an authoritative product and tenant owner.
- Tenant context must come from trusted backend authentication and authorization.
- Client-supplied tenant IDs and resource IDs are not proof of access.
- All reads, writes, deployment operations and file access must enforce ownership.
- Cross-tenant access is denied unless an explicitly authorized platform operation permits it.

## 4. Project Model

A customer may create a project representing a website or application.

A project may contain:
- Project settings and ownership.
- Source or uploaded build artifacts.
- Deployment history.
- Assigned domains and subdomains.
- Environment configuration.
- Resource limits and usage information.
- Logs and deployment status.

Projects must have stable identifiers and explicit lifecycle states. Deleting a project must follow defined cleanup and retention rules.

## 5. Supported Deployment Types

### 5.1 Static Frontend

Static projects consist of files that can be served without executing customer code on each request.

The platform must:
- Validate uploaded or generated build artifacts.
- Store deployment artifacts in controlled storage.
- Publish only approved deployment versions.
- Serve files through the hosting layer.
- Prevent directory traversal and access to internal platform files.

### 5.2 Backend Applications

Backend applications require a separate, isolated execution environment.

The platform must not execute customer backend code in the main API server or worker process.

Before backend execution is offered, the platform must define and test:
- Runtime and dependency support.
- Process and filesystem isolation.
- CPU, memory, storage and execution limits.
- Network access rules.
- Secrets and environment-variable handling.
- Start, stop, restart and health-check behavior.
- Logging, failure handling and cleanup.

Backend execution must remain disabled until these controls are implemented and verified.

## 6. Deployment Lifecycle

A deployment must move through explicit states, such as:

- Submitted
- Validating
- Building, where applicable
- Ready to publish
- Publishing
- Active
- Failed
- Rolled back
- Retired

The system must record the project, tenant, deployment version, initiating actor, timestamps, status and relevant failure details.

A deployment must not become active until required validation and publishing steps succeed.

Failed deployments must not silently replace the active version.

## 7. Build and Artifact Handling

Builds must run outside the main platform process in controlled workers or isolated environments.

Requirements:
- Accept only supported project formats and build configurations.
- Validate paths and reject traversal attempts.
- Apply build time, CPU, memory and storage limits.
- Do not expose platform credentials to customer build processes.
- Keep build artifacts associated with their project and deployment.
- Report build output and failures without exposing secrets.
- Clean up temporary files and abandoned work.

Arbitrary customer build commands require an explicitly designed isolation boundary and must not be enabled by default.

## 8. Domains and Subdomains

Each project may receive a platform-managed subdomain.

Custom domains may be supported through a verified domain-ownership process.

Requirements:
- Domain assignment must be unique and authorized.
- A customer must not claim a domain already assigned to another tenant.
- Domain verification must precede activation of custom-domain routing.
- TLS certificates must be managed securely and renewed automatically where supported.
- Domain removal and project deletion must revoke routing and certificate associations safely.
- Routing must resolve to the correct project and deployment without crossing tenant boundaries.

Domain and subdomain naming, availability, reserved names and customer-facing limits must be defined before implementation.

## 9. Environment Configuration and Secrets

- Separate development, staging and production configuration.
- Store secrets in an approved server-side secret mechanism.
- Never expose backend secrets in frontend bundles, deployment artifacts, logs or API responses.
- Restrict secret access to the specific project and runtime that requires it.
- Support controlled updates and rotation.
- Ensure deployment logs redact secret values.

## 10. Logs and Operational Visibility

D Hosting must provide authorized visibility into:
- Deployment and build status.
- Application or runtime logs, where supported.
- Relevant platform errors.
- Resource usage and limits.
- Deployment history.

Logs must be scoped by product, tenant and project. They must not contain credentials or unnecessary personal information.

The platform must define retention, access controls and limits for log volume and storage.

## 11. Resource Limits and Abuse Prevention

Each project and tenant must have configurable limits appropriate to its service tier, including where applicable:
- Storage and artifact size.
- Build duration and concurrency.
- CPU and memory.
- Runtime count and execution duration.
- Network usage.
- Log volume.
- Deployment frequency.

The platform must enforce limits on the backend and report when a limit prevents an operation.

## 12. Rollback and Recovery

- Preserve deployment history according to defined retention rules.
- Support returning to a previously successful deployment where the deployment type permits it.
- A rollback must be an explicit, authorized operation.
- Record the actor, target version, result and timestamp.
- Do not claim a rollback succeeded until the active deployment is verified.
- Define recovery procedures for failed publishing, unavailable storage and runtime failure.

## 13. Background Jobs

Builds, publishing, certificate operations and other long-running tasks must use a controlled background-job system.

Jobs must:
- Preserve product, tenant and project context.
- Have explicit states and safe retry behavior.
- Be idempotent where practical.
- Enforce concurrency and resource limits.
- Record failures without leaking secrets.
- Prevent duplicate execution from creating inconsistent deployments.

## 14. Security and Administration

- Backend authorization is authoritative; frontend permission checks are for user experience only.
- Customer code must not access platform credentials, internal databases or other tenants' resources.
- Administrative actions must require appropriate authorization and be audited.
- Production access must follow least privilege.
- Platform control-plane APIs must be separated from customer application traffic.
- Security-sensitive configuration changes must be validated and recorded.

## 15. Testing Requirements

Tests must cover:
- Tenant and project isolation.
- Deployment state transitions and failure handling.
- Artifact validation and path traversal prevention.
- Domain ownership and routing isolation.
- Authorization for project and deployment operations.
- Resource-limit enforcement.
- Secret redaction.
- Rollback and recovery behavior.
- Background-job retries and duplicate execution.
- Runtime isolation before backend execution is enabled.

## 16. Implementation Order

1. Finalize project, deployment and tenant data models.
2. Define static hosting and artifact storage.
3. Implement a minimal static deployment workflow.
4. Add platform subdomains and safe routing.
5. Add deployment history, status and logs.
6. Add resource limits and operational controls.
7. Design and test isolated backend execution before enabling it.
8. Add custom domains, TLS automation and rollback.
9. Complete security, recovery and load testing before public launch.

## 17. Specification Status

This document is an approved Hosting architecture baseline.

It must be reviewed for deployment safety, tenant isolation, domain handling, resource limits, logging, rollback and backend execution boundaries.

Implementation must not begin until the architecture is reviewed and approved.

## 18. Final Rule

D Hosting must control how customer projects are built, published and served without allowing customer code or resources to compromise the platform or another tenant.

## 19. Additional Implementation Requirements

### 19.1 Atomic Publishing
A deployment must be published as a complete version. If publishing fails, the previously active deployment must remain available. The platform must verify the new version before switching traffic to it.

### 19.2 Public Traffic and Control-Plane Separation
Incoming website traffic must be routed through a controlled serving layer to the correct project and active deployment. This serving path must be separated from platform administration and control-plane APIs.

### 19.3 Immutable Published Artifacts
Once a deployment is published, its artifacts must not be silently modified. Any change must create a new deployment version with its own validation and history.

### 19.4 Customer Backend Access to D Database
If backend hosting is enabled, customer applications must access D Database only through explicitly authorized APIs or scoped credentials designed for that customer and tenant. They must not receive D Hosting's internal database credentials or unrestricted platform database access.


