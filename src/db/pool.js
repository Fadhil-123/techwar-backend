const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

pool.on('connect', () => {
  console.log('[DB] New client connected to pool');
});

/**
 * Execute a query with optional params.
 * Wraps pool.query for consistent error handling.
 */
async function query(text, params) {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    if (duration > 500) {
      console.warn(`[DB] Slow query (${duration}ms):`, text.substring(0, 80));
    }
    return result;
  } catch (err) {
    console.error('[DB] Query error:', err.message);
    console.error('[DB] Query text:', text.substring(0, 200));
    throw err;
  }
}

/**
 * Get a client from the pool for transaction use.
 * MUST call client.release() when done.
 */
async function getClient() {
  const client = await pool.connect();
  return client;
}

module.exports = { pool, query, getClient };
