# DSquare Platform — Module Manifest Specification

## 1. Purpose

Every application module must contain a module.json manifest.

The manifest identifies the module, declares its product ownership, describes its entry points and lists its dependencies and requested permissions.

Both D Database and D Hosting must follow this specification.

## 2. Manifest Format

The manifest format is JSON.

Filename:

module.json

## 3. Standard Manifest Example

{
  "id": "database.projects",
  "name": "Projects",
  "version": "1.0.0",
  "description": "Manages database projects.",
  "product": "d-database",
  "entry": {
    "backend": "backend/module.ts",
    "frontend": "frontend"
  },
  "migrations": "database/migrations",
  "dependencies": [],
  "permissions": [
    "projects.read",
    "projects.create",
    "projects.update",
    "projects.delete"
  ]
}

## 4. Field Specifications

### id

- Required.
- Globally unique across the DSquare Platform.
- Must remain stable after publication.
- Must follow an approved naming convention.
- Example: database.projects.

### name

- Required.
- Human-readable module name.
- Example: Projects.

### version

- Required.
- Must follow semantic versioning.
- Format: MAJOR.MINOR.PATCH.
- Example: 1.0.0.

### description

- Required.
- Briefly describes the module's purpose.

### product

- Required.
- Identifies the owning product.
- Allowed values:
  - d-database
  - d-hosting

### entry

Required object describing module entry points.

Backend:
- Identifies the backend module entry point.
- Must resolve inside the approved module directory.

Frontend:
- Identifies the frontend module directory or approved page discovery location.
- Must resolve inside the approved module directory.

### migrations

- Identifies the module's migration directory.
- Must resolve inside the approved module directory.
- Migrations must be discovered and reviewed separately from execution.

### dependencies

- Required array.
- Lists approved shared packages or other approved module dependencies.
- Dependencies must be validated before registration.
- Missing or incompatible dependencies must prevent activation.

### permissions

- Required array.
- Lists permissions requested by the module.
- Every permission must use an approved permission identifier.
- Requested permissions do not automatically become granted permissions.

## 5. Security and Approval

The manifest is descriptive metadata, not a security authority.

The following rules are mandatory:

- A module cannot approve itself.
- Approval status must be stored in a trusted platform registry.
- Requested permissions must be independently reviewed and granted.
- Modules must not grant themselves additional capabilities.
- Unknown fields must be rejected or handled according to a strict schema version policy.
- Entry paths must be validated against path traversal.
- Files must be checked against approved module boundaries.
- Unapproved modules must never be loaded.

## 6. Validation Requirements

Before registration, the platform must validate:

1. JSON syntax.
2. Required fields.
3. Field data types.
4. Unique module identifier.
5. Product ownership.
6. Semantic version format.
7. Entry point paths.
8. Migration directory.
9. Dependency identifiers and compatibility.
10. Requested permission identifiers.
11. Manifest schema compatibility.
12. Module approval status from the trusted registry.

Invalid manifests must be rejected with useful error messages.

## 7. Module Identity and Versioning

Module identifiers are permanent.

Changing a module's display name does not change its identifier.

Module versions must follow semantic versioning:

- MAJOR: Incompatible changes.
- MINOR: Backward-compatible functionality.
- PATCH: Backward-compatible fixes.

Already published versions must not be silently replaced.

## 8. Future Compatibility

The specification may be extended through deliberate architecture review.

Changes must consider existing modules, compatibility, migration requirements and security.

## 9. Final Rule

Every module must provide a valid module.json manifest.

The platform controls module approval, permission grants, registration and activation independently of the manifest.
