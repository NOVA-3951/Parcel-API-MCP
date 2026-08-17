import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import type { Response } from "express";
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidGrantError, InvalidRequestError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

const AUTH_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface AuthUser {
  id: string;
  email?: string;
  name?: string;
}

export interface PendingAuthorization {
  clientId: string;
  params: AuthorizationParams;
  createdAt: number;
}

interface IssuedCode {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  resource?: string;
  scopes: string[];
  user: AuthUser;
  expiresAt: number;
}

function newToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("hex")}`;
}

/**
 * Lazily-initialised singleton pg Pool.
 * DATABASE_URL is injected by Replit for the project's PostgreSQL database.
 */
let _pool: Pool | null = null;
function getPool(): Pool {
  if (!_pool) {
    _pool = new Pool({ connectionString: process.env.DATABASE_URL });
    _pool.on("error", (err) => {
      console.error("pg pool error:", err);
    });
  }
  return _pool;
}

/**
 * Idempotent schema initialization. Must be awaited before the server starts
 * accepting requests so that the tables exist on every fresh deployment.
 */
export async function initSchema(): Promise<void> {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS oauth_clients (
      client_id TEXT PRIMARY KEY,
      client_data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS oauth_access_tokens (
      token TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      scopes TEXT[] NOT NULL,
      user_data JSONB NOT NULL,
      resource TEXT,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
      token TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      scopes TEXT[] NOT NULL,
      user_data JSONB NOT NULL,
      resource TEXT,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS oauth_access_tokens_expires_at_idx  ON oauth_access_tokens(expires_at);
    CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_expires_at_idx ON oauth_refresh_tokens(expires_at);
  `);
  console.log("OAuth schema initialized");
}

/**
 * Clients store backed by PostgreSQL.
 * Clients are registered once (DCR) and survive restarts.
 */
class PgClientsStore implements OAuthRegisteredClientsStore {
  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const { rows } = await getPool().query<{ client_data: OAuthClientInformationFull }>(
      "SELECT client_data FROM oauth_clients WHERE client_id = $1",
      [clientId]
    );
    return rows[0]?.client_data;
  }

  async registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">
  ): Promise<OAuthClientInformationFull> {
    const full: OAuthClientInformationFull = {
      ...client,
      client_id: newToken("client"),
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
    await getPool().query(
      `INSERT INTO oauth_clients (client_id, client_data) VALUES ($1, $2)
       ON CONFLICT (client_id) DO UPDATE SET client_data = EXCLUDED.client_data`,
      [full.client_id, JSON.stringify(full)]
    );
    return full;
  }
}

/**
 * OAuth 2.1 authorization server provider for the MCP endpoint.
 *
 * The authorize step defers to Clerk: the user must sign in before an
 * authorization code is issued.
 *
 * - Registered clients, access tokens, and refresh tokens are stored in
 *   PostgreSQL so they survive server restarts and redeploys.
 * - Pending authorizations and authorization codes remain in memory because
 *   they are short-lived (10 min), single-use, and do not need to survive
 *   restarts.
 */
export class ClerkAuthOAuthProvider implements OAuthServerProvider {
  readonly clientsStore = new PgClientsStore();

  // Short-lived, in-memory only (10 min TTL, single-use).
  private pendingAuthorizations = new Map<string, PendingAuthorization>();
  private codes = new Map<string, IssuedCode>();

  constructor(
    private loginPath: string,
    private canonicalResource: string,
    private allowedUsers: Set<string> | null // null = allow any authenticated user
  ) {}

  /** Throws if a requested resource indicator doesn't match this server. */
  private checkResource(resource?: URL | string): void {
    if (resource === undefined) return;
    const requested = resource.toString().replace(/\/$/, "");
    if (requested !== this.canonicalResource.replace(/\/$/, "")) {
      throw new InvalidRequestError(
        `Requested resource ${requested} does not match this server's resource ${this.canonicalResource}`
      );
    }
  }

  isUserAllowed(user: AuthUser): boolean {
    if (!this.allowedUsers || this.allowedUsers.size === 0) return true;
    const candidates = [user.id?.toLowerCase(), user.email?.toLowerCase()].filter(Boolean) as string[];
    return candidates.some((c) => this.allowedUsers!.has(c));
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    // Stash the authorization request and send the user through Clerk sign-in.
    this.checkResource(params.resource);
    const pendingId = newToken("pending");
    this.pendingAuthorizations.set(pendingId, {
      clientId: client.client_id,
      params,
      createdAt: Date.now(),
    });
    this.cleanup();

    res.redirect(`${this.loginPath}?pending=${encodeURIComponent(pendingId)}`);
  }

  getPendingAuthorization(pendingId: string): PendingAuthorization | undefined {
    const pending = this.pendingAuthorizations.get(pendingId);
    if (!pending) return undefined;
    if (Date.now() - pending.createdAt > AUTH_CODE_TTL_MS) {
      this.pendingAuthorizations.delete(pendingId);
      return undefined;
    }
    return pending;
  }

  /** Cancel (delete) a pending authorization — call on user deny. */
  cancelAuthorization(pendingId: string): void {
    this.pendingAuthorizations.delete(pendingId);
  }

  /**
   * Called after a successful Clerk sign-in. Issues an authorization
   * code bound to the authenticated user and returns the redirect URL
   * to send the MCP client back to.
   */
  completeAuthorization(pendingId: string, user: AuthUser): string {
    const pending = this.getPendingAuthorization(pendingId);
    if (!pending) {
      throw new Error("Authorization request expired or not found. Please retry from your MCP client.");
    }
    if (!this.isUserAllowed(user)) {
      this.pendingAuthorizations.delete(pendingId);
      throw new Error("This account is not authorized to access this MCP server.");
    }
    this.pendingAuthorizations.delete(pendingId);

    const code = newToken("code");
    this.codes.set(code, {
      clientId: pending.clientId,
      codeChallenge: pending.params.codeChallenge,
      redirectUri: pending.params.redirectUri,
      resource: pending.params.resource?.toString(),
      scopes: pending.params.scopes ?? [],
      user,
      expiresAt: Date.now() + AUTH_CODE_TTL_MS,
    });

    const redirect = new URL(pending.params.redirectUri);
    redirect.searchParams.set("code", code);
    if (pending.params.state !== undefined) {
      redirect.searchParams.set("state", pending.params.state);
    }
    return redirect.toString();
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    const record = this.codes.get(authorizationCode);
    if (!record || record.clientId !== client.client_id) {
      throw new InvalidGrantError("Invalid authorization code");
    }
    return record.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    const record = this.codes.get(authorizationCode);
    if (!record || record.clientId !== client.client_id) {
      throw new InvalidGrantError("Invalid authorization code");
    }
    this.codes.delete(authorizationCode); // single use
    if (record.expiresAt < Date.now()) {
      throw new InvalidGrantError("Authorization code expired");
    }
    if (redirectUri !== undefined && redirectUri !== record.redirectUri) {
      throw new InvalidGrantError("redirect_uri must exactly match the authorization request");
    }
    if (
      redirectUri === undefined &&
      (client.redirect_uris.length !== 1 || client.redirect_uris[0] !== record.redirectUri)
    ) {
      // OAuth 2.1: redirect_uri may only be omitted when unambiguous.
      throw new InvalidGrantError("redirect_uri is required for this token exchange");
    }
    this.checkResource(resource);

    return this.issueTokens(record.clientId, record.scopes, record.user, record.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL
  ): Promise<OAuthTokens> {
    this.checkResource(resource);

    const pool = getPool();
    const conn = await pool.connect();
    try {
      await conn.query("BEGIN");

      // Lock the row so concurrent refresh requests can't double-use it.
      const { rows } = await conn.query<{
        client_id: string;
        scopes: string[];
        user_data: AuthUser;
        resource: string | null;
        expires_at: string;
      }>(
        "SELECT client_id, scopes, user_data, resource, expires_at FROM oauth_refresh_tokens WHERE token = $1 FOR UPDATE",
        [refreshToken]
      );
      const record = rows[0];
      if (!record || record.client_id !== client.client_id) {
        await conn.query("ROLLBACK");
        throw new InvalidGrantError("Invalid refresh token");
      }
      if (new Date(record.expires_at).getTime() < Date.now()) {
        await conn.query("DELETE FROM oauth_refresh_tokens WHERE token = $1", [refreshToken]);
        await conn.query("COMMIT");
        throw new InvalidGrantError("Refresh token expired");
      }

      // Atomically delete the old refresh token and issue new tokens.
      await conn.query("DELETE FROM oauth_refresh_tokens WHERE token = $1", [refreshToken]);

      const grantedScopes = scopes?.length
        ? scopes.filter((s) => record.scopes.includes(s))
        : record.scopes;

      const newTokens = await this.issueTokensInConn(conn, record.client_id, grantedScopes, record.user_data, record.resource ?? undefined);
      await conn.query("COMMIT");
      return newTokens;
    } catch (err) {
      // Roll back only if there is an active transaction (i.e. err came from within BEGIN).
      try { await conn.query("ROLLBACK"); } catch { /* ignore */ }
      throw err;
    } finally {
      conn.release();
    }
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const { rows } = await getPool().query<{
      client_id: string;
      scopes: string[];
      user_data: AuthUser;
      resource: string | null;
      expires_at: string;
    }>(
      "SELECT client_id, scopes, user_data, resource, expires_at FROM oauth_access_tokens WHERE token = $1",
      [token]
    );
    const record = rows[0];
    if (!record) {
      throw new InvalidTokenError("Invalid access token");
    }
    if (new Date(record.expires_at).getTime() < Date.now()) {
      await getPool().query("DELETE FROM oauth_access_tokens WHERE token = $1", [token]);
      throw new InvalidTokenError("Access token expired");
    }
    if (!this.isUserAllowed(record.user_data)) {
      // Allow-list may have changed since issuance.
      await getPool().query("DELETE FROM oauth_access_tokens WHERE token = $1", [token]);
      throw new InvalidTokenError("This account is no longer authorized");
    }
    return {
      token,
      clientId: record.client_id,
      scopes: record.scopes,
      expiresAt: Math.floor(new Date(record.expires_at).getTime() / 1000),
      resource: new URL(this.canonicalResource),
      extra: { user: record.user_data },
    };
  }

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest
  ): Promise<void> {
    // Try both tables; delete only if the token belongs to this client.
    await getPool().query(
      "DELETE FROM oauth_access_tokens WHERE token = $1 AND client_id = $2",
      [request.token, client.client_id]
    );
    await getPool().query(
      "DELETE FROM oauth_refresh_tokens WHERE token = $1 AND client_id = $2",
      [request.token, client.client_id]
    );
  }

  private async issueTokens(
    clientId: string,
    scopes: string[],
    user: AuthUser,
    resource?: string
  ): Promise<OAuthTokens> {
    const pool = getPool();
    const conn = await pool.connect();
    try {
      return await this.issueTokensInConn(conn, clientId, scopes, user, resource);
    } finally {
      conn.release();
    }
  }

  /**
   * Insert new access + refresh tokens using the supplied client connection so
   * that callers inside an existing transaction (e.g. refresh-token rotation)
   * can include the inserts atomically.
   */
  private async issueTokensInConn(
    conn: import("pg").PoolClient,
    clientId: string,
    scopes: string[],
    user: AuthUser,
    resource?: string
  ): Promise<OAuthTokens> {
    const accessToken = newToken("mcp");
    const refreshToken = newToken("rt");
    const accessExpiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_MS);
    const refreshExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

    await conn.query(
      `INSERT INTO oauth_access_tokens (token, client_id, scopes, user_data, resource, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [accessToken, clientId, scopes, JSON.stringify(user), resource ?? null, accessExpiresAt]
    );
    await conn.query(
      `INSERT INTO oauth_refresh_tokens (token, client_id, scopes, user_data, resource, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [refreshToken, clientId, scopes, JSON.stringify(user), resource ?? null, refreshExpiresAt]
    );

    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: refreshToken,
      scope: scopes.join(" ") || undefined,
    };
  }

  private cleanup(): void {
    const now = Date.now();
    // Clean up in-memory short-lived state.
    for (const [id, p] of this.pendingAuthorizations) {
      if (now - p.createdAt > AUTH_CODE_TTL_MS) this.pendingAuthorizations.delete(id);
    }
    for (const [c, r] of this.codes) {
      if (r.expiresAt < now) this.codes.delete(c);
    }
    // Opportunistically purge expired DB tokens (fire-and-forget, errors are non-fatal).
    const pool = getPool();
    pool.query("DELETE FROM oauth_access_tokens WHERE expires_at < NOW()").catch((err) => {
      console.warn("Failed to purge expired access tokens:", err);
    });
    pool.query("DELETE FROM oauth_refresh_tokens WHERE expires_at < NOW()").catch((err) => {
      console.warn("Failed to purge expired refresh tokens:", err);
    });
  }
}
