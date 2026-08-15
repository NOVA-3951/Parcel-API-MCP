import * as oidc from "openid-client";

const ISSUER_URL = process.env.ISSUER_URL ?? "https://replit.com/oidc";
const REPL_ID = process.env.REPL_ID;

let configPromise: Promise<oidc.Configuration> | undefined;

export function getOidcConfig(): Promise<oidc.Configuration> {
  if (!REPL_ID) {
    throw new Error("REPL_ID environment variable is not set");
  }
  if (!configPromise) {
    configPromise = oidc.discovery(new URL(ISSUER_URL), REPL_ID).catch((err) => {
      configPromise = undefined; // allow retry on transient failure
      throw err;
    });
  }
  return configPromise;
}

export interface LoginStart {
  authUrl: string;
  codeVerifier: string;
  state: string;
}

export async function startLogin(callbackUrl: string): Promise<LoginStart> {
  const config = await getOidcConfig();
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
  const state = oidc.randomState();

  const authUrl = oidc.buildAuthorizationUrl(config, {
    redirect_uri: callbackUrl,
    scope: "openid email profile",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    prompt: "login consent",
  });

  return { authUrl: authUrl.toString(), codeVerifier, state };
}

export interface ReplitClaims {
  sub: string;
  email?: string;
  first_name?: string;
  last_name?: string;
}

export async function finishLogin(
  currentUrl: URL,
  codeVerifier: string,
  expectedState: string
): Promise<ReplitClaims> {
  const config = await getOidcConfig();
  const tokens = await oidc.authorizationCodeGrant(config, currentUrl, {
    pkceCodeVerifier: codeVerifier,
    expectedState,
  });
  const claims = tokens.claims();
  if (!claims?.sub) {
    throw new Error("Replit Auth did not return user claims");
  }
  return {
    sub: claims.sub,
    email: claims.email as string | undefined,
    first_name: (claims as any).first_name,
    last_name: (claims as any).last_name,
  };
}
