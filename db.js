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

  /**
   * Sync all data from Local → Neon using node-pg (no pg_dump needed).
   * Works from anywhere (Render, etc.) as long as local DB is reachable.
   * Returns { success, tables, rows, error }
   */
  async syncToNeon() {
    let localClient, neonClient;
    try {
      // 1. Connect to local
      localClient = await localPool.connect();
      await localClient.query("SELECT 1"); // quick test

      // 2. Get all user tables
      const tablesRes = await localClient.query(`
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public'
        ORDER BY tablename
      `);
      const tables = tablesRes.rows.map((r) => r.tablename);
      if (tables.length === 0) throw new Error("No tables found in local DB");

      // 3. Read all data from local
      const tableData = {};
      for (const table of tables) {
        const res = await localClient.query(`SELECT * FROM "${table}"`);
        tableData[table] = res;
      }
      localClient.release();
      localClient = null;

      // 4. Write to Neon
      neonClient = await neonPool.connect();
      await neonClient.query("BEGIN");

      // Disable FK checks during sync
      await neonClient.query("SET session_replication_role = replica");

      let totalRows = 0;
      for (const table of tables) {
        // Truncate target table
        await neonClient.query(`TRUNCATE "${table}" CASCADE`);

        const data = tableData[table];
        if (data.rows.length === 0) continue;

        // Batch insert using multi-row VALUES for speed
        const cols = data.fields.map((f) => f.name);
        const colList = cols.map((c) => `"${c}"`).join(",");

        // Insert in chunks of 100 rows
        const CHUNK = 100;
        for (let i = 0; i < data.rows.length; i += CHUNK) {
          const chunk = data.rows.slice(i, i + CHUNK);
          const values = [];
          const params = [];
          let paramIdx = 1;

          for (const row of chunk) {
            const placeholders = cols.map(() => `$${paramIdx++}`);
            values.push(`(${placeholders.join(",")})`);
            for (const col of cols) {
              params.push(row[col]);
            }
          }

          await neonClient.query(
            `INSERT INTO "${table}" (${colList}) VALUES ${values.join(",")}`,
            params,
          );
        }
        totalRows += data.rows.length;
      }

      // Reset sequences to max(id)
      for (const table of tables) {
        try {
          await neonClient.query(`
            SELECT setval(
              pg_get_serial_sequence('"${table}"', 'id'),
              COALESCE((SELECT MAX(id) FROM "${table}"), 1),
              (SELECT MAX(id) FROM "${table}") IS NOT NULL
            )
          `);
        } catch {
          // no serial column — skip
        }
      }

      // Re-enable FK checks
      await neonClient.query("SET session_replication_role = DEFAULT");
      await neonClient.query("COMMIT");
      neonClient.release();
      neonClient = null;

      return { success: true, tables: tables.length, rows: totalRows };
    } catch (err) {
      if (neonClient) {
        try { await neonClient.query("ROLLBACK"); } catch {}
        try { neonClient.release(); } catch {}
      }
      if (localClient) {
        try { localClient.release(); } catch {}
      }
      return { success: false, error: err.message };
    }
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

/* ── Periodic auto-sync: Local → Neon (runs on Render 24/7) ── */
let lastSyncTime = null;
let lastSyncResult = null;
const SYNC_INTERVAL = 60 * 60 * 1000; // every 1 hour

// Expose sync status on the pool object
Object.defineProperty(pool, "lastSyncTime", { get: () => lastSyncTime });
Object.defineProperty(pool, "lastSyncResult", { get: () => lastSyncResult });

async function runAutoSync() {
  // Only sync if local is reachable (no point syncing if already on Neon)
  if (usingNeon) {
    console.log("⏭️  Auto-sync skipped — currently on Neon");
    return;
  }
  console.log("🔄 Auto-sync started: Local → Neon...");
  const result = await pool.syncToNeon();
  lastSyncTime = Date.now();
  lastSyncResult = result;
  if (result.success) {
    console.log(
      `✅ Auto-sync completed: ${result.tables} tables, ${result.rows} rows`,
    );
  } else {
    console.error("❌ Auto-sync failed:", result.error);
  }
}

// Run first sync 30 seconds after startup, then every hour
setTimeout(() => {
  runAutoSync();
  setInterval(runAutoSync, SYNC_INTERVAL);
}, 30_000);

module.exports = pool;
