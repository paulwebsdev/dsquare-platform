# DSquare Platform — Module Contract Specification

## 1. Purpose

This document defines the proposed TypeScript interfaces, function signatures, inputs, outputs and responsibilities of the shared module contracts.

It builds on:
- architecture/module-contracts.md
- architecture/module-system.md
- architecture/module-manifest.md
- decisions/001-shared-module-architecture.md

The specification applies to D Database and D Hosting.

Each product maintains its own module registry, resources, permissions and configuration.

## 2. General TypeScript Rules

- Use TypeScript strict mode.
- Prefer explicit types over `any`.
- Use asynchronous functions for operations involving external services or initialization.
- Use readonly properties for metadata that must not change after validation.
- Validate all untrusted input at system boundaries.
- Never trust frontend permissions as backend authorization.
- Avoid exposing internal platform implementation details to modules.
- Use typed errors for predictable failure handling.
- Keep interfaces focused on one responsibility.

## 3. Common Types

The contracts should define these foundational types:

```ts
type ProductId = "d-database" | "d-hosting";

type ModuleId = string;

type ContractVersion = string;

type SemanticVersion = string;

type PermissionId = string;

type DependencyId = string;

type ModuleStatus =
  | "discovered"
  | "validated"
  | "approved"
  | "dependencies-resolved"
  | "initialized"
  | "registered"
  | "active"
  | "shutting-down"
  | "stopped"
  | "failed";
```

These types must be validated where values originate from manifests or external sources.

## 4. ModuleMetadata

Purpose: represent validated module information.

Proposed interface:

```ts
interface ModuleMetadata {
  readonly id: ModuleId;
  readonly name: string;
  readonly version: SemanticVersion;
  readonly description: string;
  readonly product: ProductId;
  readonly contractVersion: ContractVersion;
  readonly dependencies: readonly ModuleDependency[];
  readonly requestedPermissions: readonly PermissionId[];
}
```

Rules:
- Metadata must come from a validated manifest and trusted platform records.
- A module cannot modify its validated identity.
- The product identifier must match the owning product.
- Requested permissions must not be treated as granted permissions.

## 5. ModuleDefinition

Purpose: define the implementation provided by a module.

Proposed interface:

```ts
interface ModuleDefinition {
  readonly metadata: ModuleMetadata;

  initialize(context: ModuleContext): Promise<void>;

  registerRoutes(registrar: RouteRegistrar): Promise<void>;

  shutdown?(context: ModuleContext): Promise<void>;
}
```

Rules:
- Initialization must complete before route registration.
- The engine controls when lifecycle methods are called.
- Shutdown is optional but must be supported when a module owns resources.
- A module must not activate itself.
- A failed initialization must trigger cleanup and prevent activation.

## 6. ModuleContext

Purpose: provide restricted platform capabilities.

Proposed interface:

```ts
interface ModuleContext {
  readonly module: ModuleMetadata;

  readonly logger: ModuleLogger;

  readonly config: ModuleConfig;

  readonly permissions: PermissionChecker;

  readonly services: ApprovedServiceResolver;

  readonly events: ModuleEventPublisher;

  readonly resources: ModuleResourceAccess;
}
```

Each capability must have its own focused interface.

### 6.1 ModuleLogger

```ts
interface ModuleLogger {
  debug(message: string, details?: Readonly<Record<string, unknown>>): void;
  info(message: string, details?: Readonly<Record<string, unknown>>): void;
  warn(message: string, details?: Readonly<Record<string, unknown>>): void;
  error(message: string, details?: Readonly<Record<string, unknown>>): void;
}
```

Secrets, passwords, tokens and private credentials must never be logged.

### 6.2 ModuleConfig

```ts
interface ModuleConfig {
  get<T>(key: string): T | undefined;
  require<T>(key: string): T;
}
```

Modules may access only configuration explicitly made available to them.

### 6.3 PermissionChecker

```ts
interface PermissionChecker {
  has(permission: PermissionId): Promise<boolean>;

  require(permission: PermissionId): Promise<void>;
}
```

The platform performs authoritative permission checks.

### 6.4 ApprovedServiceResolver

```ts
interface ApprovedServiceResolver {
  resolve<T>(serviceId: string): T;
}
```

Only explicitly approved services may be resolved. The platform must validate service availability and module access before returning a service.

### 6.5 ModuleEventPublisher

```ts
interface ModuleEventPublisher {
  publish<T>(eventName: string, payload: T): Promise<void>;
}
```

Event publishing must follow approved event policies and must not expose unauthorized product data.

### 6.6 ModuleResourceAccess

```ts
interface ModuleResourceAccess {
  get<T>(resourceId: string): Promise<T | undefined>;

  create<T>(resourceId: string, value: T): Promise<void>;

  update<T>(resourceId: string, value: T): Promise<void>;

  delete(resourceId: string): Promise<void>;
}
```

Resource access must be scoped to the module and owning product.

These operations must not expose unrestricted filesystem or database access.

## 7. RouteRegistrar

Purpose: allow controlled HTTP route registration.

Proposed interface:

```ts
type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE";

interface RouteDefinition {
  readonly method: HttpMethod;
  readonly path: string;
  readonly authenticationRequired: boolean;
  readonly permissions: readonly PermissionId[];
  readonly rateLimit?: RouteRateLimit;
  readonly handler: RouteHandler;
}

interface RouteRateLimit {
  readonly limit: number;
  readonly windowSeconds: number;
}

interface RouteRegistrar {
  register(route: RouteDefinition): void;
}
```

The route handler must use a controlled request and response abstraction rather than exposing the complete Express application.

Proposed handler:

```ts
type RouteHandler = (
  request: ModuleRequest,
  response: ModuleResponse
) => Promise<void>;
```

The exact request and response interfaces will be finalized in the API architecture specification.

Rules:
- All routes must pass through central authentication, authorization, validation and error middleware.
- Route paths must be validated.
- Duplicate route conflicts must be rejected.
- Permissions must be checked server-side.
- Modules cannot bypass security middleware.
- Rate limits must be validated by the platform.

## 8. PermissionRequirement

Purpose: describe permissions required by a module.

Proposed interface:

```ts
interface PermissionRequirement {
  readonly id: PermissionId;
  readonly description: string;
  readonly requiredForActivation: boolean;
}
```

Rules:
- Permission IDs must follow the approved naming convention.
- Requested permissions are declared in module metadata.
- The platform independently approves or rejects requests.
- A module cannot grant permissions to itself.
- Customer access permissions remain separate from module approval.

## 9. ModuleDependency

Purpose: describe dependencies on approved modules or shared packages.

Proposed interface:

```ts
type DependencyType = "module" | "package";

interface ModuleDependency {
  readonly id: DependencyId;
  readonly type: DependencyType;
  readonly versionRange: string;
}
```

The engine must:
- Check whether dependencies exist.
- Validate compatible versions.
- Reject unapproved dependencies.
- Detect circular dependencies.
- Resolve dependencies before initialization.

## 10. ModuleLifecycle

Purpose: control module state transitions.

Proposed interface:

```ts
interface ModuleLifecycleController {
  getStatus(moduleId: ModuleId): ModuleStatus | undefined;

  start(moduleId: ModuleId): Promise<void>;

  stop(moduleId: ModuleId): Promise<void>;
}
```

Rules:
- Lifecycle transitions are controlled by the engine.
- Modules cannot directly change their own status.
- Invalid transitions must be rejected.
- Failed modules must not leave active routes or resources.
- Shutdown must release resources owned by the module.

## 11. ModuleRegistry

Purpose: manage modules belonging to one product.

Proposed interface:

```ts
interface ModuleRegistry {
  readonly product: ProductId;

  get(moduleId: ModuleId): ModuleDefinition | undefined;

  list(): readonly ModuleMetadata[];

  register(module: ModuleDefinition): Promise<void>;

  unregister(moduleId: ModuleId): Promise<void>;
}
```

Rules:
- Each product has its own registry instance.
- Duplicate module IDs must be rejected.
- Only approved and validated modules may be registered.
- Dependencies and contract compatibility must be checked.
- Registration must not automatically grant permissions.
- Registry operations must be controlled by trusted platform code.
- Modules must not receive unrestricted access to registry internals.

The shared engine may implement the registry mechanism, but it must preserve product separation.

## 12. Frontend Page Contract

Purpose: define pages supplied by approved frontend modules.

Proposed interface:

```ts
interface ModulePageDefinition {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly requiresAuthentication: boolean;
  readonly permissions: readonly PermissionId[];
  readonly navigation?: {
    readonly label: string;
    readonly group?: string;
    readonly order?: number;
  };
  readonly component: React.ComponentType;
}
```

Rules:
- Frontend discovery must only load approved module pages.
- Page IDs and paths must be unique within the product.
- Pages may declare authentication and permission requirements.
- Frontend checks are for user experience only.
- Backend authorization remains authoritative.
- Product frontend registries must remain independent.

## 13. Typed Module Errors

The engine should provide a common base error:

```ts
class ModuleError extends Error {
  readonly code: string;
  readonly moduleId?: ModuleId;

  constructor(
    code: string,
    message: string,
    moduleId?: ModuleId
  ) {
    super(message);
    this.name = "ModuleError";
    this.code = code;
    this.moduleId = moduleId;
  }
}
```

Expected error categories include:
- INVALID_METADATA
- INVALID_DEFINITION
- MODULE_NOT_APPROVED
- CONTRACT_VERSION_MISMATCH
- DUPLICATE_MODULE
- MISSING_DEPENDENCY
- INCOMPATIBLE_DEPENDENCY
- CIRCULAR_DEPENDENCY
- PERMISSION_DENIED
- ROUTE_CONFLICT
- INITIALIZATION_FAILED
- SHUTDOWN_FAILED
- INVALID_LIFECYCLE_TRANSITION

Errors must not expose credentials, secrets or sensitive internal information.

## 14. Contract Validation

Before registration, the engine must validate:

1. Module manifest structure.
2. Module identity and product ownership.
3. Semantic version.
4. Contract version compatibility.
5. Entry-point locations.
6. Dependency declarations.
7. Requested permissions.
8. Trusted approval status.
9. Module definition structure.
10. Required capabilities.

Invalid modules must be rejected before activation.

## 15. Product Isolation

The contracts and engine must enforce:

- D Database modules cannot automatically access D Hosting resources.
- D Hosting modules cannot automatically access D Database resources.
- Each product has its own registry.
- Each product has its own module permissions.
- Each product has its own configuration and resource boundaries.
- Shared packages may provide common mechanisms without combining product data.

Any future cross-product communication must use an explicitly approved and authorized integration.

## 16. Failure and Cleanup Rules

If module initialization fails:
- Do not activate the module.
- Do not leave its routes registered.
- Release resources created during initialization where possible.
- Record a safe diagnostic error.
- Keep unrelated modules operational where possible.

If shutdown fails:
- Record the failure.
- Continue attempting cleanup of other modules.
- Do not falsely report a successful shutdown.

## 17. Testing Requirements

Tests must cover:

- Type correctness.
- Metadata validation.
- Contract version compatibility.
- Restricted context capabilities.
- Permission checks.
- Route registration and conflicts.
- Dependency resolution.
- Circular dependency detection.
- Lifecycle transitions.
- Initialization failure and cleanup.
- Shutdown failure.
- Frontend page validation.
- Product isolation.
- Unauthorized service access.
- Registry duplicate prevention.

## 18. Implementation Order

1. Create foundational shared types.
2. Define ModuleMetadata.
3. Define ModuleDefinition.
4. Define ModuleContext and capability interfaces.
5. Define permission interfaces.
6. Define route contracts.
7. Define dependency contracts.
8. Define lifecycle contracts.
9. Define registry contracts.
10. Define frontend page contracts.
11. Define typed errors.
12. Implement validators.
13. Write contract tests.
14. Integrate the sample module in D Database.
15. Integrate the sample module in D Hosting.

## 19. Specification Status

This document is a proposed technical specification.

Before implementation, review:
- Interface responsibilities.
- Type safety.
- Security boundaries.
- Product isolation.
- Lifecycle behavior.
- Error handling.
- Compatibility with the existing architecture.

Implementation must not begin until the specification is reviewed and approved.

## 20. Final Rule

The contracts define what modules are allowed to do and how they communicate with the platform.

The engine remains responsible for validation, approval, permissions, dependencies, registration and lifecycle control.

No module may grant itself authority or bypass the platform's security boundaries.


## 21. Binding Contract Corrections

This section contains mandatory corrections to the proposed interfaces above.

Where an earlier proposed interface conflicts with this section, this section takes precedence.

### 21.1 Configuration Must Be Schema-Validated

The generic ModuleConfig methods proposed in Section 6.2 must not be implemented as unrestricted generic getters.

Requirements:

- Every module configuration value must have a declared schema.
- Configuration must be validated before it is made available to a module.
- Required configuration must fail clearly when missing or invalid.
- Optional configuration must have explicitly defined behavior.
- Secrets must be protected and never exposed through ordinary configuration logging.
- Modules must only access configuration assigned to them.

The implementation must use typed, schema-validated configuration access rather than allowing callers to assume arbitrary types.

### 21.2 Services Must Use an Approved Typed Registry

The generic ApprovedServiceResolver.resolve<T>() method proposed in Section 6.4 must not allow arbitrary type assertions.

Requirements:

- Services must be registered by trusted platform code.
- Every service must have a defined contract and version.
- Each service must have an explicit access policy.
- A module may only resolve services approved for that module and product.
- Missing, incompatible or unauthorized services must fail safely.
- Services must not expose unrestricted database, filesystem, process or cross-product access.

The implementation must use approved typed service definitions and controlled resolution.

### 21.3 Resource Access Must Enforce Ownership and Isolation

The ModuleResourceAccess interface proposed in Section 6.6 requires stronger authorization rules.

Every resource operation must enforce:

- Owning product.
- Owning module where applicable.
- Tenant or customer ownership.
- Explicit permission requirements.
- Resource type and operation authorization.
- Resource existence and valid state.

Resource identifiers alone must never establish authorization.

A module must not access another tenant's resources by guessing or supplying an identifier.

Cross-product access must require an explicitly approved integration.

### 21.4 Registry Access Must Not Expose Internal Implementations

The ModuleRegistry.get() method proposed in Section 11 must not expose unrestricted ModuleDefinition implementations.

Requirements:

- Public registry lookup must return safe, read-only metadata or a controlled reference.
- Internal module implementations must remain under engine control.
- Only trusted platform code may register or unregister modules.
- Modules must not modify another module's definition, lifecycle or registry records.
- Registry operations must preserve independent product boundaries.

### 21.5 Route Registration Must Require Request Validation

The RouteDefinition proposed in Section 7 must include an explicit request validation contract.

Requirements:

- Route parameters, query values and request bodies must be validated using approved schemas.
- Validation must occur before the handler processes untrusted input.
- Invalid input must produce a consistent client error.
- Authentication and authorization must be enforced centrally.
- Permission checks must happen on the backend.
- Rate limits must be validated and enforced centrally.
- Route conflicts must be rejected.
- Modules must not bypass the central middleware pipeline.

The final request and response types must align with the API architecture specification.

### 21.6 Lifecycle Operations Must Be Safe Under Concurrency

The ModuleLifecycleController proposed in Section 10 must enforce valid state transitions.

Requirements:

- Only the engine may change lifecycle state.
- Concurrent start and stop requests must be coordinated.
- Duplicate initialization must not occur.
- Invalid transitions must be rejected.
- Failed initialization must trigger controlled cleanup.
- Partially registered routes and resources must be rolled back.
- Shutdown must attempt cleanup even when individual cleanup operations fail.
- The engine must accurately record the final lifecycle state.
- Failed modules must not be reported as active.

Lifecycle operations must be predictable and safe during startup, shutdown and failure recovery.

### 21.7 Frontend Pages Must Use Controlled Lazy Loading

The ModulePageDefinition proposed in Section 12 must not use an unrestricted component contract.

Requirements:

- Pages must have a defined props contract.
- Approved pages must be loaded through controlled lazy-loading mechanisms.
- Page IDs and route paths must be validated and unique within their product.
- Only approved frontend module locations may be discovered.
- Navigation metadata must be validated.
- Frontend permission checks must never replace backend authorization.
- Unapproved modules must never become loadable merely because a page file exists.

### 21.8 Tenant Isolation Is Mandatory

Tenant isolation must apply across all module capabilities, not only resource access.

Requirements:

- Every customer-owned resource must have an authoritative ownership relationship.
- Tenant context must be established by trusted backend authentication and authorization mechanisms.
- Modules must not choose or override their own tenant identity.
- Every resource query and operation must enforce tenant ownership.
- Background jobs and asynchronous events must preserve tenant context.
- Cross-tenant access must be denied unless an explicitly authorized platform operation permits it.
- Tenant isolation must be tested for every relevant product capability.

Frontend filtering is never sufficient for tenant isolation.

### 21.9 Capability and Permission Enforcement

Module approval, requested permissions and customer authorization are separate concepts.

- Module approval determines whether a module is trusted to run.
- Requested permissions describe the capabilities a module needs.
- Platform approval determines which capabilities the module may receive.
- Customer authorization determines what the authenticated customer may do.
- Tenant ownership determines which customer resources may be accessed.

No module may grant itself permissions, bypass customer authorization or expand its approved capabilities.

### 21.10 Contract Compatibility

- Shared contract changes must be versioned.
- Breaking changes require an explicit compatibility review.
- Product modules must declare compatible contract versions.
- Incompatible modules must be rejected before activation.
- Existing modules must not silently receive broader capabilities after a contract update.

### 21.11 Final Authority

The shared module engine is responsible for enforcing module approval, capability access, permissions, tenant isolation, product boundaries, dependency resolution, route registration and lifecycle transitions.

TypeScript interfaces alone do not provide security. Every security requirement must also be enforced by runtime validation and trusted backend controls.

These corrections are mandatory before implementation.

