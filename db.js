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

// Prevent unhandled error events from crashing the process
localPool.on("error", (err) => {
  console.error("⚠️  Local pool idle client error:", err.message);
});
neonPool.on("error", (err) => {
  console.error("⚠️  Neon pool idle client error:", err.message);
});

/* ── Hybrid wrapper ────────────────────────────────────── */
let usingNeon = false;
let manualOverride = false; // true = user switched manually, don't auto-failback
let lastFailoverTime = null;
let lastFailbackTime = null;
const FAILBACK_CHECK_INTERVAL = 60_000; // try local again every 60s
const FAILBACK_SYNC_TIMEOUT = 5 * 60 * 1000; // 5 min max for failback sync
let failbackFailCount = 0; // track consecutive failback failures
const MAX_FAILBACK_FAILS_BEFORE_FORCE = 3; // after 3 failed syncs, switch without sync

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

  /**
   * Incremental sync: Local → Neon, only changes since given timestamp.
   * Much faster than full sync for hourly updates.
   */
  async incrementalSyncToNeon(since) {
    return incrementalSyncBetweenPools(
      localPool,
      neonPool,
      "Local → Neon",
      since,
    );
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

/**
 * Helper: get topologically sorted table list (parents first).
 */
async function getOrderedTables(client) {
  const tablesRes = await client.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  const allTables = tablesRes.rows.map((r) => r.tablename);

  const fkRes = await client.query(`
    SELECT c1.relname AS child, c2.relname AS parent
    FROM pg_constraint con
    JOIN pg_class c1 ON c1.oid = con.conrelid
    JOIN pg_class c2 ON c2.oid = con.confrelid
    JOIN pg_namespace n1 ON n1.oid = c1.relnamespace
    WHERE con.contype = 'f' AND n1.nspname = 'public'
      AND c1.relname != c2.relname
  `);

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
    for (const parent of deps[table] || []) visit(parent);
    sorted.push(table);
  }
  allTables.forEach(visit);
  return sorted;
}

/**
 * Fast incremental sync: only sync rows changed since `since` timestamp.
 * Uses UPSERT only (no delete detection) — optimized for speed.
 * Chunk size 500 for fewer round-trips.
 */
async function incrementalSyncBetweenPools(
  sourcePool,
  targetPool,
  label,
  since,
) {
  let srcClient, dstClient;
  const startTime = Date.now();
  try {
    srcClient = await sourcePool.connect();
    dstClient = await targetPool.connect();
    await srcClient.query("SELECT 1");
    await dstClient.query("SELECT 1");

    const tables = await getOrderedTables(srcClient);
    if (tables.length === 0) throw new Error(`No tables found (${label})`);

    // Get primary key columns for each table (batch query)
    const allPKsRes = await srcClient.query(`
      SELECT c.relname AS tablename, a.attname
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indrelid
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE i.indisprimary AND n.nspname = 'public'
      ORDER BY c.relname, array_position(i.indkey, a.attnum)
    `);
    const tablePKs = {};
    for (const row of allPKsRes.rows) {
      if (!tablePKs[row.tablename]) tablePKs[row.tablename] = [];
      tablePKs[row.tablename].push(row.attname);
    }

    // Check which tables have updated_at (one query)
    const tsRes = await srcClient.query(
      "SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'updated_at'",
    );
    const hasTimestamp = new Set(tsRes.rows.map((r) => r.table_name));

    await dstClient.query("BEGIN");

    let totalUpserted = 0;
    let tablesChanged = 0;
    const CHUNK = 500;

    // UPSERT changed/new rows (dependency order — parents first)
    for (const table of tables) {
      const pks = tablePKs[table];
      if (!pks || pks.length === 0) continue;

      let data;
      if (hasTimestamp.has(table) && since) {
        data = await srcClient.query(
          `SELECT * FROM "${table}" WHERE updated_at >= $1`,
          [since],
        );
      } else {
        data = await srcClient.query(`SELECT * FROM "${table}"`);
      }

      if (data.rows.length === 0) continue;

      const cols = data.fields.map((f) => f.name);
      const colList = cols.map((c) => `"${c}"`).join(",");
      const pkCondition = pks.map((pk) => `"${pk}"`).join(",");
      const updateCols = cols.filter((c) => !pks.includes(c));
      const updateSet =
        updateCols.length > 0
          ? updateCols.map((c) => `"${c}" = EXCLUDED."${c}"`).join(",")
          : null;

      for (let i = 0; i < data.rows.length; i += CHUNK) {
        const chunk = data.rows.slice(i, i + CHUNK);
        const values = [];
        const params = [];
        let paramIdx = 1;

        for (const row of chunk) {
          const placeholders = cols.map(() => `$${paramIdx++}`);
          values.push(`(${placeholders.join(",")})`);
          for (const col of cols) params.push(row[col]);
        }

        const sql = updateSet
          ? `INSERT INTO "${table}" (${colList}) VALUES ${values.join(",")} ON CONFLICT (${pkCondition}) DO UPDATE SET ${updateSet}`
          : `INSERT INTO "${table}" (${colList}) VALUES ${values.join(",")} ON CONFLICT (${pkCondition}) DO NOTHING`;

        await dstClient.query(sql, params);
      }
      totalUpserted += data.rows.length;
      tablesChanged++;
      console.log(`  [${label}] ${table}: ${data.rows.length} rows upserted`);
    }

    // Reset sequences
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
    srcClient.release();
    srcClient = null;
    dstClient.release();
    dstClient = null;

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`  [${label}] Done in ${elapsed}s: ${totalUpserted} rows, ${tablesChanged} tables`);

    return {
      success: true,
      mode: "incremental",
      tables: tablesChanged,
      upserted: totalUpserted,
      deleted: 0,
      rows: totalUpserted,
      elapsed: parseFloat(elapsed),
    };
  } catch (err) {
    if (dstClient) {
      try { await dstClient.query("ROLLBACK"); } catch {}
      try { dstClient.release(); } catch {}
    }
    if (srcClient) {
      try { srcClient.release(); } catch {}
    }
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.error(`  [${label}] Failed after ${elapsed}s: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/* ── Periodic fail-back check ──────────────────────────── */
let failbackInProgress = false;
let failbackStartTime = null;

setInterval(async () => {
  if (!usingNeon) return;
  if (manualOverride) return; // user switched manually, don't auto-failback

  // Safety: if failback has been "in progress" for too long, force-reset the flag
  if (failbackInProgress) {
    const elapsed = Date.now() - (failbackStartTime || 0);
    if (elapsed > FAILBACK_SYNC_TIMEOUT) {
      console.error(
        `⚠️  Failback sync stuck for ${Math.round(elapsed / 1000)}s — force-resetting flag`,
      );
      failbackInProgress = false;
      failbackStartTime = null;
    } else {
      return; // still within timeout, wait
    }
  }

  try {
    const client = await localPool.connect();
    await client.query("SELECT 1");
    client.release();

    console.log("✅ Local DB is back online!");

    // If sync has failed too many times, switch directly without sync
    if (failbackFailCount >= MAX_FAILBACK_FAILS_BEFORE_FORCE) {
      console.log(
        `⚠️  Sync failed ${failbackFailCount} times — switching to Local WITHOUT sync`,
      );
      usingNeon = false;
      lastFailbackTime = Date.now();
      failbackFailCount = 0;
      failbackInProgress = false;
      failbackStartTime = null;
      console.log(
        "🔄 Switched to Local. Will sync Neon → Local in background...",
      );
      // Fire-and-forget background sync (non-blocking)
      pool
        .syncFromNeon()
        .then((r) => {
          if (r.success) {
            console.log(
              `✅ Background Neon → Local sync done: ${r.tables} tables, ${r.rows} rows`,
            );
          } else {
            console.error("❌ Background Neon → Local sync failed:", r.error);
          }
        })
        .catch((e) => {
          console.error("❌ Background Neon → Local sync error:", e.message);
        });
      return;
    }

    // Normal path: sync Neon → Local before switching
    console.log("🔄 Syncing Neon → Local before failback...");
    failbackInProgress = true;
    failbackStartTime = Date.now();

    // Wrap sync with a timeout
    const syncPromise = pool.syncFromNeon();
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("Failback sync timed out")),
        FAILBACK_SYNC_TIMEOUT,
      ),
    );

    const result = await Promise.race([syncPromise, timeoutPromise]);
    failbackInProgress = false;
    failbackStartTime = null;

    if (result.success) {
      console.log(
        `✅ Failback sync done: ${result.tables} tables, ${result.rows} rows — switching to Local`,
      );
      usingNeon = false;
      lastFailbackTime = Date.now();
      failbackFailCount = 0;
    } else {
      failbackFailCount++;
      console.error(
        `❌ Failback sync failed (attempt ${failbackFailCount}/${MAX_FAILBACK_FAILS_BEFORE_FORCE}):`,
        result.error,
        "— staying on Neon",
      );
    }
  } catch (err) {
    failbackInProgress = false;
    failbackStartTime = null;
    if (err.message === "Failback sync timed out") {
      failbackFailCount++;
      console.error(
        `❌ Failback sync timed out (attempt ${failbackFailCount}/${MAX_FAILBACK_FAILS_BEFORE_FORCE}) — staying on Neon`,
      );
    } else {
      // Local still down
      console.log("⏳ Local still down:", err.message);
    }
  }
}, FAILBACK_CHECK_INTERVAL);

/* ── Periodic auto-sync: Local → Neon (runs on Render 24/7) ── */
let lastSyncTime = null;
let lastSyncResult = null;
const SYNC_INTERVAL = 10 * 60 * 1000; // every 10 minutes

// Expose sync status on the pool object
Object.defineProperty(pool, "lastSyncTime", { get: () => lastSyncTime });
Object.defineProperty(pool, "lastSyncResult", { get: () => lastSyncResult });

async function runAutoSync() {
  if (usingNeon) {
    console.log("⏭️  Auto-sync skipped — currently on Neon");
    return;
  }

  const syncStart = Date.now();

  if (lastSyncTime) {
    // Subsequent runs: incremental sync (fast)
    console.log("🔄 Incremental sync started: Local → Neon...");
    const result = await pool.incrementalSyncToNeon(new Date(lastSyncTime));
    lastSyncTime = syncStart;
    lastSyncResult = result;
    if (result.success) {
      console.log(
        `✅ Incremental sync done: ${result.upserted} upserted, ${result.deleted} deleted`,
      );
    } else {
      console.error("❌ Incremental sync failed:", result.error);
    }
  } else {
    // First run after startup: full sync to establish baseline
    console.log("🔄 Initial full sync started: Local → Neon...");
    const result = await pool.syncToNeon();
    lastSyncTime = syncStart;
    lastSyncResult = { ...result, mode: "full" };
    if (result.success) {
      console.log(
        `✅ Initial full sync completed: ${result.tables} tables, ${result.rows} rows`,
      );
    } else {
      console.error("❌ Initial full sync failed:", result.error);
    }
  }
}

// Run first sync 30 seconds after startup, then every hour
setTimeout(() => {
  runAutoSync();
  setInterval(runAutoSync, SYNC_INTERVAL);
}, 30_000);

/* ── Daily full sync at 3:00 AM Cairo (1:00 AM UTC) ─── */
async function runDailyFullSync() {
  if (usingNeon) {
    console.log("⏭️  Daily full sync skipped — currently on Neon");
    return;
  }
  console.log("🔄 Daily full sync started: Local → Neon...");
  const syncStart = Date.now();
  const result = await pool.syncToNeon();
  lastSyncTime = syncStart;
  lastSyncResult = { ...result, mode: "full" };
  if (result.success) {
    console.log(
      `✅ Daily full sync completed: ${result.tables} tables, ${result.rows} rows`,
    );
  } else {
    console.error("❌ Daily full sync failed:", result.error);
  }
}

function scheduleDailyFullSync() {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(1, 0, 0, 0); // 1:00 AM UTC = 3:00 AM Cairo (UTC+2)
  if (now >= next) next.setUTCDate(next.getUTCDate() + 1);

  const ms = next.getTime() - now.getTime();
  console.log(
    `📅 Daily full sync scheduled in ${Math.round(ms / 60000)} minutes (3:00 AM Cairo)`,
  );

  setTimeout(() => {
    runDailyFullSync();
    setInterval(runDailyFullSync, 24 * 60 * 60 * 1000);
  }, ms);
}

scheduleDailyFullSync();

module.exports = pool;
