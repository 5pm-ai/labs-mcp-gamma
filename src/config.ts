/**
 * Unified configuration for the merged MCP + Auth server
 *
 * This configuration supports two modes:
 * - internal: Auth server runs in-process (default for demo/development)
 * - external: Auth server runs separately (production pattern)
 */

import 'dotenv/config';

export interface Config {
  port: number;
  baseUri: string;
  nodeEnv: string;

  auth: {
    mode: 'internal' | 'external' | 'auth_server';
    externalUrl?: string;
  };

  auth0: {
    domain: string;
    clientId: string;
    clientSecret: string;
    audience?: string;
  };

  redis: {
    enabled: boolean;
    url?: string;
    tls?: boolean;
  };

  database: {
    enabled: boolean;
    url?: string;
    adminUrl?: string;
  };

  kms: {
    enabled: boolean;
    keyName?: string;
  };
}

/**
 * Load configuration from environment variables
 */
function loadConfig(): Config {
  const authMode = (process.env.AUTH_MODE || 'internal') as 'internal' | 'external' | 'auth_server';

  if (authMode === 'external' && !process.env.AUTH_SERVER_URL) {
    throw new Error('AUTH_SERVER_URL must be set when AUTH_MODE=external');
  }

  if (!process.env.AUTH0_DOMAIN || !process.env.AUTH0_CLIENT_ID || !process.env.AUTH0_CLIENT_SECRET) {
    throw new Error('AUTH0_DOMAIN, AUTH0_CLIENT_ID, and AUTH0_CLIENT_SECRET must be set');
  }

  return {
    port: Number(process.env.PORT) || 3232,
    baseUri: process.env.BASE_URI || 'http://localhost:3232',
    nodeEnv: process.env.NODE_ENV || 'development',

    auth: {
      mode: authMode,
      externalUrl: process.env.AUTH_SERVER_URL
    },

    auth0: {
      domain: process.env.AUTH0_DOMAIN,
      clientId: process.env.AUTH0_CLIENT_ID,
      clientSecret: process.env.AUTH0_CLIENT_SECRET,
      audience: process.env.AUTH0_AUDIENCE,
    },

    redis: {
      enabled: !!process.env.REDIS_URL,
      url: process.env.REDIS_URL,
      tls: process.env.REDIS_TLS === '1' || process.env.REDIS_TLS === 'true'
    },

    database: {
      enabled: !!(process.env.DATABASE_URL && process.env.DATABASE_URL.trim()),
      url: process.env.DATABASE_URL,
      adminUrl: process.env.DATABASE_ADMIN_URL,
    },

    kms: {
      enabled: !!process.env.KMS_KEY_NAME,
      keyName: process.env.KMS_KEY_NAME,
    },
  };
}

// Export singleton config
export const config = loadConfig();

console.log('Configuration loaded:');
console.log('   Port:', config.port);
console.log('   Base URI:', config.baseUri);
console.log('   Auth Mode:', config.auth.mode);
if (config.auth.mode === 'external') {
  console.log('   Auth Server:', config.auth.externalUrl);
}
console.log('   Auth0 Domain:', config.auth0.domain);
console.log('   Redis:', config.redis.enabled ? 'enabled' : 'disabled');
console.log('   Database:', config.database.enabled ? 'enabled' : 'disabled');
console.log('   KMS:', config.kms.enabled ? 'enabled' : 'disabled (warehouse tool unavailable)');
console.log('');