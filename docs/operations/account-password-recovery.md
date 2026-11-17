# DSquare account password recovery

D Hosting and D Database keep separate user tables and sign-in sessions. A password change or reset in one product does not change the password in the other product.

## Change a password

A signed-in user can open **Settings → Change password** in either dashboard. The API verifies the current password, enforces the 12–256 character policy, updates the password hash, revokes all existing sessions, and issues a replacement session to the current browser.

## Forgot password

Each product has its own password-reset token table and reset endpoints. Tokens are generated from cryptographically secure random bytes, only their SHA-256 hashes are stored, and they expire after 30 minutes. A token can be used once. Completing a reset revokes every existing session for that product.

The public request endpoint returns the same success message whether or not the email exists. The raw token is sent only in the reset email and is never returned by the API or written to application logs.

## Email delivery configuration

The reset request is intentionally disabled until email delivery is configured on **both** trusted server environments. Set these environment variables on the D Hosting server and separately on the D Database server:

- `RESEND_API_KEY`: private Resend API key with permission to send email.
- `DSQUARE_ACCOUNT_EMAIL_FROM`: sender address on a domain verified with Resend, for example `DSquare Accounts <accounts@example.com>`.

Each product also uses its existing `D_HOSTING_APP_ORIGIN` or `D_DATABASE_APP_ORIGIN` value to build its own reset link. Do not put any of these values in frontend environment variables or commit real values to Git.

If the email provider is not configured, the API responds with a clear service-unavailable message and does not create a reset token. Password changes for signed-in users continue to work.

The email delivery adapter is isolated in the auth route so it can later be replaced with a first-party DSquare mail service without changing the password-token or account-security design.
