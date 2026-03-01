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
      console.log(`🔄 ${manual ? "Manually" : "Auto"} switched to Neon`);
    } else {
      usingNeon = false;
      manualOverride = false;
      lastFailbackTime = Date.now();
      console.log(`🔄 ${manual ? "Manually" : "Auto"} switched to Local`);
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
    return syncBetweenPools(localPool, neonPool, "Local → Neon");
  },

  /**
   * Sync all data from Neon → Local using node-pg.
   * Used during failback to restore data written to Neon while local was down.
   * Returns { success, tables, rows, error }
   */
  async syncFromNeon() {
    return syncBetweenPools(neonPool, localPool, "Neon → Local");
  },
};

/**
 * Generic sync: read all tables from sourcePool → write to targetPool.
 * Uses TRUNCATE CASCADE + INSERT in dependency-aware order.
 */
async function syncBetweenPools(sourcePool, targetPool, label) {
  let srcClient, dstClient;
  try {
    // 1. Connect to source
    srcClient = await sourcePool.connect();
    await srcClient.query("SELECT 1");

    // 2. Get all user tables
    const tablesRes = await srcClient.query(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' ORDER BY tablename
    `);
    const allTables = tablesRes.rows.map((r) => r.tablename);
    if (allTables.length === 0)
      throw new Error(`No tables found in source (${label})`);

    // 3. Build FK dependency graph (exclude self-references)
    const fkRes = await srcClient.query(`
      SELECT c1.relname AS child, c2.relname AS parent
      FROM pg_constraint con
      JOIN pg_class c1 ON c1.oid = con.conrelid
      JOIN pg_class c2 ON c2.oid = con.confrelid
      JOIN pg_namespace n1 ON n1.oid = c1.relnamespace
      WHERE con.contype = 'f' AND n1.nspname = 'public'
        AND c1.relname != c2.relname
    `);

    // Topological sort: parents first
    const deps = {};
    allTables.forEach((t) => (deps[t] = new Set()));
    fkRes.rows.forEach((r) => {
      if (deps[r.child]) deps[r.child].add(r.parent);
    });

    const sorted = [];
    const visited = new Set();
    function visit(table) {
      if (visited.has(table)) return;
      visited.add(table);
      for (const parent of deps[table] || []) {
        visit(parent);
      }
      sorted.push(table);
    }
    allTables.forEach(visit);
    const tables = sorted;

    // 4. Read all data from source
    const tableData = {};
    for (const table of tables) {
      const res = await srcClient.query(`SELECT * FROM "${table}"`);
      tableData[table] = res;
    }
    srcClient.release();
    srcClient = null;

    // 5. Write to target
    dstClient = await targetPool.connect();
    await dstClient.query("BEGIN");

    // Truncate all tables (reverse order to respect FKs)
    for (let i = tables.length - 1; i >= 0; i--) {
      await dstClient.query(`TRUNCATE "${tables[i]}" CASCADE`);
    }

    // Insert in dependency order (parents first, children after)
    let totalRows = 0;
    for (const table of tables) {
      const data = tableData[table];
      if (data.rows.length === 0) continue;

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

        await dstClient.query(
          `INSERT INTO "${table}" (${colList}) VALUES ${values.join(",")}`,
          params,
        );
      }
      totalRows += data.rows.length;
    }

    // Reset sequences to max(id)
    for (const table of tables) {
      try {
        await dstClient.query(`
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

    await dstClient.query("COMMIT");
    dstClient.release();
    dstClient = null;

    return { success: true, tables: tables.length, rows: totalRows };
  } catch (err) {
    if (dstClient) {
      try {
        await dstClient.query("ROLLBACK");
      } catch {}
      try {
        dstClient.release();
      } catch {}
    }
    if (srcClient) {
      try {
        srcClient.release();
      } catch {}
    }
    return { success: false, error: err.message };
  }
}

/* ── Periodic fail-back check ──────────────────────────── */
let failbackInProgress = false;
setInterval(async () => {
  if (!usingNeon) return;
  if (manualOverride) return; // user switched manually, don't auto-failback
  if (failbackInProgress) return; // already syncing
  try {
    const client = await localPool.connect();
    await client.query("SELECT 1");
    client.release();

    // Local is back! Sync Neon → Local BEFORE switching
    console.log(
      "✅ Local DB is back online — syncing Neon → Local before failback...",
    );
    failbackInProgress = true;
    const result = await pool.syncFromNeon();
    failbackInProgress = false;

    if (result.success) {
      console.log(
        `✅ Failback sync done: ${result.tables} tables, ${result.rows} rows — switching to Local`,
      );
      usingNeon = false;
      lastFailbackTime = Date.now();
    } else {
      console.error(
        "❌ Failback sync failed:",
        result.error,
        "— staying on Neon",
      );
    }
  } catch {
    failbackInProgress = false;
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
