import { Request, Response } from "express";
import { config } from "../../../config.js";
import { generateMcpTokens, readPendingAuthorization, saveMcpInstallation, saveRefreshToken, saveTokenExchange } from "../services/auth.js";
import { McpInstallation } from "../types.js";
import { logger } from "../../shared/logger.js";
import { query } from "../../shared/postgres.js";

/**
 * Upsert user in Postgres from Auth0 ID token claims.
 * Returns the internal canonical user UUID.
 */
async function upsertUser(auth0Sub: string, email?: string, name?: string): Promise<string> {
  const result = await query<{ id: string }>(
    `INSERT INTO users (auth_provider_id, email, name)
     VALUES ($1, $2, $3)
     ON CONFLICT (auth_provider_id) DO UPDATE
       SET email = COALESCE(EXCLUDED.email, users.email),
           name = COALESCE(EXCLUDED.name, users.name),
           updated_at = now()
     RETURNING id`,
    [auth0Sub, email ?? null, name ?? null]
  );
  return result.rows[0].id;
}

/**
 * Decode a JWT payload without verification (validation was done by Auth0 token endpoint).
 */
function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT format");
  const payload = Buffer.from(parts[1], "base64url").toString("utf-8");
  return JSON.parse(payload);
}

/**
 * Handles the Auth0 OIDC callback after user authentication.
 *
 * Flow:
 *   1. Auth0 redirects here with `code` (Auth0 auth code) and `state` (MCP auth code)
 *   2. Exchange Auth0 code for tokens at Auth0's /oauth/token
 *   3. Extract user identity from the ID token
 *   4. Upsert user in Postgres
 *   5. Generate MCP tokens and complete the MCP OAuth flow
 *   6. Redirect back to the MCP client
 */
export async function handleAuth0Callback(req: Request, res: Response) {
  const { code, state: mcpAuthorizationCode, error, error_description } = req.query;

  if (error) {
    logger.error("Auth0 returned an error", undefined, {
      error: String(error),
      description: String(error_description || ""),
    });
    res.status(400).send(`Authentication failed: ${error_description || error}`);
    return;
  }

  if (typeof code !== "string" || typeof mcpAuthorizationCode !== "string") {
    res.status(400).send("Missing code or state parameter");
    return;
  }

  logger.debug("Auth0 callback received", {
    mcpAuthorizationCode: mcpAuthorizationCode.substring(0, 8) + "...",
  });

  const pendingAuth = await readPendingAuthorization(mcpAuthorizationCode);
  if (!pendingAuth) {
    res.status(400).send("No matching authorization found");
    return;
  }

  // Exchange Auth0 authorization code for tokens
  const tokenResponse = await fetch(
    `https://${config.auth0.domain}/oauth/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: config.auth0.clientId,
        client_secret: config.auth0.clientSecret,
        code,
        redirect_uri: `${config.baseUri}/auth0/callback`,
      }),
    }
  );

  if (!tokenResponse.ok) {
    const body = await tokenResponse.text();
    logger.error("Auth0 token exchange failed", undefined, {
      status: tokenResponse.status,
      body: body.substring(0, 200),
    });
    res.status(502).send("Failed to exchange Auth0 authorization code");
    return;
  }

  const auth0Tokens = (await tokenResponse.json()) as {
    access_token: string;
    id_token: string;
    refresh_token?: string;
    token_type: string;
    expires_in: number;
  };

  const idTokenClaims = decodeJwtPayload(auth0Tokens.id_token);
  const auth0Sub = idTokenClaims.sub as string;
  const email = idTokenClaims.email as string | undefined;
  const name = idTokenClaims.name as string | undefined;

  if (!auth0Sub) {
    res.status(502).send("Auth0 ID token missing sub claim");
    return;
  }

  logger.debug("Auth0 user authenticated", { auth0Sub, email });

  const internalUserId = await upsertUser(auth0Sub, email, name);

  const mcpTokens = generateMcpTokens();

  const mcpInstallation: McpInstallation = {
    auth0Installation: {
      auth0AccessToken: auth0Tokens.access_token,
      auth0RefreshToken: auth0Tokens.refresh_token,
      auth0IdToken: auth0Tokens.id_token,
      auth0Sub,
    },
    mcpTokens,
    clientId: pendingAuth.clientId,
    issuedAt: Date.now() / 1000,
    userId: internalUserId,
  };

  await saveMcpInstallation(mcpTokens.access_token, mcpInstallation);

  if (mcpTokens.refresh_token) {
    await saveRefreshToken(mcpTokens.refresh_token, mcpTokens.access_token);
  }

  await saveTokenExchange(mcpAuthorizationCode, {
    mcpAccessToken: mcpTokens.access_token,
    alreadyUsed: false,
  });

  const redirectUrl = pendingAuth.state
    ? `${pendingAuth.redirectUri}?code=${mcpAuthorizationCode}&state=${pendingAuth.state}`
    : `${pendingAuth.redirectUri}?code=${mcpAuthorizationCode}`;

  logger.debug("Redirecting to MCP client callback", { redirectUrl });
  res.redirect(redirectUrl);
}
