import { Response } from 'express';
import { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import {
  exchangeToken,
  generateToken,
  getClientRegistration,
  readPendingAuthorization,
  readMcpInstallation,
  revokeMcpInstallation,
  saveClientRegistration,
  savePendingAuthorization,
  consumeRefreshToken,
  generateMcpTokens,
  saveMcpInstallation,
  saveRefreshToken,
} from '../services/auth.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { logger } from '../../shared/logger.js';
import { config } from '../../../config.js';

/**
 * Implementation of the OAuthRegisteredClientsStore interface using the existing client registration system
 */
export class FeatureReferenceOAuthClientsStore implements OAuthRegisteredClientsStore {
  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    return getClientRegistration(clientId);
  }

  async registerClient(client: OAuthClientInformationFull): Promise<OAuthClientInformationFull> {
    return saveClientRegistration(client.client_id, client);
  }
}

/**
 * Implementation of the OAuthServerProvider interface for upstream authentication
 */
export class FeatureReferenceAuthProvider implements OAuthServerProvider {
  private _clientsStore: FeatureReferenceOAuthClientsStore;

  constructor() {
    this._clientsStore = new FeatureReferenceOAuthClientsStore();
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return this._clientsStore;
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const authorizationCode = generateToken();

    await savePendingAuthorization(authorizationCode, {
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: 'S256',
      clientId: client.client_id,
      state: params.state,
    });

    logger.debug('Saved pending authorization, redirecting to Auth0', {
      authorizationCode: authorizationCode.substring(0, 8) + '...',
      clientId: client.client_id,
    });

    const auth0Url = new URL(`https://${config.auth0.domain}/authorize`);
    auth0Url.searchParams.set('response_type', 'code');
    auth0Url.searchParams.set('client_id', config.auth0.clientId);
    auth0Url.searchParams.set('redirect_uri', `${config.baseUri}/auth0/callback`);
    auth0Url.searchParams.set('scope', 'openid profile email');
    auth0Url.searchParams.set('state', authorizationCode);
    if (config.auth0.audience) {
      auth0Url.searchParams.set('audience', config.auth0.audience);
    }

    res.redirect(auth0Url.toString());
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const pendingAuth = await readPendingAuthorization(authorizationCode);
    if (!pendingAuth) {
      throw new Error('Authorization code not found');
    }

    if (pendingAuth.clientId !== client.client_id) {
      throw new Error('Authorization code does not match client');
    }

    return pendingAuth.codeChallenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<OAuthTokens> {
    const tokenData = await exchangeToken(authorizationCode);
    if (!tokenData) {
      throw new Error('Invalid authorization code');
    }

    // Get the MCP installation to retrieve the full token data including refresh token
    const mcpInstallation = await readMcpInstallation(tokenData.mcpAccessToken);
    if (!mcpInstallation) {
      throw new Error('Failed to retrieve MCP installation');
    }

    // Return the full token data including refresh token
    return {
      access_token: mcpInstallation.mcpTokens.access_token,
      refresh_token: mcpInstallation.mcpTokens.refresh_token,
      expires_in: mcpInstallation.mcpTokens.expires_in,
      token_type: 'Bearer',
    };
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, _scopes?: string[]): Promise<OAuthTokens> {
    const accessToken = await consumeRefreshToken(refreshToken);

    if (!accessToken) {
      throw new Error('Invalid refresh token');
    }

    const mcpInstallation = await readMcpInstallation(accessToken);

    if (!mcpInstallation) {
      throw new Error('Invalid refresh token');
    }

    // Check the client_id
    if (mcpInstallation.clientId !== client.client_id) {
      throw new Error('Invalid client');
    }
    
    const newTokens = generateMcpTokens();

    if (newTokens.refresh_token) {
      await saveRefreshToken(newTokens.refresh_token, newTokens.access_token);
    }

    // Update the installation with the new tokens
    await saveMcpInstallation(newTokens.access_token, {
      ...mcpInstallation,
      mcpTokens: newTokens,
      issuedAt: Date.now() / 1000,
      userId: mcpInstallation.userId, // Preserve the user ID
    });

    return newTokens;
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const installation = await readMcpInstallation(token);
    if (!installation) {
      throw new InvalidTokenError("Invalid access token");
    }

    const expiresAt = (
      installation.mcpTokens.expires_in
      ? installation.mcpTokens.expires_in + installation.issuedAt
      : undefined
    );

    // This can be removed once in the SDK
    // Check if the token is expired
    if (!!expiresAt && expiresAt < Date.now() / 1000) {
      throw new InvalidTokenError("Token has expired");
    }
    
    return {
      token,
      clientId: installation.clientId,
      scopes: ['mcp'],
      expiresAt,
      extra: {
        userId: installation.userId
      }
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    await revokeMcpInstallation(request.token);
  }
}