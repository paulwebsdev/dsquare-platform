# DSquare Platform — System Overview

## 1. Project Purpose

DSquare Platform is an ecosystem containing two independent products:

- D Database
- D Hosting

Both products will share selected internal packages and infrastructure while maintaining separate application frontends and backends.

## 2. Product Architecture

### D Database

D Database provides customers with database management services.

Its planned capabilities include:
- Project and database management.
- PostgreSQL database provisioning.
- Table and data management.
- Secure SQL editor.
- API keys and access policies.
- Private file storage.
- Usage monitoring.
- Backups and restoration.
- Audit records and permissions.

### D Hosting

D Hosting provides customers with website hosting services.

Its planned capabilities include:
- Hosting project management.
- Static website deployment.
- Build and deployment logs.
- Platform subdomains.
- HTTPS support.
- Environment variables and protected secrets.
- Health checks and monitoring.
- Resource limits and usage tracking.
- Controlled backend deployment when secure isolation is available.

## 3. Technology Stack

### Frontend
- React
- Vite
- TypeScript

### Backend
- Node.js
- TypeScript
- Express

### Structured Database
- PostgreSQL

### File Storage
- Private object storage for images, videos, PDFs and other uploaded files.

## 4. Repository Architecture

The repository uses a modular monorepo structure.

- apps/: Independent product applications.
- packages/: Reusable internal packages.
- infrastructure/: Infrastructure configuration and deployment resources.
- docs/: Architecture, setup, decisions and development documentation.
- tests/: Automated testing.

## 5. Product Separation

D Database and D Hosting must maintain:

- Separate frontend applications.
- Separate backend applications.
- Separate product-specific configurations.
- Separate product-specific permissions and resources.
- Clear API boundaries.

Shared functionality must be implemented through controlled reusable packages.

## 6. Shared Packages

The initial shared packages are:

- auth: Shared authentication conventions and functionality.
- contracts: Shared API and module contracts.
- logging: Structured logging conventions.
- shared: General reusable utilities.
- validation: Reusable validation rules.

Shared packages must not become containers for unrelated functionality.

## 7. API Architecture

- Use versioned REST APIs.
- Initial API prefix: /api/v1/.
- Use consistent request and response conventions.
- Validate incoming data on the server.
- Enforce authentication and authorization on protected operations.
- Centralize error handling and logging.

## 8. Automatic Module Discovery

The architecture should support controlled automatic discovery and registration.

### Backend
Approved modules should expose standard module contracts and register their routes through a controlled module registry.

### Frontend
Use supported file-based routing or Vite discovery conventions to reduce repeated manual route registration.

### Database Migrations
Migrations should be discoverable and tracked, but execution must remain controlled and reviewable.

Automatic discovery must never mean blindly executing arbitrary files or code.

## 9. Security Principles

- Never expose database administrator credentials in frontend code.
- Enforce server-side authorization.
- Isolate customer data and resources.
- Protect secrets and environment variables.
- Apply rate limits and resource quotas.
- Record important administrative and security events.
- Do not execute arbitrary customer code inside the main application process.
- Require appropriate isolation before supporting customer backend execution.

## 10. Testing Strategy

Testing will be organized into:

- Unit tests.
- Integration tests.
- End-to-end tests.

Every feature must be tested before being considered complete.

Testing must cover validation, permissions, data isolation, error handling and regressions.

## 11. Development Principles

- Build one feature at a time.
- Plan its frontend, backend and database requirements before implementation.
- Keep files modular and focused.
- Avoid unnecessarily large files.
- Avoid repeatedly modifying central application files.
- Test each feature before moving to the next.
- Document important architecture decisions.
- Do not introduce unapproved architecture changes.

## 12. Initial Development Priority

The development order is:

1. Repository and architecture foundation.
2. Shared package contracts and conventions.
3. Authentication and account foundation.
4. D Database core features.
5. D Hosting core features.
6. Shared account and billing management.
7. Security, monitoring and deployment improvements.
8. Production readiness and controlled public launch.

DSquare WebLift will be developed separately after D Database and D Hosting are sufficiently established.
