import { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

/**
 * Represents a pending OAuth authorization that hasn't been exchanged for tokens yet.
 * Stored in Redis with the authorization code as the key.
 */
export interface PendingAuthorization {
  /** The redirect URI where the client expects to receive the authorization code */
  redirectUri: string;
  /** PKCE code challenge - a derived value from the code verifier */
  codeChallenge: string;
  /** Method used to derive the code challenge (currently only S256 supported) */
  codeChallengeMethod: string;
  /** The OAuth client ID that initiated the authorization */
  clientId: string;
  /** Optional state parameter for CSRF protection */
  state?: string;
}

/**
 * Represents the exchange of an authorization code for an MCP access token.
 * Used to prevent replay attacks by tracking if a code has been used.
 */
export interface TokenExchange {
  /** The MCP access token that was issued for this authorization code */
  mcpAccessToken: string;
  /** Whether this authorization code has already been exchanged for tokens */
  alreadyUsed: boolean;
}

export interface Auth0Installation {
  auth0AccessToken: string;
  auth0RefreshToken?: string;
  auth0IdToken: string;
  auth0Sub: string;
}

export interface McpInstallation {
  auth0Installation: Auth0Installation;
  mcpTokens: OAuthTokens;
  clientId: string;
  issuedAt: number;
  /** Internal user UUID from the users table (not the Auth0 sub) */
  userId: string;
}

/**
 * OAuth 2.0 Token Introspection Response
 * Based on RFC 7662: https://tools.ietf.org/html/rfc7662
 * Used when validating tokens with an external authorization server.
 */
export interface TokenIntrospectionResponse {
  /** Whether the token is currently active */
  active: boolean;
  /** Space-separated list of scopes associated with the token */
  scope?: string;
  /** Client identifier for the OAuth client that requested the token */
  client_id?: string;
  /** Human-readable identifier for the resource owner */
  username?: string;
  /** Type of the token (e.g., "Bearer") */
  token_type?: string;
  /** Expiration time as seconds since Unix epoch */
  exp?: number;
  /** Time at which the token was issued as seconds since Unix epoch */
  iat?: number;
  /** Time before which the token is not valid as seconds since Unix epoch */
  nbf?: number;
  /** Subject identifier for the resource owner */
  sub?: string;
  /** Intended audience for the token */
  aud?: string | string[];
  /** Issuer of the token */
  iss?: string;
  /** Unique identifier for the token */
  jti?: string;
  /** Custom field for our implementation to store user ID */
  userId?: string;
}