# DSquare Platform — Authentication Architecture

## 1. Purpose

This document defines how users register, authenticate, maintain sessions, recover accounts and securely access D Database and D Hosting.

Both products will follow shared authentication standards while maintaining separate product access policies and resource boundaries.

## 2. Architecture Principles

- Authentication must be handled by trusted backend services.
- Passwords must never be stored in plain text.
- Authentication and authorization must remain separate.
- Sessions must be securely created, validated, expired and revoked.
- Sensitive authentication operations must be rate-limited.
- Account recovery must not expose whether an email address exists.
- Product and tenant boundaries must be enforced on the backend.
- Authentication secrets must never be exposed to frontend code.
- Security-sensitive events must be recorded safely.

## 3. Identity and Account Model

The platform should maintain a shared identity model.

A user identity represents one person or account holder.

A user may have access to D Database, D Hosting or both, subject to the appropriate product access and account policies.

The identity system must distinguish:

- User identity.
- Login credentials.
- Account status.
- Product access.
- Organization or tenant membership.
- Roles and permissions.
- Active sessions.
- Email verification status.

Sharing identity does not mean combining product data or automatically granting product permissions.

## 4. Registration

The registration process should support:

- Full name.
- Email address.
- Password.
- Password confirmation on the frontend.
- Acceptance of applicable terms and privacy policy.

The backend must:

- Validate all submitted information.
- Normalize email addresses consistently.
- Check for duplicate accounts.
- Apply password security requirements.
- Hash passwords using a suitable password-hashing algorithm such as Argon2id.
- Create every new account in an unverified state. Email verification is mandatory before protected product features can be accessed.
- Generate a secure verification token.
- Send a verification message.
- Avoid exposing sensitive account information.

Registration must be protected against automated abuse.

## 5. Password Security

Passwords must:

- Be stored only as secure password hashes.
- Never be logged.
- Never be returned by an API.
- Never be stored in frontend application storage.
- Be checked using the approved password-hashing library.

The platform should define reasonable password length and security requirements.

Password hashing parameters must be configurable and reviewed as security requirements evolve.

## 6. Login

The login process should:

1. Receive the submitted credentials over HTTPS.
2. Validate the request.
3. Apply rate limits.
4. Locate the account without revealing unnecessary account information.
5. Verify the password securely.
6. Check account status and applicable verification requirements.
7. Create a secure session after successful authentication.
8. Record the login event safely.
9. Return only the information required by the frontend.

Failed login responses should not reveal whether the email address or password was incorrect.

## 7. Session Management

The approved authentication approach is secure, server-managed sessions using HTTP-only cookies.

Session requirements:

- Generate unpredictable session identifiers.
- Store session records on the server.
- Use HTTPS in production.
- Set cookies with `HttpOnly`.
- Set cookies with `Secure` in production.
- Use an appropriate `SameSite` policy.
- Apply session expiration.
- Support session revocation.
- Rotate session identifiers after authentication and privilege changes.
- Prevent session fixation.
- Avoid storing session identifiers in localStorage.

The session storage mechanism must be selected before implementation.

Production session storage must not rely on an in-memory store that loses all sessions when the server restarts or runs multiple instances.

## 8. Logout

Logout must:

- Revoke the current server-side session.
- Clear the session cookie.
- Prevent reuse of the revoked session.
- Return a consistent success response.

The platform should also support logging out of all active sessions.

## 9. Password Recovery

Password recovery should follow this process:

1. User submits an email address.
2. Backend returns a generic response.
3. If an eligible account exists, generate a secure recovery token.
4. Send a recovery link through the verified communication channel.
5. Validate the token when the user opens the link.
6. Allow the user to set a new password.
7. Invalidate the recovery token after successful use.
8. Revoke existing sessions where appropriate.
9. Record the password-change event.

Recovery tokens must:

- Be unpredictable.
- Expire after a limited period.
- Be single-use.
- Be stored securely, preferably as hashes.
- Be invalidated after password changes.

## 10. Email Verification

Email verification should:

- Use secure, single-use tokens.
- Have a limited expiration period.
- Prevent token reuse.
- Support controlled resend requests.
- Rate-limit resend operations.
- Update verification status only after successful validation.

The platform must not treat an unverified email address as verified.

## 11. Multi-Factor Authentication

The architecture should allow future multi-factor authentication.

Potential methods include:

- Authenticator applications using time-based one-time passwords.
- Recovery codes.
- Additional verification for sensitive account operations.

MFA should be introduced through a dedicated security feature rather than mixed into unrelated authentication logic.

The exact methods and rollout policy will be decided before implementation.

## 12. Authorization

Authentication confirms identity.

Authorization determines what an authenticated user can access.

The authorization system must support:

- Product-level access.
- Organization or tenant membership.
- Roles.
- Permissions.
- Resource ownership.
- Account status restrictions.

All protected operations must be checked on the backend.

Frontend route guards and hidden buttons are not security controls.

## 13. Roles and Permissions

The system should distinguish:

- Platform administration permissions.
- Product administration permissions.
- Organization or tenant roles.
- Customer-level permissions.
- Module-requested permissions.
- Module permissions approved by the platform.

A module cannot grant itself permissions.

A customer cannot grant themselves platform administrator privileges.

Permissions must follow least-privilege principles.

## 14. Tenant and Organization Membership

The architecture must support users who belong to organizations or teams.

Requirements:

- A user may belong to multiple organizations where permitted.
- Membership must be explicitly established.
- Each membership has its own role and permissions.
- Organization resources must be isolated.
- Removing membership must revoke access.
- Resource ownership must be checked on every relevant operation.

A user's access to one organization must not automatically grant access to another.

## 15. Product Access

D Database and D Hosting must maintain separate product access policies.

A shared identity may authenticate to both products, but:

- Access to one product must not automatically grant access to the other.
- Each product must enforce its own permissions.
- Product-specific account restrictions must be respected.
- Product resources must remain isolated.
- Cross-product operations require explicit authorization.

## 16. Session and Account Security

The system should support:

- Viewing active sessions.
- Revoking individual sessions.
- Revoking all sessions.
- Password-change notifications.
- Suspicious login monitoring.
- Account lock or restriction policies where appropriate.
- Secure handling of account recovery.
- Reauthentication for sensitive operations where appropriate.

Temporary login restrictions must avoid creating an easy denial-of-service mechanism against other users.

## 17. CSRF, CORS and Browser Security

Where cookie-based authentication is used:

- Apply appropriate CSRF protection to state-changing requests.
- Validate request origins according to approved policies.
- Configure CORS with explicit trusted origins.
- Never use wildcard origins with credentialed requests.
- Use secure cookie attributes.
- Avoid exposing authentication cookies to JavaScript.

CORS must not be treated as a replacement for authentication or authorization.

## 18. Rate Limiting and Abuse Prevention

Apply suitable rate limits to:

- Registration.
- Login.
- Password recovery.
- Email verification.
- Verification resend.
- MFA verification.
- Session creation.
- Sensitive account changes.

The platform should also consider abuse detection and temporary restrictions.

Rate limits must be configurable and must not unnecessarily block legitimate users.

## 19. Authentication API Endpoints

Proposed initial endpoint structure:

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/v1/auth/register` | Create account |
| POST | `/api/v1/auth/login` | Authenticate |
| POST | `/api/v1/auth/logout` | End current session |
| POST | `/api/v1/auth/logout-all` | Revoke all sessions |
| GET | `/api/v1/auth/me` | Retrieve current user |
| POST | `/api/v1/auth/forgot-password` | Request recovery |
| POST | `/api/v1/auth/reset-password` | Set new password |
| POST | `/api/v1/auth/verify-email` | Verify email |
| POST | `/api/v1/auth/resend-verification` | Resend verification |
| GET | `/api/v1/auth/sessions` | List active sessions |
| DELETE | `/api/v1/auth/sessions/:sessionId` | Revoke a session |
| POST | `/api/v1/auth/change-password` | Change password |

These endpoints are proposed conventions. Their final request and response contracts must be defined before implementation.

## 20. Audit Logging

Record important security events, including:

- Successful login.
- Failed login.
- Logout.
- Password changes.
- Password recovery.
- Email verification.
- Session revocation.
- MFA changes.
- Account restrictions.
- Sensitive permission changes.

Logs must not contain passwords, recovery tokens, session identifiers or other secrets.

Audit records must have appropriate access restrictions and retention policies.

## 21. Authentication Failure Handling

The system must handle:

- Invalid credentials.
- Unverified accounts.
- Disabled or restricted accounts.
- Expired sessions.
- Revoked sessions.
- Expired recovery tokens.
- Invalid verification tokens.
- Rate-limit violations.
- Authentication service failures.

Responses must be consistent and must not reveal sensitive internal information.

## 22. Testing Requirements

Tests must cover:

- Registration validation.
- Duplicate account handling.
- Password hashing.
- Login success and failure.
- Session creation.
- Session expiration.
- Session revocation.
- Logout.
- Password recovery.
- Email verification.
- Rate limiting.
- CSRF protection.
- CORS configuration.
- Product access isolation.
- Tenant isolation.
- Permission enforcement.
- Account restrictions.
- Security event logging.

Security tests must verify that revoked or unauthorized sessions cannot access protected resources.

## 23. Implementation Order

1. Define identity and account types.
2. Define password security standards.
3. Define registration and verification flows.
4. Define login and session contracts.
5. Define logout and session revocation.
6. Define password recovery.
7. Define authorization and permission integration.
8. Define tenant and organization membership.
9. Define product access policies.
10. Define security event logging.
11. Implement authentication APIs.
12. Test authentication and authorization across both products.

## 24. Specification Status

This document is an approved authentication architecture baseline.

Before implementation, review:

- Identity model.
- Password security.
- Session storage and cookie policy.
- Account recovery.
- Email verification.
- MFA strategy.
- Authorization.
- Tenant isolation.
- Product access boundaries.
- CSRF and CORS.
- Rate limiting.
- Audit logging.

Implementation must not begin until the architecture is reviewed and approved.

## 25. Final Rule

Authentication establishes identity.

Authorization controls access.

The platform must enforce both securely on the backend while preserving independent product and tenant boundaries.


## 26. Approved Authentication Decisions

The following decisions have been explicitly approved and are binding architectural requirements.

### 26.1 Shared DSquare Account

- Users have one shared DSquare identity.
- The same account credentials can be used to authenticate to D Database and D Hosting.
- Users must not create separate identities simply to use both products.
- Product access must be granted and managed independently.
- Access to one product does not automatically grant access to the other.
- Product-specific permissions, resources and account restrictions remain independent.

### 26.2 Server-Managed Sessions

- Authentication will use server-managed sessions.
- Browser sessions will use secure HTTP-only cookies.
- Session records will be stored server-side using an appropriate persistent session store.
- Sessions must support expiration, rotation and revocation.
- Users must be able to view and revoke their active sessions.
- Session identifiers must never be stored in localStorage.
- Production session storage must support multiple backend instances where required.

### 26.3 Mandatory Email Verification

- Every newly registered account must begin in an unverified state.
- Users must verify their email address before accessing protected product features.
- Users may access the necessary registration and verification flows while unverified.
- Verification tokens must be secure, single-use and time-limited.
- Resending verification messages must be rate-limited.
- Verification status must be enforced by the backend.
- Frontend verification checks must never replace backend enforcement.

### 26.4 Decision Authority

These three decisions override any earlier wording in this document that describes them as optional, tentative or merely preferred.

They must be preserved during implementation unless a future architecture change is explicitly reviewed and approved.


