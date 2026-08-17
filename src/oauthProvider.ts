import { randomBytes } from "node:crypto";
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

interface IssuedToken {
  clientId: string;
  scopes: string[];
  user: AuthUser;
  resource?: string;
  expiresAt: number;
}

interface IssuedRefreshToken {
  clientId: string;
  scopes: string[];
  user: AuthUser;
  resource?: string;
  expiresAt: number;
}

function newToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("hex")}`;
}

class InMemoryClientsStore implements OAuthRegisteredClientsStore {
  private clients = new Map<string, OAuthClientInformationFull>();

  getClient(clientId: string) {
    return this.clients.get(clientId);
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">
  ): OAuthClientInformationFull {
    const full: OAuthClientInformationFull = {
      ...client,
      client_id: newToken("client"),
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
    this.clients.set(full.client_id, full);
    return full;
  }
}

/**
 * OAuth 2.1 authorization server provider for the MCP endpoint.
 *
 * The authorize step defers to Clerk: the user must sign in before an
 * authorization code is issued. Codes and tokens are stored in memory;
 * a server restart simply forces MCP clients to re-authenticate.
 */
export class ClerkAuthOAuthProvider implements OAuthServerProvider {
  readonly clientsStore = new InMemoryClientsStore();

  private pendingAuthorizations = new Map<string, PendingAuthorization>();
  private codes = new Map<string, IssuedCode>();
  private accessTokens = new Map<string, IssuedToken>();
  private refreshTokens = new Map<string, IssuedRefreshToken>();

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
    const record = this.refreshTokens.get(refreshToken);
    if (!record || record.clientId !== client.client_id) {
      throw new InvalidGrantError("Invalid refresh token");
    }
    if (record.expiresAt < Date.now()) {
      this.refreshTokens.delete(refreshToken);
      throw new InvalidGrantError("Refresh token expired");
    }
    // Rotate the refresh token.
    this.refreshTokens.delete(refreshToken);
    const grantedScopes = scopes?.length
      ? scopes.filter((s) => record.scopes.includes(s))
      : record.scopes;
    return this.issueTokens(record.clientId, grantedScopes, record.user, record.resource);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = this.accessTokens.get(token);
    if (!record) {
      throw new InvalidTokenError("Invalid access token");
    }
    if (record.expiresAt < Date.now()) {
      this.accessTokens.delete(token);
      throw new InvalidTokenError("Access token expired");
    }
    if (!this.isUserAllowed(record.user)) {
      // Allow-list may have changed since issuance.
      this.accessTokens.delete(token);
      throw new InvalidTokenError("This account is no longer authorized");
    }
    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: Math.floor(record.expiresAt / 1000),
      resource: new URL(this.canonicalResource),
      extra: { user: record.user },
    };
  }

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest
  ): Promise<void> {
    const access = this.accessTokens.get(request.token);
    if (access && access.clientId === client.client_id) {
      this.accessTokens.delete(request.token);
    }
    const refresh = this.refreshTokens.get(request.token);
    if (refresh && refresh.clientId === client.client_id) {
      this.refreshTokens.delete(request.token);
    }
  }

  private issueTokens(
    clientId: string,
    scopes: string[],
    user: AuthUser,
    resource?: string
  ): OAuthTokens {
    const accessToken = newToken("mcp");
    const refreshToken = newToken("rt");
    this.accessTokens.set(accessToken, {
      clientId,
      scopes,
      user,
      resource,
      expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
    });
    this.refreshTokens.set(refreshToken, {
      clientId,
      scopes,
      user,
      resource,
      expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS,
    });
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
    for (const [id, p] of this.pendingAuthorizations) {
      if (now - p.createdAt > AUTH_CODE_TTL_MS) this.pendingAuthorizations.delete(id);
    }
    for (const [c, r] of this.codes) {
      if (r.expiresAt < now) this.codes.delete(c);
    }
    for (const [t, r] of this.accessTokens) {
      if (r.expiresAt < now) this.accessTokens.delete(t);
    }
    for (const [t, r] of this.refreshTokens) {
      if (r.expiresAt < now) this.refreshTokens.delete(t);
    }
  }
}
