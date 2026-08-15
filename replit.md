# Parcel MCP Server - Replit Project

## Overview
An HTTP MCP (Model Context Protocol) server for the Parcel delivery tracking API, hosted on Replit. Access to the MCP endpoint is restricted via OAuth 2.1: MCP clients complete an OAuth flow whose login step is Replit Auth, so only signed-in Replit users can obtain tokens and use the tools.

## Architecture

### Project Structure
```
/
├── src/
│   ├── index.ts          # Express app: MCP endpoint, OAuth router, login routes, landing page
│   ├── oauthProvider.ts  # In-memory OAuth 2.1 authorization server provider (codes/tokens/DCR)
│   ├── replitAuth.ts     # Replit Auth (OIDC) login via openid-client
│   └── parcelServer.ts   # Parcel MCP tools (McpServer factory)
├── dist/                 # Compiled JavaScript (generated)
├── package.json
├── tsconfig.json
└── README.md
```

### Technology Stack
- Node.js 20, TypeScript, Express 5
- @modelcontextprotocol/sdk (Streamable HTTP transport + auth router/bearer middleware)
- openid-client v6 for Replit Auth OIDC
- express-session + memorystore for the browser login flow only

### Request flow
1. MCP client hits `POST /mcp` → 401 with `WWW-Authenticate` → discovers metadata at `/.well-known/...`
2. Client registers via `/register` (DCR), starts `/authorize` with PKCE
3. `/authorize` stores a pending request and redirects to `/auth/login` → Replit Auth (`https://replit.com/oidc`)
4. `/auth/callback` verifies the login, issues an auth code bound to the Replit user, redirects back to the client
5. Client exchanges the code at `/token` for bearer + refresh tokens; `/mcp` requires the bearer token
6. `/mcp` runs in stateless mode: fresh McpServer + transport per request

### State & limitations
- Clients, codes, and tokens are in-memory: restarts/redeploys force MCP clients to silently re-authenticate (they handle the 401). Reserved VM deployment recommended over autoscale with >1 instance.
- By default any Replit-authenticated user may connect; set the `ALLOWED_REPLIT_USERS` env var (comma-separated Replit user IDs or emails) to restrict access. The allow-list is re-checked on every token verification.

## Configuration (Replit Secrets)
- `PARCEL_API_KEY` — server-side Parcel API key, never exposed to clients
- `SESSION_SECRET` — session cookie secret for the login flow

## Recent Changes
- 2026-08-14: Revamped from Smithery stdio deployment to Replit-hosted HTTP MCP server with OAuth 2.1 + Replit Auth login gate. Removed smithery.yaml, @smithery/cli, and the old test harness.
- 2025-11-30: Initial Smithery-based MCP server with 4 Parcel tools.

## Rate Limits (Parcel API)
- Add Delivery: 20 requests/day
- Get Deliveries: 20 requests/hour
