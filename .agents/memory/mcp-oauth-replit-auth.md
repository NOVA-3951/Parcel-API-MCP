---
name: MCP OAuth via Replit Auth
description: Pattern and gotchas for gating an HTTP MCP server behind Replit Auth login
---
The MCP endpoint is protected per the MCP authorization spec: the app is its own OAuth 2.1 AS (SDK `mcpAuthRouter` + custom in-memory provider), and `/authorize` defers to Replit Auth (OIDC, openid-client v6) before issuing codes.

**Why:** MCP clients can't do Replit Auth directly; they need DCR + PKCE against a local AS whose login step is the Replit OIDC flow.

**How to apply / gotchas:**
- Protected-resource metadata lives at `/.well-known/oauth-protected-resource/mcp` (path suffix included) — the bearer middleware's `resourceMetadataUrl` must match or clients can't discover the flow.
- Code exchange must require an exact `redirect_uri` match, and resource indicators must be validated against the canonical `/mcp` URL (reviewer flagged both).
- Tokens are in-memory by design: restarts just force silent client re-auth; prefer Reserved VM over multi-instance autoscale.
- `ALLOWED_REPLIT_USERS` env (IDs/emails) gates which Replit accounts may connect; unset = anyone with a Replit account.
