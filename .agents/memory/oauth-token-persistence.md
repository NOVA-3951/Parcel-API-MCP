---
name: OAuth token persistence
description: How and why OAuth tokens are persisted in PostgreSQL so MCP clients survive server restarts
---

Registered OAuth clients, access tokens, and refresh tokens are stored in Replit's built-in PostgreSQL database via the `pg` Pool. Authorization codes and pending authorizations remain in memory (10-minute TTL, single-use — not worth persisting).

**Why:** In-memory storage caused Smithery/Claude/Cursor to lose their sessions on every redeploy. PostgreSQL persistence lets connected clients keep working across restarts with no re-login.

**How to apply:**
- `PgClientsStore` replaces the old `InMemoryClientsStore` — `getClient()` and `registerClient()` are now async and must be awaited at call sites.
- `issueTokens()` is now async (inserts into DB); all callers must `await` it.
- `exchangeRefreshToken()`, `verifyAccessToken()`, and `revokeToken()` query PostgreSQL directly.
- `cleanup()` fires fire-and-forget `DELETE WHERE expires_at < NOW()` on both token tables.
- Tables: `oauth_clients`, `oauth_access_tokens`, `oauth_refresh_tokens` (all in the default `replit_database`).
- The `DATABASE_URL` env var (provided automatically by Replit) is used for the pg connection string.
- The consent route `/auth/consent` (GET) must be `async` because it now awaits `clientsStore.getClient()`.
