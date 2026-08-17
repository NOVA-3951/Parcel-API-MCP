# Parcel MCP Server - Replit Project

## Overview
An HTTP MCP (Model Context Protocol) server for the Parcel delivery tracking API, hosted on Replit. Access to the MCP endpoint is restricted via OAuth 2.1: MCP clients complete an OAuth flow whose login step is Clerk, so only authenticated users can obtain tokens and use the tools.

## Architecture

### Project Structure
```
/
├── src/
│   ├── index.ts                          # Express app: MCP endpoint, OAuth router, login routes, landing page
│   ├── oauthProvider.ts                  # In-memory OAuth 2.1 authorization server provider (codes/tokens/DCR)
│   ├── middlewares/
│   │   └── clerkProxyMiddleware.ts       # Clerk Frontend API proxy (production only)
│   └── parcelServer.ts                   # Parcel MCP tools (McpServer factory)
├── dist/                                 # Compiled JavaScript (generated)
├── package.json
├── tsconfig.json
└── README.md
```

### Technology Stack
- Node.js 20, TypeScript, Express 5
- @modelcontextprotocol/sdk (Streamable HTTP transport + auth router/bearer middleware)
- @clerk/express + @clerk/shared for Clerk authentication
- http-proxy-middleware for Clerk Frontend API proxy (production)

### Request flow
1. MCP client hits `POST /mcp` → 401 with `WWW-Authenticate` → discovers metadata at `/.well-known/...`
2. Client registers via `/register` (DCR), starts `/authorize` with PKCE
3. `/authorize` stores a pending request and redirects to `/auth/login` → Clerk sign-in page
4. `/auth/callback` reads the Clerk session (via `clerkMiddleware` + `getAuth`), issues an auth code bound to the user, redirects back to the client
5. Client exchanges the code at `/token` for bearer + refresh tokens; `/mcp` requires the bearer token
6. `/mcp` runs in stateless mode: fresh McpServer + transport per request

### State & limitations
- Clients, codes, and tokens are in-memory: restarts/redeploys force MCP clients to silently re-authenticate (they handle the 401). Reserved VM deployment recommended over autoscale with >1 instance.
- By default any authenticated user may connect; set the `ALLOWED_REPLIT_USERS` env var (comma-separated user IDs or emails) to restrict access. For users migrated from Replit Auth, their original Replit user ID is preserved as the Clerk external ID and surfaced via `sessionClaims.userId`. The allow-list is re-checked on every token verification.

## Configuration (Replit Secrets)
- `PARCEL_API_KEY` — server-side Parcel API key, never exposed to clients
- `CLERK_SECRET_KEY` — auto-provisioned by Clerk setup
- `CLERK_PUBLISHABLE_KEY` — auto-provisioned by Clerk setup
- `VITE_CLERK_PUBLISHABLE_KEY` — auto-provisioned by Clerk setup (same value)
- `SESSION_SECRET` — no longer used (kept for backward compatibility)

## Authentication
Authentication uses Clerk (migrated from Replit Auth). The `/auth/login` route serves a browser sign-in page using `@clerk/clerk-js`. After sign-in, `/auth/callback` verifies the session via `clerkMiddleware` + `getAuth` and issues MCP OAuth tokens.

## Recent Changes
- 2026-08-17: Migrated authentication from Replit Auth (openid-client OIDC) to Clerk. Removed express-session, memorystore, openid-client. Added @clerk/express, @clerk/shared, http-proxy-middleware. Renamed ReplitAuthOAuthProvider → ClerkAuthOAuthProvider, ReplitUser → AuthUser.
- 2026-08-14: Revamped from Smithery stdio deployment to Replit-hosted HTTP MCP server with OAuth 2.1 + Replit Auth login gate. Removed smithery.yaml, @smithery/cli, and the old test harness.
- 2025-11-30: Initial Smithery-based MCP server with 4 Parcel tools.

## Rate Limits (Parcel API)
- Add Delivery: 20 requests/day
- Get Deliveries: 20 requests/hour
