import pg from 'pg';
import { logger } from './logger.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function isPostgresReady(): boolean {
  return pool !== null;
}

export function getPool(): pg.Pool {
  if (!pool) {
    throw new Error('Postgres pool not initialized. Call initPostgres() first.');
  }
  return pool;
}

export async function initPostgres(databaseUrl: string): Promise<void> {
  pool = new Pool({ connectionString: databaseUrl });

  pool.on('error', (err) => {
    logger.error('Unexpected Postgres pool error', err);
  });

  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
  } finally {
    client.release();
  }
}

export async function shutdownPostgres(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * Execute a callback within a transaction that has the RLS user context set.
 * Uses SET LOCAL so the variable is scoped to the transaction only,
 * preventing context leakage across pooled connections.
 */
export async function withUserContext<T>(
  userId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL app.user_id = $1", [userId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Execute a query directly against the pool (no RLS context).
 * Use for operations that don't need user-scoped access.
 */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params);
}
