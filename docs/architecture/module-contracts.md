# DSquare Platform — Shared TypeScript Module Contracts

## 1. Purpose

This document defines the TypeScript contracts that application modules must follow.

D Database and D Hosting will use the same shared contract standards while maintaining independent module registries and product resources.

## 2. Contract Design Principles

- Every module must implement the approved module contract.
- Each contract must have one clear responsibility.
- Modules must receive only authorized platform capabilities.
- Modules must not receive unrestricted access to the Express application or database connections.
- Product boundaries must be enforced by the engine.
- Contracts must be versioned and validated.
- Breaking contract changes require deliberate compatibility review.

## 3. Core Contracts

The shared contracts will include:

- ModuleDefinition
- ModuleContext
- ModuleRegistry
- RouteRegistrar
- PermissionRequirement
- ModuleDependency
- ModuleLifecycle
- ModuleMetadata

Each contract must remain focused on its responsibility.

## 4. ModuleMetadata

Describes the validated identity of a module.

It should contain:

- Unique module ID.
- Module name.
- Semantic version.
- Description.
- Owning product.
- Validated entry-point information.
- Declared dependencies.
- Requested permissions.

Metadata must originate from a validated manifest and trusted platform records.

## 5. ModuleDefinition

Defines the module implementation.

It should provide:

- Module metadata.
- Initialization behavior.
- Route registration behavior.
- Optional shutdown behavior.
- Declared dependencies.
- Required platform capabilities.

The module definition must follow the shared contract version supported by the engine.

## 6. ModuleContext

Provides approved services to a module during initialization.

Possible capabilities include:

- Structured logging.
- Configuration access.
- Permission checking.
- Approved service access.
- Controlled event publishing.
- Module-specific resource access.

The context must be restricted to the owning product.

Modules must not automatically receive:

- Administrator database credentials.
- Unrestricted database connections.
- Unrestricted filesystem access.
- Arbitrary process execution.
- Unrestricted access to other product services.
- Direct control of the complete Express application.

Sensitive operations must pass through authorized platform services.

## 7. RouteRegistrar

Provides a controlled API for registering module routes.

It should support:

- HTTP methods.
- Validated route paths.
- Approved request handlers.
- Authentication requirements.
- Permission requirements.
- Request validation.
- Rate-limit configuration where appropriate.

All module routes must pass through the product's central API security middleware.

Modules must not bypass authentication, authorization, validation or error handling.

Route conflicts must be detected before activation.

## 8. PermissionRequirement

Describes the permissions a module requests for its operations.

Requirements:

- Permission identifiers must follow an approved naming convention.
- Permissions must be declared before module activation.
- The platform must independently grant permissions.
- Permissions must be checked server-side.
- A module cannot grant permissions to itself.
- Customer-level permissions must remain separate from module approval.

Requested permissions are not automatically granted permissions.

## 9. ModuleDependency

Defines dependencies on shared packages or other approved modules.

It should identify:

- Dependency ID.
- Required version or compatible version range.
- Dependency type.

The engine must detect:

- Missing dependencies.
- Incompatible versions.
- Circular dependencies.
- Unapproved dependencies.

Dependencies must be resolved before module activation.

## 10. ModuleLifecycle

Defines the lifecycle of a module.

Supported lifecycle stages should include:

1. Discovered.
2. Validated.
3. Approved.
4. Dependencies resolved.
5. Initialized.
6. Registered.
7. Active.
8. Shutting down.
9. Stopped.
10. Failed.

Initialization and shutdown must be controlled by the engine.

A failed module must not leave partially registered routes or resources active.

## 11. ModuleRegistry

Manages modules belonging to one product.

Responsibilities include:

- Registering approved modules.
- Preventing duplicate module IDs.
- Checking compatibility.
- Tracking module lifecycle state.
- Resolving dependencies.
- Preventing unauthorized registration.
- Supporting controlled shutdown.
- Reporting registration failures.

D Database and D Hosting must have independent registries.

The shared engine may implement the registry mechanism, but it must not combine product-specific module records or permissions.

## 12. Error Handling

The contract system must support consistent errors for:

- Invalid module definitions.
- Invalid metadata.
- Missing capabilities.
- Permission failures.
- Dependency failures.
- Route conflicts.
- Initialization failures.
- Shutdown failures.

Errors must not expose credentials, tokens or other secrets.

## 13. Frontend Contract Compatibility

Frontend modules must follow a separate approved page contract.

The frontend contract should define:

- Page identity.
- Route path.
- Page component.
- Authentication requirements.
- Permission requirements.
- Navigation metadata where applicable.

Frontend page discovery must not be treated as an authorization mechanism.

The backend remains the authority for access control.

## 14. Contract Versioning

Shared contracts must have explicit versions.

The engine must reject incompatible module contract versions.

Breaking changes require:

- Architecture review.
- Compatibility assessment.
- Updated tests.
- Migration planning where necessary.
- Deliberate approval.

## 15. Testing Requirements

The contracts and engine must be tested for:

- Valid module definitions.
- Invalid module definitions.
- Context capability restrictions.
- Product isolation.
- Permission enforcement.
- Route registration.
- Route conflicts.
- Dependency resolution.
- Lifecycle transitions.
- Initialization failure.
- Shutdown behavior.
- Contract version compatibility.

## 16. Implementation Order

1. Define TypeScript contract types.
2. Define module lifecycle states.
3. Define the restricted ModuleContext.
4. Define the RouteRegistrar interface.
5. Define the permission contract.
6. Define dependency resolution.
7. Define the product-specific ModuleRegistry.
8. Implement contract validation.
9. Write unit and integration tests.
10. Test with sample modules from both products.

## 17. Final Rule

The shared contracts define how modules communicate with the platform.

The engine controls discovery, approval, permissions, registration and lifecycle.

Modules must only receive the capabilities explicitly granted to them.
