import crypto from "crypto";
import { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { query } from "../../shared/postgres.js";

function computeRedirectUrisHash(redirectUris: string[]): string {
  const sorted = [...redirectUris].sort();
  return crypto.createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

/**
 * Save or deduplicate a client registration in Postgres.
 * If a client with the same (client_name, redirect_uris_hash) already exists,
 * returns the existing registration instead of creating a duplicate.
 */
export async function saveClientRegistrationPg(
  clientId: string,
  registration: OAuthClientInformationFull,
): Promise<OAuthClientInformationFull> {
  const redirectUrisHash = computeRedirectUrisHash(registration.redirect_uris);

  const result = await query<{ registration_blob: OAuthClientInformationFull }>(
    `INSERT INTO oauth_clients (
       client_id, client_name, redirect_uris, redirect_uris_hash,
       client_secret, client_secret_expires_at, token_endpoint_auth_method,
       registration_blob
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (client_name, redirect_uris_hash) DO UPDATE
       SET last_used_at = now()
     RETURNING registration_blob`,
    [
      clientId,
      registration.client_name ?? null,
      JSON.stringify(registration.redirect_uris),
      redirectUrisHash,
      registration.client_secret ?? null,
      registration.client_secret_expires_at ?? null,
      registration.token_endpoint_auth_method ?? null,
      JSON.stringify(registration),
    ]
  );

  return result.rows[0].registration_blob;
}

/**
 * Retrieve a client registration by client_id from Postgres.
 * Updates last_used_at on access.
 */
export async function getClientRegistrationPg(
  clientId: string,
): Promise<OAuthClientInformationFull | undefined> {
  const result = await query<{ registration_blob: OAuthClientInformationFull }>(
    `UPDATE oauth_clients SET last_used_at = now()
     WHERE client_id = $1
     RETURNING registration_blob`,
    [clientId]
  );

  if (result.rows.length === 0) {
    return undefined;
  }

  return result.rows[0].registration_blob;
}
