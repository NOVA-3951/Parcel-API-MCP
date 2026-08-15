# Parcel MCP Server

An HTTP MCP (Model Context Protocol) server for the Parcel delivery tracking API, hosted on Replit and secured with OAuth 2.1 backed by **Replit Auth**. Only users who sign in with a Replit account can obtain a token and use the tools.

## Features

### Tools

1. **`add_delivery`** — Add a new delivery to Parcel for tracking
   - `tracking_number` (required), `carrier_code` (required), `description` (required)
   - `language` (optional, ISO 639-1), `send_push_confirmation` (optional)
   - Rate limit: 20 requests per day
2. **`get_deliveries`** — Get recent or active deliveries
   - `filter_mode` (optional): `active` or `recent` (default)
   - Rate limit: 20 requests per hour
3. **`get_supported_carriers`** — List supported carriers and their codes
4. **`get_delivery_status_codes`** — Explain delivery status codes (0-8)

## How access control works

The server implements the MCP authorization spec (OAuth 2.1):

- `POST /mcp` — the MCP endpoint (Streamable HTTP transport). Requires a bearer token; unauthenticated requests get a 401 with a `WWW-Authenticate` challenge pointing at the discovery metadata.
- `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource/mcp` — discovery metadata so clients can auto-configure.
- `/register` — dynamic client registration.
- `/authorize` — sends the user through **Replit Auth** login before issuing an authorization code (PKCE required).
- `/token` — exchanges codes/refresh tokens for bearer tokens bound to the authenticated Replit user.
- `/revoke` — token revocation.

Tokens are held in memory: a server restart just means MCP clients transparently re-authenticate.

## Connecting from an MCP client

Add the server URL to any MCP client that supports OAuth (Claude, Cursor, etc.):

```
https://<your-repl-domain>/mcp
```

On first connection a browser window opens and asks you to sign in with your Replit account. After login, the client receives a token and the tools become available.

## Configuration

| Variable | Purpose |
|----------|---------|
| `PARCEL_API_KEY` | Server-side Parcel API key (from [web.parcelapp.net](https://web.parcelapp.net/)). Never exposed to clients. |
| `SESSION_SECRET` | Secret for the login-flow session cookies. |
| `ALLOWED_REPLIT_USERS` | Optional. Comma-separated Replit user IDs or emails allowed to connect. When unset, **any** Replit-authenticated user may connect. |

Both are managed as Replit Secrets.

## Development

```bash
npm install
npm start   # builds and runs on port 5000
```

## Resources

- [Parcel API Documentation — Add Delivery](https://parcelapp.net/help/api-add-delivery.html)
- [Parcel API Documentation — View Deliveries](https://parcelapp.net/help/api-view-deliveries.html)
- [Supported Carriers List](https://api.parcel.app/external/supported_carriers.json)

## License

MIT
