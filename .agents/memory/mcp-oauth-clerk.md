---
name: MCP OAuth via Clerk
description: Durable security decisions for gating an HTTP MCP server behind Clerk auth with an explicit consent step
---
The MCP endpoint is protected per the MCP authorization spec: the app is its own OAuth 2.1 AS (SDK `mcpAuthRouter` + in-memory `ClerkAuthOAuthProvider`), and `/authorize` defers to Clerk sign-in + an explicit consent step before issuing codes.

**Why:** MCP clients need DCR + PKCE against a local AS whose login step is Clerk, since MCP clients can't authenticate directly.

**Key security decisions (durable):**

1. **Explicit consent page before code issuance.** The original Replit Auth flow auto-completed authorization after login. With open DCR (any client can register), an attacker could trick an authenticated user into auto-approving a malicious client's authorization. A consent page at `/auth/consent` shows the client name/scopes and requires the user to click Approve.

2. **CSRF protection on the consent POST.** A per-request cryptographically random CSRF token is set in an `HttpOnly; SameSite=Strict; Secure` cookie and embedded as a hidden form field (double-submit cookie pattern). The POST handler validates both match before proceeding, and clears the cookie after one use. An Origin check is also applied.

3. **Host allowlist for key derivation.** `publishableKeyFromHost` is only called with `X-Forwarded-Host`/`Host` values that appear in the `REPLIT_DOMAINS` env var allowlist. Unrecognized hosts fall back to the first configured domain, preventing a spoofed host from selecting a different Clerk key.

4. **Cancel pending on deny.** `provider.cancelAuthorization(pendingId)` is called on user deny so the pending entry is immediately deleted rather than waiting for TTL expiry.

5. **Production predicate consistency.** Both `clerkProxyMiddleware` and the Clerk-JS URL in `/auth/login` use `REPLIT_DOMAINS` (not `NODE_ENV`) as their production signal so they stay in sync.

**How to apply:**
- Login → consent → approval creates the code; `clerkMiddleware` + `getAuth()` validates the session at the consent step.
- `sessionClaims.userId` is used for all identity lookups (migrated Replit Auth subject ID preserved as Clerk externalId for existing users; Clerk native ID for new users).
- Any change to the consent flow must preserve all three: Origin check, CSRF double-submit, and `cancelAuthorization` on deny.
