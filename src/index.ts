import { randomBytes } from "node:crypto";
import express from "express";
import { clerkMiddleware, getAuth } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ClerkAuthOAuthProvider, type AuthUser } from "./oauthProvider.js";
import { createParcelMcpServer } from "./parcelServer.js";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware.js";

const PORT = parseInt(process.env.PORT ?? "5000", 10);
const PARCEL_API_KEY = process.env.PARCEL_API_KEY;

if (!PARCEL_API_KEY) {
  console.error("PARCEL_API_KEY environment variable is required");
  process.exit(1);
}

function getBaseUrl(): string {
  const domains = process.env.REPLIT_DOMAINS;
  if (domains) {
    return `https://${domains.split(",")[0]}`;
  }
  return `http://localhost:${PORT}`;
}

// Build an allowlist of known Replit domains for host validation.
const replitDomains: Set<string> = new Set(
  (process.env.REPLIT_DOMAINS ?? "").split(",").map((d) => d.trim()).filter(Boolean)
);

/**
 * Return a validated canonical host for Clerk key derivation.
 * Only trusts X-Forwarded-Host / Host when the value is in our REPLIT_DOMAINS
 * allowlist; otherwise falls back to the first configured domain (or empty
 * string, causing publishableKeyFromHost to fall back to CLERK_PUBLISHABLE_KEY).
 */
function getValidatedClerkHost(req: any): string {
  const proxyHost = getClerkProxyHost(req) ?? "";
  if (replitDomains.size === 0) {
    // Development: no known domains configured, trust the header.
    return proxyHost;
  }
  if (replitDomains.has(proxyHost)) {
    return proxyHost;
  }
  // Host not in allowlist — fall back to the configured domain so that
  // publishableKeyFromHost resolves the correct key and ignores the spoofed value.
  return [...replitDomains][0];
}

const app = express();
app.set("trust proxy", 1);

// Clerk proxy must be mounted BEFORE body parsers (streams raw bytes).
// Both this proxy and the login-page Clerk-JS URL selection use REPLIT_DOMAINS
// as the consistent production predicate.
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Resolve the publishable key only from validated, allowlisted hosts so that
// a spoofed X-Forwarded-Host cannot force key derivation from an attacker domain.
app.use(
  clerkMiddleware((req: any) => ({
    publishableKey: publishableKeyFromHost(
      getValidatedClerkHost(req),
      process.env.CLERK_PUBLISHABLE_KEY,
    ),
  }))
);

const baseUrl = getBaseUrl();

// Optional allow-list: comma-separated user IDs or emails.
// When unset or empty, any authenticated user may connect.
// For users migrated from Replit Auth, their original Replit user ID is
// preserved as the Clerk external ID and surfaced via sessionClaims.userId.
const allowedUsers = (process.env.ALLOWED_REPLIT_USERS ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const provider = new ClerkAuthOAuthProvider(
  "/auth/login",
  `${baseUrl}/mcp`,
  allowedUsers.length > 0 ? new Set(allowedUsers) : null
);
if (allowedUsers.length === 0) {
  console.warn(
    "ALLOWED_REPLIT_USERS is not set: any authenticated user may access this MCP server."
  );
}

// OAuth 2.1 authorization server endpoints per the MCP authorization spec:
// /.well-known metadata, /register (DCR), /authorize, /token, /revoke
app.use(
  mcpAuthRouter({
    provider,
    issuerUrl: new URL(baseUrl),
    resourceServerUrl: new URL(`${baseUrl}/mcp`),
    resourceName: "Parcel Delivery Tracking MCP Server",
    scopesSupported: ["mcp"],
  })
);

// Compatibility aliases: some MCP clients probe the root well-known paths
// instead of the path-suffixed variants that mcpAuthRouter serves.
app.get("/.well-known/oauth-protected-resource", (_req, res) => {
  res.redirect(301, "/.well-known/oauth-protected-resource/mcp");
});
app.get("/.well-known/openid-configuration", (_req, res) => {
  res.redirect(301, "/.well-known/oauth-authorization-server");
});

// --- Clerk sign-in gate for the OAuth authorize flow ---

/** Parse cookies from the Cookie header without a middleware dependency. */
function parseCookies(req: express.Request): Record<string, string> {
  const out: Record<string, string> = {};
  const header = req.headers.cookie ?? "";
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) out[name] = value;
  }
  return out;
}

/**
 * Step 1: Show Clerk sign-in. After successful login Clerk redirects to
 * /auth/consent where the user explicitly approves the pending client.
 */
app.get("/auth/login", (req, res) => {
  const pendingId = req.query.pending;
  if (typeof pendingId !== "string" || !provider.getPendingAuthorization(pendingId)) {
    res.status(400).send("Invalid or expired authorization request. Please retry from your MCP client.");
    return;
  }

  // Both this and clerkProxyMiddleware use REPLIT_DOMAINS as the production predicate.
  const isProduction = !!process.env.REPLIT_DOMAINS;

  // Use the same host-derived publishable key as clerkMiddleware so the
  // browser and server agree on the Clerk instance.
  const publishableKey = isProduction
    ? publishableKeyFromHost(getValidatedClerkHost(req), process.env.CLERK_PUBLISHABLE_KEY) ?? ""
    : process.env.CLERK_PUBLISHABLE_KEY ?? "";

  // In production, Clerk-JS must route all Frontend API calls through our
  // same-origin proxy; contacting Clerk's FAPI directly fails for keys bound
  // to this domain. In development the pk_test key talks to FAPI directly.
  const clerkProxyUrl = isProduction ? `${getBaseUrl()}${CLERK_PROXY_PATH}` : null;

  // After sign-in send user to the consent page (not directly to complete auth)
  // so they can explicitly approve the requesting client.
  const consentUrl = `/auth/consent?pending=${encodeURIComponent(pendingId)}`;

  const clerkJsUrl = isProduction
    ? `${CLERK_PROXY_PATH}/npm/@clerk/clerk-js@latest/dist/clerk.browser.js`
    : `https://cdn.jsdelivr.net/npm/@clerk/clerk-js@latest/dist/clerk.browser.js`;

  res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign In — Parcel MCP Server</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: ui-sans-serif, system-ui, sans-serif; background: #0f1115; color: #e6e8eb; margin: 0; padding: 0; display: flex; align-items: center; justify-content: center; min-height: 100dvh; }
  #clerk-sign-in { width: 100%; max-width: 480px; padding: 1.5rem; }
  .loading { color: #9aa3ad; text-align: center; padding: 2rem; }
  .error { color: #f87171; text-align: center; padding: 2rem; }
</style>
</head>
<body>
<div id="clerk-sign-in"><p class="loading">Loading sign in…</p></div>
<script>
(async function() {
  try {
    const script = document.createElement("script");
    script.src = ${JSON.stringify(clerkJsUrl)};
    script.async = true;
    document.head.appendChild(script);
    await new Promise((resolve, reject) => {
      script.onload = resolve;
      script.onerror = reject;
    });

    const proxyUrl = ${JSON.stringify(clerkProxyUrl)};
    const clerk = proxyUrl
      ? new window.Clerk(${JSON.stringify(publishableKey)}, { proxyUrl })
      : new window.Clerk(${JSON.stringify(publishableKey)});
    await clerk.load(proxyUrl ? { proxyUrl } : undefined);

    if (clerk.user) {
      // Already signed in — go straight to consent
      window.location.href = ${JSON.stringify(consentUrl)};
    } else {
      clerk.mountSignIn(document.getElementById("clerk-sign-in"), {
        afterSignInUrl: ${JSON.stringify(consentUrl)},
        afterSignUpUrl: ${JSON.stringify(consentUrl)},
      });
    }
  } catch (err) {
    console.error("Failed to load sign-in:", err);
    document.getElementById("clerk-sign-in").innerHTML =
      '<p class="error">Failed to load sign-in. Please refresh and try again.</p>';
  }
})();
</script>
</body>
</html>`);
});

/**
 * Step 2: Consent page.
 * - clerkMiddleware has validated the Clerk session.
 * - Generates a per-request CSRF token, stores it in an HttpOnly SameSite=Strict
 *   cookie, and embeds it as a hidden form field.
 * - The user sees the requesting client's name and scopes, and must click Approve.
 */
app.get("/auth/consent", (req, res) => {
  const pendingId = req.query.pending;
  if (typeof pendingId !== "string") {
    res.status(400).send("Missing pending authorization ID. Please retry from your MCP client.");
    return;
  }

  const auth = getAuth(req as any);
  const claims = auth?.sessionClaims as any;
  const userId = claims?.userId || auth?.userId;

  if (!userId) {
    // Not signed in — redirect back to login
    res.redirect(`/auth/login?pending=${encodeURIComponent(pendingId)}`);
    return;
  }

  const pending = provider.getPendingAuthorization(pendingId);
  if (!pending) {
    res.status(400).send("Authorization request expired or not found. Please retry from your MCP client.");
    return;
  }

  const client = provider.clientsStore.getClient(pending.clientId);
  const clientName = client?.client_name ?? pending.clientId;
  const scopes = pending.params.scopes ?? ["mcp"];
  const displayName = claims?.firstName
    ? `${claims.firstName}${claims.lastName ? " " + claims.lastName : ""}`
    : (claims?.email ?? userId);

  // Generate a cryptographically random CSRF token, bound to this consent page load.
  const csrfToken = randomBytes(32).toString("hex");
  const isProduction = !!process.env.REPLIT_DOMAINS;
  const cookieAttrs = [
    `consent_csrf=${csrfToken}`,
    "HttpOnly",
    isProduction ? "Secure" : "",
    "SameSite=Strict",
    "Path=/auth/consent",
    "Max-Age=600", // 10 minutes — matches pending authorization TTL
  ].filter(Boolean).join("; ");
  res.setHeader("Set-Cookie", cookieAttrs);

  res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize Access — Parcel MCP Server</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: ui-sans-serif, system-ui, sans-serif; background: #0f1115; color: #e6e8eb; margin: 0; padding: 3rem 1.5rem; display: flex; justify-content: center; }
  main { max-width: 480px; width: 100%; }
  h1 { font-size: 1.4rem; margin-bottom: .5rem; }
  .card { background: #171a21; border: 1px solid #262b35; border-radius: 12px; padding: 1.5rem; margin-top: 1.5rem; }
  .client { font-weight: 600; color: #e6e8eb; }
  .scope-list { margin: .75rem 0 0; padding: 0; list-style: none; }
  .scope-list li { padding: .3rem 0; color: #9aa3ad; font-size: .9rem; }
  .scope-list li::before { content: "✓ "; color: #4ade80; }
  .who { font-size: .85rem; color: #9aa3ad; margin-top: .5rem; }
  .actions { display: flex; gap: .75rem; margin-top: 1.5rem; }
  button { flex: 1; padding: .65rem 1rem; border: none; border-radius: 8px; font-size: .95rem; cursor: pointer; font-family: inherit; }
  .btn-approve { background: #4ade80; color: #0f1115; font-weight: 600; }
  .btn-approve:hover { background: #22c55e; }
  .btn-deny { background: #262b35; color: #9aa3ad; }
  .btn-deny:hover { background: #303540; color: #e6e8eb; }
</style>
</head>
<body>
<main>
  <h1>📦 Authorize Access</h1>
  <div class="card">
    <p><span class="client">${escapeHtml(clientName)}</span> is requesting access to the <strong>Parcel MCP Server</strong>.</p>
    <ul class="scope-list">
      ${scopes.map((s: string) => `<li>Use MCP tools (${escapeHtml(s)})</li>`).join("")}
    </ul>
    <p class="who">Signed in as ${escapeHtml(displayName)}</p>
    <form method="POST" action="/auth/consent?pending=${encodeURIComponent(pendingId)}" class="actions">
      <input type="hidden" name="csrf" value="${csrfToken}">
      <button type="submit" name="action" value="approve" class="btn-approve">Approve</button>
      <button type="submit" name="action" value="deny" class="btn-deny">Deny</button>
    </form>
  </div>
</main>
</body>
</html>`);
});

/**
 * Step 3: Handle consent form submission.
 * - Validates Origin header (prevents cross-site form forgery).
 * - Validates the CSRF token (double-submit cookie pattern).
 * - Approve: issues the authorization code and redirects the MCP client.
 * - Deny: explicitly cancels the pending authorization and returns a refusal.
 */
app.post("/auth/consent", async (req, res) => {
  const pendingId = req.query.pending;
  if (typeof pendingId !== "string") {
    res.status(400).send("Missing pending authorization ID. Please retry from your MCP client.");
    return;
  }

  // --- Origin check: block cross-site form submissions ---
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== getBaseUrl()) {
    res.status(403).send("Origin mismatch. Request rejected.");
    return;
  }

  // --- CSRF double-submit cookie check ---
  const cookies = parseCookies(req);
  const cookieCsrf = cookies["consent_csrf"] ?? "";
  const formCsrf = (req.body?.csrf ?? "") as string;
  if (!cookieCsrf || !formCsrf || cookieCsrf !== formCsrf) {
    res.status(403).send("Invalid or missing CSRF token. Please reload and try again.");
    return;
  }
  // Consume the CSRF cookie (one-time use).
  res.setHeader("Set-Cookie", "consent_csrf=; HttpOnly; SameSite=Strict; Path=/auth/consent; Max-Age=0");

  // --- Clerk session check ---
  const auth = getAuth(req as any);
  const claims = auth?.sessionClaims as any;
  const userId = claims?.userId || auth?.userId;

  if (!userId) {
    res.redirect(`/auth/login?pending=${encodeURIComponent(pendingId)}`);
    return;
  }

  const action = req.body?.action;

  // Build the OAuth error callback for the (already validated) client
  // redirect_uri so MCP clients waiting on the callback complete cleanly
  // instead of hanging on a local HTML page.
  const pending = provider.getPendingAuthorization(pendingId);
  const errorRedirect = (error: string, description: string): string | null => {
    if (!pending) return null;
    const url = new URL(pending.params.redirectUri);
    url.searchParams.set("error", error);
    url.searchParams.set("error_description", description);
    if (pending.params.state !== undefined) {
      url.searchParams.set("state", pending.params.state);
    }
    return url.toString();
  };

  if (action === "deny") {
    // Explicitly cancel the pending authorization so it cannot be approved later.
    const denyUrl = errorRedirect("access_denied", "The user denied the authorization request.");
    provider.cancelAuthorization(pendingId);
    if (denyUrl) {
      res.redirect(denyUrl);
      return;
    }
    res.status(403).type("html").send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Access Denied</title>
<style>:root{color-scheme:dark}body{font-family:ui-sans-serif,system-ui,sans-serif;background:#0f1115;color:#e6e8eb;display:flex;align-items:center;justify-content:center;min-height:100dvh;margin:0;padding:1.5rem;text-align:center}</style>
</head><body><p>Access denied. You can close this window and retry from your MCP client if you change your mind.</p></body></html>`);
    return;
  }

  if (action !== "approve") {
    res.status(400).send("Invalid action.");
    return;
  }

  try {
    const user: AuthUser = {
      id: userId,
      email: claims?.email as string | undefined,
      name: [claims?.firstName, claims?.lastName].filter(Boolean).join(" ") || undefined,
    };

    const redirectUrl = provider.completeAuthorization(pendingId, user);
    console.log(`Authorized MCP access for user ${user.id}`);
    res.redirect(redirectUrl);
  } catch (error) {
    console.error("Auth consent failed:", error);
    // Allow-list rejection (or other failure) — complete the client callback
    // with a standard OAuth error when the redirect target is known.
    const failUrl = errorRedirect("access_denied", "Authorization failed: this account is not permitted or the request expired.");
    if (failUrl) {
      res.redirect(failUrl);
      return;
    }
    res
      .status(400)
      .send("Authorization failed or expired. Please retry from your MCP client.");
  }
});

// --- MCP endpoint (bearer token required) ---

// CORS for browser-based MCP clients (e.g. Smithery playground). The OAuth
// endpoints from mcpAuthRouter already send CORS headers; /mcp must too.
app.use("/mcp", (req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Expose-Headers", "WWW-Authenticate, Mcp-Session-Id");
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      req.headers["access-control-request-headers"]?.toString() ??
        "Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version"
    );
    res.setHeader("Vary", "Access-Control-Request-Headers");
    res.status(204).end();
    return;
  }
  next();
});

const bearerAuth = requireBearerAuth({
  verifier: provider,
  resourceMetadataUrl: `${baseUrl}/.well-known/oauth-protected-resource/mcp`,
});

app.post("/mcp", bearerAuth, express.json(), async (req, res) => {
  // Stateless mode: a fresh server + transport per request.
  const mcpServer = createParcelMcpServer(PARCEL_API_KEY);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  res.on("close", () => {
    transport.close();
    mcpServer.close();
  });

  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("Error handling MCP request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Stateless server: no SSE stream or sessions to manage.
app.get("/mcp", bearerAuth, (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
});
app.delete("/mcp", bearerAuth, (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
});

// --- Landing page ---

app.get("/", (_req, res) => {
  const mcpUrl = `${getBaseUrl()}/mcp`;
  res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Parcel MCP Server</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: ui-sans-serif, system-ui, sans-serif; background: #0f1115; color: #e6e8eb; margin: 0; padding: 3rem 1.5rem; display: flex; justify-content: center; }
  main { max-width: 640px; width: 100%; }
  h1 { font-size: 1.6rem; margin-bottom: .25rem; }
  .sub { color: #9aa3ad; margin-top: 0; }
  .card { background: #171a21; border: 1px solid #262b35; border-radius: 12px; padding: 1.25rem 1.5rem; margin-top: 1.5rem; }
  code, pre { background: #10131a; border: 1px solid #262b35; border-radius: 8px; padding: .15rem .4rem; font-size: .9rem; overflow-x: auto; }
  pre { padding: .75rem 1rem; }
  .badge { display: inline-block; background: #123524; color: #4ade80; border: 1px solid #1d5c3c; border-radius: 999px; padding: .15rem .65rem; font-size: .8rem; }
  ol { line-height: 1.7; }
  a { color: #7ab7ff; }
</style>
</head>
<body>
<main>
  <h1>📦 Parcel MCP Server</h1>
  <p class="sub">Delivery tracking tools for AI assistants, secured with Clerk.</p>
  <p><span class="badge">● Online</span></p>
  <div class="card">
    <h3>Connect from an MCP client</h3>
    <p>Add this server URL to Claude, Cursor, or any MCP client that supports OAuth:</p>
    <pre>${mcpUrl}</pre>
    <p>When you connect, a browser window opens and asks you to <strong>sign in</strong> and approve access.</p>
  </div>
  <div class="card">
    <h3>Available tools</h3>
    <ol>
      <li><code>add_delivery</code> — add a delivery to Parcel for tracking</li>
      <li><code>get_deliveries</code> — list active or recent deliveries</li>
      <li><code>get_supported_carriers</code> — list carrier codes</li>
      <li><code>get_delivery_status_codes</code> — explain status codes</li>
    </ol>
  </div>
</main>
</body>
</html>`);
});

app.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

/** Minimal HTML escaping for server-rendered consent page. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Parcel MCP server listening on port ${PORT}`);
  console.log(`Base URL: ${getBaseUrl()}`);
  console.log(`MCP endpoint: ${getBaseUrl()}/mcp (OAuth via Clerk)`);
});
