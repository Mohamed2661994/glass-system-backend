const { Pool } = require("pg");
require("dotenv").config();

/* ── Primary: Local Server ─────────────────────────────── */
const localPool = new Pool({
  host: process.env.DB_HOST_LOCAL,
  port: Number(process.env.DB_PORT_LOCAL || 5432),
  user: process.env.DB_USER_LOCAL,
  password: process.env.DB_PASSWORD_LOCAL,
  database: process.env.DB_NAME_LOCAL,
  ssl:
    process.env.DB_SSL_LOCAL === "true" ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 5000,
});

/* ── Fallback: Neon Cloud ──────────────────────────────── */
const neonPool = new Pool({
  host: process.env.DB_HOST_NEON,
  port: Number(process.env.DB_PORT_NEON || 5432),
  user: process.env.DB_USER_NEON,
  password: process.env.DB_PASSWORD_NEON,
  database: process.env.DB_NAME_NEON,
  ssl:
    process.env.DB_SSL_NEON === "true" ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 5000,
});

// Set timezone to Africa/Cairo for every new connection
localPool.on("connect", (client) => {
  client.query("SET timezone = 'Africa/Cairo'");
});
neonPool.on("connect", (client) => {
  client.query("SET timezone = 'Africa/Cairo'");
});

/* ── Hybrid wrapper ────────────────────────────────────── */
let usingNeon = false;
let manualOverride = false; // true = user switched manually, don't auto-failback
let lastFailoverTime = null;
let lastFailbackTime = null;
const FAILBACK_CHECK_INTERVAL = 60_000; // try local again every 60s

/**
 * Returns a client from the local pool.
 * If local is down, transparently falls back to Neon.
 */
async function getClient() {
  if (!usingNeon) {
    try {
      const client = await localPool.connect();
      return client;
    } catch (err) {
      console.error(
        "⚠️  Local DB unreachable, switching to Neon:",
        err.message,
      );
      usingNeon = true;
      manualOverride = false; // auto-failover, allow auto-failback
      lastFailoverTime = Date.now();
    }
  }
  // Fallback to Neon
  return neonPool.connect();
}

/**
 * Proxy object that mimics pg.Pool but routes through the hybrid logic.
 * Supports pool.query() and pool.connect() so existing code works unchanged.
 */
const pool = {
  async query(...args) {
    const client = await getClient();
    try {
      return await client.query(...args);
    } finally {
      client.release();
    }
  },

  async connect() {
    return getClient();
  },

  // Expose which DB is active (useful for health checks)
  get activeDb() {
    return usingNeon ? "neon" : "local";
  },

  get lastFailoverTime() {
    return lastFailoverTime;
  },

  get lastFailbackTime() {
    return lastFailbackTime;
  },

  /** Manually switch active DB */
  switchTo(target, manual = true) {
    if (target === "neon") {
      usingNeon = true;
      if (manual) manualOverride = true;
      lastFailoverTime = Date.now();
      console.log(`🔄 ${manual ? 'Manually' : 'Auto'} switched to Neon`);
    } else {
      usingNeon = false;
      manualOverride = false;
      lastFailbackTime = Date.now();
      console.log(`🔄 ${manual ? 'Manually' : 'Auto'} switched to Local`);
    }
  },

  get isManualOverride() {
    return manualOverride;
  },

  /** Test connectivity to a specific pool */
  async testConnection(target) {
    const p = target === "neon" ? neonPool : localPool;
    const client = await p.connect();
    await client.query("SELECT 1");
    client.release();
    return true;
  },
};

/* ── Periodic fail-back check ──────────────────────────── */
setInterval(async () => {
  if (!usingNeon) return;
  if (manualOverride) return; // user switched manually, don't auto-failback
  try {
    const client = await localPool.connect();
    await client.query("SELECT 1");
    client.release();
    console.log("✅ Local DB is back online — switching back from Neon");
    usingNeon = false;
    lastFailbackTime = Date.now();
  } catch {
    // still down, stay on Neon
  }
}, FAILBACK_CHECK_INTERVAL);

module.exports = pool;
