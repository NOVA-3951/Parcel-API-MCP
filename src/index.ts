import express from "express";
import session from "express-session";
import createMemoryStore from "memorystore";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ReplitAuthOAuthProvider, type ReplitUser } from "./oauthProvider.js";
import { startLogin, finishLogin } from "./replitAuth.js";
import { createParcelMcpServer } from "./parcelServer.js";

const PORT = parseInt(process.env.PORT ?? "5000", 10);
const PARCEL_API_KEY = process.env.PARCEL_API_KEY;
const SESSION_SECRET = process.env.SESSION_SECRET;

if (!PARCEL_API_KEY) {
  console.error("PARCEL_API_KEY environment variable is required");
  process.exit(1);
}
if (!SESSION_SECRET) {
  console.error("SESSION_SECRET environment variable is required");
  process.exit(1);
}

function getBaseUrl(): string {
  const domains = process.env.REPLIT_DOMAINS;
  if (domains) {
    return `https://${domains.split(",")[0]}`;
  }
  return `http://localhost:${PORT}`;
}

declare module "express-session" {
  interface SessionData {
    pendingId?: string;
    codeVerifier?: string;
    oidcState?: string;
    user?: ReplitUser;
  }
}

const app = express();
app.set("trust proxy", 1);

const MemoryStore = createMemoryStore(session);
app.use(
  session({
    secret: SESSION_SECRET,
    store: new MemoryStore({ checkPeriod: 60 * 60 * 1000 }),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV !== "development" && !!process.env.REPLIT_DOMAINS,
      sameSite: "lax",
      maxAge: 60 * 60 * 1000,
    },
  })
);

const baseUrl = getBaseUrl();

// Optional allow-list: comma-separated Replit user IDs or emails.
// When unset or empty, any Replit-authenticated user may connect.
const allowedUsers = (process.env.ALLOWED_REPLIT_USERS ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const provider = new ReplitAuthOAuthProvider(
  "/auth/login",
  `${baseUrl}/mcp`,
  allowedUsers.length > 0 ? new Set(allowedUsers) : null
);
if (allowedUsers.length === 0) {
  console.warn(
    "ALLOWED_REPLIT_USERS is not set: any Replit-authenticated user may access this MCP server."
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

// --- Replit Auth login gate for the OAuth authorize flow ---

app.get("/auth/login", async (req, res) => {
  try {
    const pendingId = req.query.pending;
    if (typeof pendingId !== "string" || !provider.getPendingAuthorization(pendingId)) {
      res.status(400).send("Invalid or expired authorization request. Please retry from your MCP client.");
      return;
    }

    const { authUrl, codeVerifier, state } = await startLogin(`${getBaseUrl()}/auth/callback`);
    req.session.pendingId = pendingId;
    req.session.codeVerifier = codeVerifier;
    req.session.oidcState = state;
    res.redirect(authUrl);
  } catch (error) {
    console.error("Login initiation failed:", error);
    res.status(500).send("Failed to start Replit Auth login. Please try again.");
  }
});

app.get("/auth/callback", async (req, res) => {
  const { pendingId, codeVerifier, oidcState } = req.session;
  if (!pendingId || !codeVerifier || !oidcState) {
    res.status(400).send("Login session expired. Please retry from your MCP client.");
    return;
  }

  try {
    const currentUrl = new URL(req.originalUrl, getBaseUrl());
    const claims = await finishLogin(currentUrl, codeVerifier, oidcState);
    const user: ReplitUser = {
      id: claims.sub,
      email: claims.email,
      name: [claims.first_name, claims.last_name].filter(Boolean).join(" ") || undefined,
    };

    const redirectUrl = provider.completeAuthorization(pendingId, user);

    // Clear one-time login state.
    req.session.pendingId = undefined;
    req.session.codeVerifier = undefined;
    req.session.oidcState = undefined;
    req.session.user = user;

    console.log(`Authorized MCP access for Replit user ${user.id}`);
    res.redirect(redirectUrl);
  } catch (error) {
    console.error("Auth callback failed:", error);
    res
      .status(400)
      .send(
        "Replit Auth login failed or the authorization request expired. Please retry from your MCP client."
      );
  }
});

// --- MCP endpoint (bearer token required) ---

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
  <p class="sub">Delivery tracking tools for AI assistants, secured with Replit Auth.</p>
  <p><span class="badge">● Online</span></p>
  <div class="card">
    <h3>Connect from an MCP client</h3>
    <p>Add this server URL to Claude, Cursor, or any MCP client that supports OAuth:</p>
    <pre>${mcpUrl}</pre>
    <p>When you connect, a browser window opens and asks you to <strong>sign in with your Replit account</strong>. Only signed-in Replit users can access the tools.</p>
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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Parcel MCP server listening on port ${PORT}`);
  console.log(`Base URL: ${getBaseUrl()}`);
  console.log(`MCP endpoint: ${getBaseUrl()}/mcp (OAuth via Replit Auth)`);
});
