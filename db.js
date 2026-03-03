const { Pool } = require("pg");
require("dotenv").config();

/* ══════════════════════════════════════════════════════════
   Dual-Pool DB Manager: Local (primary) + Cloud (secondary)
   ── Multi-master with automatic failover & bi-directional sync
   ══════════════════════════════════════════════════════════ */

/* ── Pool configuration ── */
const POOL_OPTS = { connectionTimeoutMillis: 5000, max: 10 };

const localPool = new Pool({
  host: process.env.DB_HOST_LOCAL,
  port: Number(process.env.DB_PORT_LOCAL || 5432),
  user: process.env.DB_USER_LOCAL,
  password: process.env.DB_PASSWORD_LOCAL,
  database: process.env.DB_NAME_LOCAL,
  ssl:
    process.env.DB_SSL_LOCAL === "true" ? { rejectUnauthorized: false } : false,
  ...POOL_OPTS,
});

const cloudPool = new Pool({
  host: process.env.DB_HOST_CLOUD,
  port: Number(process.env.DB_PORT_CLOUD || 5432),
  user: process.env.DB_USER_CLOUD,
  password: process.env.DB_PASSWORD_CLOUD,
  database: process.env.DB_NAME_CLOUD,
  ssl:
    process.env.DB_SSL_CLOUD === "true" ? { rejectUnauthorized: false } : false,
  ...POOL_OPTS,
});

/* ── Set timezone on every new connection ── */
localPool.on("connect", (c) => c.query("SET timezone = 'Africa/Cairo'"));
cloudPool.on("connect", (c) => c.query("SET timezone = 'Africa/Cairo'"));

/* ── Prevent crashes from idle-client errors ── */
localPool.on("error", (err) =>
  console.error("⚠️  Local pool error:", err.message),
);
cloudPool.on("error", (err) =>
  console.error("⚠️  Cloud pool error:", err.message),
);

/* ── State tracking ── */
const state = {
  activeDb: "local", // "local" | "cloud"
  localAlive: true,
  cloudAlive: true,
  lastSyncTime: null, // ISO string
  syncInProgress: false,
  lastSyncResult: null, // { ok, synced, errors, duration, time }
  failoverHistory: [], // [{ from, to, time, reason }]
};

/* ── Health check helpers ── */
async function checkPool(pool, label) {
  try {
    const client = await pool.connect();
    await client.query("SELECT 1");
    client.release();
    return true;
  } catch (err) {
    console.error(`❌ ${label} health check failed:`, err.message);
    return false;
  }
}

/* ── Periodic health checks (every 15s) ── */
setInterval(async () => {
  const wasLocalAlive = state.localAlive;
  const wasCloudAlive = state.cloudAlive;

  state.localAlive = await checkPool(localPool, "Local");
  state.cloudAlive = await checkPool(cloudPool, "Cloud");

  // Auto-failover: local dies → switch to cloud
  if (state.activeDb === "local" && !state.localAlive && state.cloudAlive) {
    state.activeDb = "cloud";
    const record = {
      from: "local",
      to: "cloud",
      time: new Date().toISOString(),
      reason: "Local DB unreachable",
    };
    state.failoverHistory.push(record);
    console.log("🔄 FAILOVER: local → cloud", record);
  }

  // Auto-failback: local recovered → sync first, then switch back
  if (state.activeDb === "cloud" && state.localAlive) {
    console.log("🔄 Local DB recovered — syncing cloud → local before failback...");
    // Sync cloud data to local BEFORE switching back
    try {
      await syncBetweenPools();
      console.log("✅ Pre-failback sync complete");
    } catch (err) {
      console.error("⚠️  Pre-failback sync error (switching anyway):", err.message);
    }
    state.activeDb = "local";
    const record = {
      from: "cloud",
      to: "local",
      time: new Date().toISOString(),
      reason: "Local DB recovered (synced before switch)",
    };
    state.failoverHistory.push(record);
    console.log("🔄 FAILBACK: cloud → local", record);
  }

  // Log state changes
  if (wasLocalAlive !== state.localAlive)
    console.log(`📡 Local DB: ${state.localAlive ? "UP ✅" : "DOWN ❌"}`);
  if (wasCloudAlive !== state.cloudAlive)
    console.log(`☁️  Cloud DB: ${state.cloudAlive ? "UP ✅" : "DOWN ❌"}`);
}, 15000);

/* ── Get the active pool ── */
function getActivePool() {
  return state.activeDb === "local" ? localPool : cloudPool;
}

/* ══════════════════════════════════════════════════════════
   Bi-directional Sync Engine
   ── Compares updated_at timestamps, newer row wins
   ══════════════════════════════════════════════════════════ */

// Tables to sync and their primary keys
const SYNC_TABLES = [
  { table: "warehouses", pk: ["id"] },
  { table: "manufacturers", pk: ["id"] },
  { table: "products", pk: ["id"] },
  { table: "product_variants", pk: ["id"] },
  { table: "stock", pk: ["warehouse_id", "product_id", "variant_id"] },
  { table: "customers", pk: ["id"] },
  { table: "customer_phones", pk: ["id"] },
  { table: "suppliers", pk: ["id"] },
  { table: "supplier_phones", pk: ["id"] },
  { table: "users", pk: ["id"] },
  { table: "invoices", pk: ["id"] },
  { table: "invoice_items", pk: ["id"] },
  { table: "stock_transfers", pk: ["id"] },
  { table: "stock_transfer_items", pk: ["id"] },
  { table: "stock_movements", pk: ["id"] },
  { table: "cash_in", pk: ["id"] },
  { table: "cash_out", pk: ["id"] },
  { table: "daily_cash", pk: ["id"] },
  { table: "branches", pk: ["id"] },
  { table: "notifications", pk: ["id"] },
  { table: "conversations", pk: ["id"] },
  { table: "conversation_participants", pk: ["conversation_id", "user_id"] },
  { table: "messages", pk: ["id"] },
  { table: "user_activity", pk: ["id"] },
];

async function syncBetweenPools() {
  if (state.syncInProgress) {
    console.log("⏳ Sync already in progress, skipping");
    return { ok: false, message: "Sync already running" };
  }
  if (!state.localAlive || !state.cloudAlive) {
    console.log("⚠️  Cannot sync — one or both DBs unreachable");
    return { ok: false, message: "One or both DBs unreachable" };
  }

  state.syncInProgress = true;
  const startTime = Date.now();
  let totalSynced = 0;
  let totalErrors = 0;
  const errorDetails = [];

  console.log("🔄 Starting bi-directional sync...");

  try {
    for (const { table, pk } of SYNC_TABLES) {
      try {
        const synced = await syncTable(table, pk);
        totalSynced += synced;
      } catch (err) {
        totalErrors++;
        errorDetails.push(`${table}: ${err.message}`);
        console.error(`❌ Sync error for ${table}:`, err.message);
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    state.lastSyncTime = new Date().toISOString();
    state.lastSyncResult = {
      ok: totalErrors === 0,
      synced: totalSynced,
      errors: totalErrors,
      errorDetails: errorDetails.length ? errorDetails : undefined,
      duration: `${duration}s`,
      time: state.lastSyncTime,
    };

    console.log(
      `✅ Sync complete: ${totalSynced} rows synced, ${totalErrors} errors, ${duration}s`,
    );
    return state.lastSyncResult;
  } catch (err) {
    console.error("❌ Sync failed:", err.message);
    state.lastSyncResult = {
      ok: false,
      message: err.message,
      time: new Date().toISOString(),
    };
    return state.lastSyncResult;
  } finally {
    state.syncInProgress = false;
  }
}

async function syncTable(table, pk) {
  let synced = 0;

  // Check if table has updated_at column
  const colCheck = await localPool.query(
    `SELECT column_name FROM information_schema.columns 
     WHERE table_name = $1 AND column_name = 'updated_at'`,
    [table],
  );
  const hasUpdatedAt = colCheck.rows.length > 0;

  // Get all columns for this table
  const colsResult = await localPool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`,
    [table],
  );
  const columns = colsResult.rows.map((r) => r.column_name);

  // Fetch all rows from both sides
  const localRows = await localPool.query(`SELECT * FROM "${table}"`);
  const cloudRows = await cloudPool.query(`SELECT * FROM "${table}"`);

  // Build lookup maps keyed by PK
  const pkKey = (row) => pk.map((k) => String(row[k])).join("|");
  const localMap = new Map();
  const cloudMap = new Map();
  localRows.rows.forEach((r) => localMap.set(pkKey(r), r));
  cloudRows.rows.forEach((r) => cloudMap.set(pkKey(r), r));

  // Collect upsert operations, then execute with retry for self-referencing FKs
  const pendingOps = [];

  // ── Local → Cloud: rows in local but not in cloud, or newer in local ──
  for (const [key, localRow] of localMap) {
    const cloudRow = cloudMap.get(key);
    if (!cloudRow) {
      pendingOps.push({ pool: cloudPool, row: localRow });
    } else if (hasUpdatedAt && localRow.updated_at && cloudRow.updated_at) {
      const localTime = new Date(localRow.updated_at).getTime();
      const cloudTime = new Date(cloudRow.updated_at).getTime();
      if (localTime > cloudTime) {
        pendingOps.push({ pool: cloudPool, row: localRow });
      }
    }
  }

  // ── Cloud → Local: rows in cloud but not in local, or newer in cloud ──
  for (const [key, cloudRow] of cloudMap) {
    const localRow = localMap.get(key);
    if (!localRow) {
      pendingOps.push({ pool: localPool, row: cloudRow });
    } else if (hasUpdatedAt && cloudRow.updated_at && localRow.updated_at) {
      const cloudTime = new Date(cloudRow.updated_at).getTime();
      const localTime = new Date(localRow.updated_at).getTime();
      if (cloudTime > localTime) {
        pendingOps.push({ pool: localPool, row: cloudRow });
      }
    }
  }

  // Execute with retry — handles self-referencing FK constraints
  // (e.g. messages.reply_to_id → messages.id)
  let remaining = pendingOps;
  const MAX_PASSES = 3;

  for (let pass = 0; pass < MAX_PASSES && remaining.length > 0; pass++) {
    const failed = [];
    for (const op of remaining) {
      try {
        await upsertRow(op.pool, table, columns, pk, op.row);
        synced++;
      } catch (err) {
        // Only retry FK violations, re-throw others
        if (err.code === "23503") {
          failed.push(op);
        } else {
          throw err;
        }
      }
    }
    if (failed.length === remaining.length) {
      // No progress — stop retrying and throw
      throw new Error(`FK constraint: ${failed.length} rows stuck after ${pass + 1} passes`);
    }
    remaining = failed;
  }

  if (remaining.length > 0) {
    throw new Error(`FK constraint: ${remaining.length} rows could not be synced after ${MAX_PASSES} passes`);
  }

  if (synced > 0) console.log(`  📋 ${table}: ${synced} rows synced`);
  return synced;
}

async function upsertRow(targetPool, table, columns, pk, row) {
  const vals = columns.map((c) => row[c]);
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
  const colList = columns.map((c) => `"${c}"`).join(", ");
  const pkList = pk.map((k) => `"${k}"`).join(", ");
  const updateCols = columns
    .filter((c) => !pk.includes(c))
    .map((c) => `"${c}" = EXCLUDED."${c}"`)
    .join(", ");

  const sql = updateCols
    ? `INSERT INTO "${table}" (${colList}) VALUES (${placeholders})
       ON CONFLICT (${pkList}) DO UPDATE SET ${updateCols}`
    : `INSERT INTO "${table}" (${colList}) VALUES (${placeholders})
       ON CONFLICT (${pkList}) DO NOTHING`;

  await targetPool.query(sql, vals);
}

/* ── Periodic sync (every 5 minutes) ── */
let syncInterval = null;
function startPeriodicSync() {
  // Do an initial sync 30s after startup
  setTimeout(() => syncBetweenPools(), 30000);
  // Then every 5 minutes
  syncInterval = setInterval(() => syncBetweenPools(), 5 * 60 * 1000);
}
startPeriodicSync();

/* ── Exports ── */
// Default export is a Proxy that routes queries to the active pool
const pool = new Proxy(localPool, {
  get(target, prop) {
    const activePool = getActivePool();
    const val = activePool[prop];
    return typeof val === "function" ? val.bind(activePool) : val;
  },
});

module.exports = pool;
module.exports.localPool = localPool;
module.exports.cloudPool = cloudPool;
module.exports.dbState = state;
module.exports.syncBetweenPools = syncBetweenPools;
module.exports.checkPool = checkPool;
module.exports.getActivePool = getActivePool;
