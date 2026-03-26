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
  manualLock: false, // true = manual switch, prevents auto-failback
  manualLockTime: null, // timestamp when manual lock was set (for 1-hour timeout)
  periodicSyncIntervalMs: 15 * 60 * 1000,
  nextPeriodicSyncAt: null, // ISO string
  lastRealtimeSyncAt: null, // ISO string
  syncLogs: [], // recent sync attempts
};

const MAX_SYNC_LOGS = 200;

function pushSyncLog(entry) {
  state.syncLogs.unshift(entry);
  if (state.syncLogs.length > MAX_SYNC_LOGS) {
    state.syncLogs = state.syncLogs.slice(0, MAX_SYNC_LOGS);
  }
}

function getSyncLogs(limit = 100) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, MAX_SYNC_LOGS));
  return state.syncLogs.slice(0, safeLimit);
}

/* ── Realtime sync scheduler (debounced) ── */
let realtimeSyncTimer = null;
let realtimeSyncRequested = false;
let pendingRealtimeOps = [];
const OUTBOX_BATCH_LIMIT = 25;

function mapTableLabel(table) {
  const labels = {
    invoices: "فاتورة",
    invoice_items: "بند فاتورة",
    online_invoice_audit: "أرشيف فاتورة أونلاين",
    customers: "عميل",
    suppliers: "مورد",
    products: "صنف",
    product_variants: "متغير صنف",
    stock: "مخزون",
    stock_movements: "حركة مخزون",
    stock_transfers: "تحويل",
    stock_transfer_items: "بند تحويل",
    cash_in: "وارد",
    cash_out: "منصرف",
    daily_cash: "خزنة يومية",
    users: "مستخدم",
    notifications: "إشعار",
    messages: "رسالة",
    conversations: "محادثة",
  };
  return labels[table] || table;
}

function normalizeSqlIdentifier(raw) {
  return String(raw || "")
    .replace(/"/g, "")
    .trim()
    .toLowerCase();
}

function parseInsertColumns(sql) {
  const match = sql.match(/^insert\s+into\s+"?[a-z0-9_]+"?\s*\(([^)]+)\)/i);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((c) => normalizeSqlIdentifier(c))
    .filter(Boolean);
}

function pickIdFromResultRow(row) {
  if (!row || typeof row !== "object") return null;
  if (row.id != null) return row.id;

  const preferredKeys = [
    "invoice_id",
    "stock_transfer_id",
    "transfer_id",
    "cash_in_id",
    "cash_out_id",
    "movement_id",
    "customer_id",
    "supplier_id",
    "product_id",
  ];

  for (const key of preferredKeys) {
    if (row[key] != null) return row[key];
  }

  return null;
}

function parseOperationInfo(sql, params = [], result = null) {
  const cleaned = stripLeadingSqlComments(sql);
  const lower = cleaned.toLowerCase();

  let operation = null;
  let table = null;

  let m = lower.match(/^insert\s+into\s+"?([a-z0-9_]+)"?/i);
  if (m) {
    operation = "insert";
    table = m[1];
  }

  if (!operation) {
    m = lower.match(/^update\s+"?([a-z0-9_]+)"?/i);
    if (m) {
      operation = "update";
      table = m[1];
    }
  }

  if (!operation) {
    m = lower.match(/^delete\s+from\s+"?([a-z0-9_]+)"?/i);
    if (m) {
      operation = "delete";
      table = m[1];
    }
  }

  if (!operation || !table) return null;

  const detail = {
    operation,
    table,
    tableLabel: mapTableLabel(table),
    id: null,
    rowCount: Number(result?.rowCount) || 0,
  };

  if (result?.rows?.[0]) {
    detail.id = pickIdFromResultRow(result.rows[0]);
  }

  if (detail.id == null && Array.isArray(params) && params.length > 0) {
    if (operation === "insert") {
      const columns = parseInsertColumns(cleaned);
      const idIndex = columns.findIndex((c) => c === "id");
      if (idIndex >= 0 && params[idIndex] != null) {
        detail.id = params[idIndex];
      }
    } else {
      const idMatch = lower.match(/\bid\s*=\s*\$(\d+)/i);
      if (idMatch) {
        const paramIndex = Number(idMatch[1]) - 1;
        if (paramIndex >= 0 && paramIndex < params.length) {
          detail.id = params[paramIndex];
        }
      }
    }
  }

  if (
    detail.id == null &&
    Array.isArray(params) &&
    params.length > 0 &&
    (operation === "update" || operation === "delete")
  ) {
    const lastParam = params[params.length - 1];
    if (typeof lastParam === "number" || typeof lastParam === "string") {
      detail.id = lastParam;
    }
  }

  return detail;
}

function pushRealtimeOperation(op) {
  if (!op) return;
  pendingRealtimeOps.push({ ...op, time: new Date().toISOString() });
  if (pendingRealtimeOps.length > 60) {
    pendingRealtimeOps = pendingRealtimeOps.slice(-60);
  }
}

function consumeRealtimeOperations() {
  const ops = pendingRealtimeOps;
  pendingRealtimeOps = [];
  return ops;
}

function buildSyncMessage(ok, details, fallbackMessage) {
  if (!Array.isArray(details) || details.length === 0) {
    return fallbackMessage;
  }

  const first = details[0];
  const opMap = {
    insert: ok ? "تمت مزامنة" : "فشلت مزامنة",
    update: ok ? "تمت مزامنة تعديل" : "فشلت مزامنة تعديل",
    delete: ok ? "تمت مزامنة حذف" : "فشلت مزامنة حذف",
  };
  const action = opMap[first.operation] || (ok ? "تمت مزامنة" : "فشلت مزامنة");
  const idPart = first.id != null ? ` رقم ${first.id}` : "";
  const extra = details.length > 1 ? ` + ${details.length - 1} عملية أخرى` : "";

  return `${action} ${first.tableLabel}${idPart}${extra}`;
}

function normalizeCompareValue(value) {
  if (value instanceof Date) return value.getTime();
  if (value === null || value === undefined) return null;
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return value;
}

function rowsDifferIgnoringUpdatedAt(leftRow, rightRow, columns) {
  for (const column of columns) {
    if (column === "updated_at") continue;
    const left = normalizeCompareValue(leftRow?.[column]);
    const right = normalizeCompareValue(rightRow?.[column]);
    if (left !== right) return true;
  }
  return false;
}

function extractSqlText(args) {
  const first = args?.[0];
  if (typeof first === "string") return first;
  if (first && typeof first === "object" && typeof first.text === "string") {
    return first.text;
  }
  return "";
}

function stripLeadingSqlComments(sql) {
  let s = String(sql || "").trimStart();
  // Remove leading line comments
  while (s.startsWith("--")) {
    const nl = s.indexOf("\n");
    if (nl === -1) return "";
    s = s.slice(nl + 1).trimStart();
  }
  // Remove leading block comments
  while (s.startsWith("/*")) {
    const end = s.indexOf("*/");
    if (end === -1) return "";
    s = s.slice(end + 2).trimStart();
  }
  return s;
}

function isMutatingQuery(sql) {
  const cleaned = stripLeadingSqlComments(sql).toLowerCase();
  if (!cleaned) return false;
  if (
    cleaned.startsWith("insert") ||
    cleaned.startsWith("update") ||
    cleaned.startsWith("delete")
  ) {
    return true;
  }
  if (cleaned.startsWith("with")) {
    return /\b(insert|update|delete)\b/.test(cleaned);
  }
  return false;
}

function getTransactionControl(sql) {
  const cleaned = stripLeadingSqlComments(sql).toLowerCase();
  if (!cleaned) return null;
  if (/^begin\b/.test(cleaned) || /^start\s+transaction\b/.test(cleaned)) {
    return "begin";
  }
  if (/^commit\b/.test(cleaned)) {
    return "commit";
  }
  if (/^rollback\b/.test(cleaned)) {
    return "rollback";
  }
  return null;
}

function pushRealtimeOperations(ops) {
  if (!Array.isArray(ops) || ops.length === 0) return;
  for (const op of ops) {
    pushRealtimeOperation(op);
  }
}

async function enqueueSyncOutbox(
  target,
  entityType,
  entityId,
  operation = "upsert",
) {
  const normalizedEntityId = Number(entityId);

  if (
    !entityType ||
    !Number.isInteger(normalizedEntityId) ||
    normalizedEntityId <= 0
  ) {
    return;
  }

  await target.query(
    `
    INSERT INTO sync_outbox
      (entity_type, entity_id, operation, requested_at, available_at, attempts, last_error, processed_at)
    VALUES
      ($1, $2, $3, NOW(), NOW(), 0, NULL, NULL)
    ON CONFLICT (entity_type, entity_id) WHERE processed_at IS NULL
    DO UPDATE
      SET operation = EXCLUDED.operation,
          requested_at = NOW(),
          available_at = NOW(),
          attempts = 0,
          last_error = NULL
    `,
    [
      entityType,
      normalizedEntityId,
      operation === "delete" ? "delete" : "upsert",
    ],
  );
}

async function enqueueInvoiceAggregateSync(
  target,
  invoiceId,
  operation = "upsert",
) {
  return enqueueSyncOutbox(target, "invoice", invoiceId, operation);
}

async function replaceInvoiceScopedRows(targetClient, meta, invoiceId, rows) {
  await targetClient.query(
    `DELETE FROM "${meta.table}" WHERE "invoice_id" = $1`,
    [invoiceId],
  );

  for (const row of rows) {
    await upsertRow(
      targetClient,
      meta.table,
      meta.columns,
      meta.pk,
      row,
      meta.columnTypes,
    );
  }
}

async function enableSyncDeleteContext(client) {
  await client.query(`SELECT set_config('app.sync_origin', 'sync', true)`);
}

async function syncInvoiceAggregateFromSource(
  sourcePool,
  targetPool,
  invoiceId,
  operation = "upsert",
) {
  const normalizedInvoiceId = Number(invoiceId);
  if (!Number.isInteger(normalizedInvoiceId) || normalizedInvoiceId <= 0) {
    return 0;
  }

  const invoiceMeta = await getTableMeta("invoices");
  const invoiceItemsMeta = await getTableMeta("invoice_items");
  const stockMovementsMeta = await getTableMeta("stock_movements");
  const cashInMeta = await getTableMeta("cash_in");
  const stockMeta = await getTableMeta("stock");

  const invoiceRes = await sourcePool.query(
    `SELECT * FROM invoices WHERE id = $1 LIMIT 1`,
    [normalizedInvoiceId],
  );
  const invoiceRow = invoiceRes.rows[0] || null;
  const shouldDelete = operation === "delete" || !invoiceRow;

  const targetClient = await targetPool.connect();
  try {
    await targetClient.query("BEGIN");
    await enableSyncDeleteContext(targetClient);

    if (shouldDelete) {
      await targetClient.query(`DELETE FROM cash_in WHERE invoice_id = $1`, [
        normalizedInvoiceId,
      ]);
      await targetClient.query(
        `DELETE FROM stock_movements WHERE invoice_id = $1`,
        [normalizedInvoiceId],
      );
      await targetClient.query(
        `DELETE FROM invoice_items WHERE invoice_id = $1`,
        [normalizedInvoiceId],
      );
      await targetClient.query(`DELETE FROM invoices WHERE id = $1`, [
        normalizedInvoiceId,
      ]);
      await targetClient.query("COMMIT");
      return 1;
    }

    const [invoiceItemsRes, stockMovementsRes, cashInRes] = await Promise.all([
      sourcePool.query(
        `SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY id ASC`,
        [normalizedInvoiceId],
      ),
      sourcePool.query(
        `SELECT * FROM stock_movements WHERE invoice_id = $1 ORDER BY id ASC`,
        [normalizedInvoiceId],
      ),
      sourcePool.query(
        `SELECT * FROM cash_in WHERE invoice_id = $1 ORDER BY id ASC`,
        [normalizedInvoiceId],
      ),
    ]);

    await upsertRow(
      targetClient,
      invoiceMeta.table,
      invoiceMeta.columns,
      invoiceMeta.pk,
      invoiceRow,
      invoiceMeta.columnTypes,
    );

    await replaceInvoiceScopedRows(
      targetClient,
      invoiceItemsMeta,
      normalizedInvoiceId,
      invoiceItemsRes.rows,
    );
    await replaceInvoiceScopedRows(
      targetClient,
      stockMovementsMeta,
      normalizedInvoiceId,
      stockMovementsRes.rows,
    );
    await replaceInvoiceScopedRows(
      targetClient,
      cashInMeta,
      normalizedInvoiceId,
      cashInRes.rows,
    );

    const stockKeys = new Map();
    for (const movement of stockMovementsRes.rows) {
      const warehouseId = Number(movement.warehouse_id || 0);
      const productId = Number(movement.product_id || 0);
      const variantId = Number(movement.variant_id || 0);
      if (!warehouseId || !productId) continue;
      stockKeys.set(`${warehouseId}|${productId}|${variantId}`, {
        warehouseId,
        productId,
        variantId,
      });
    }

    for (const stockKey of stockKeys.values()) {
      const stockRes = await sourcePool.query(
        `
        SELECT *
        FROM stock
        WHERE warehouse_id = $1 AND product_id = $2 AND variant_id = $3
        LIMIT 1
        `,
        [stockKey.warehouseId, stockKey.productId, stockKey.variantId],
      );
      const stockRow = stockRes.rows[0];
      if (!stockRow) continue;

      await upsertRow(
        targetClient,
        stockMeta.table,
        stockMeta.columns,
        stockMeta.pk,
        stockRow,
        stockMeta.columnTypes,
      );
    }

    await targetClient.query("COMMIT");
    return 1;
  } catch (err) {
    try {
      await targetClient.query("ROLLBACK");
    } catch {
      // ignore rollback failure
    }
    throw err;
  } finally {
    targetClient.release();
  }
}

async function processSyncOutbox(sourcePool, targetPool, label) {
  const pendingRes = await sourcePool.query(
    `
    SELECT id, entity_type, entity_id, operation
    FROM sync_outbox
    WHERE processed_at IS NULL
      AND available_at <= NOW()
    ORDER BY requested_at ASC, id ASC
    LIMIT $1
    `,
    [OUTBOX_BATCH_LIMIT],
  );

  let processedCount = 0;

  for (const entry of pendingRes.rows) {
    try {
      if (entry.entity_type === "invoice") {
        await syncInvoiceAggregateFromSource(
          sourcePool,
          targetPool,
          entry.entity_id,
          entry.operation,
        );
      }

      await sourcePool.query(`DELETE FROM sync_outbox WHERE id = $1`, [
        entry.id,
      ]);
      processedCount++;
    } catch (err) {
      await sourcePool.query(
        `
        UPDATE sync_outbox
        SET attempts = attempts + 1,
            last_error = LEFT($2, 500),
            available_at = NOW() + INTERVAL '30 seconds'
        WHERE id = $1
        `,
        [entry.id, err.message || `${label} outbox sync failed`],
      );
      console.error(
        `❌ ${label} outbox sync failed for ${entry.entity_type} ${entry.entity_id}:`,
        err.message,
      );
    }
  }

  return processedCount;
}

function scheduleRealtimeSync(reason = "write") {
  realtimeSyncRequested = true;
  if (realtimeSyncTimer) return;

  realtimeSyncTimer = setTimeout(async () => {
    realtimeSyncTimer = null;
    if (!realtimeSyncRequested) return;
    realtimeSyncRequested = false;

    if (!state.localAlive || !state.cloudAlive) {
      return;
    }

    try {
      const details = consumeRealtimeOperations();
      await syncBetweenPools({
        trigger: "realtime",
        reason,
        details,
        selectiveOnly: true,
      });
    } catch (err) {
      console.error(`⚠️  Realtime sync error (${reason}):`, err.message);
    }

    if (realtimeSyncRequested) {
      scheduleRealtimeSync("queued");
    }
  }, 1200);
}

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

  // Auto-failover: local dies → switch to cloud (even if manualLock)
  if (state.activeDb === "local" && !state.localAlive && state.cloudAlive) {
    state.activeDb = "cloud";
    state.manualLock = false; // auto-failover clears manual lock
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
  // Skip if manualLock is active AND less than 1 hour old (allow override after timeout)
  const manualLockExpired =
    state.manualLockTime && Date.now() - state.manualLockTime > 60 * 60 * 1000; // 1 hour timeout

  if (
    state.activeDb === "cloud" &&
    state.localAlive &&
    (!state.manualLock || manualLockExpired)
  ) {
    if (manualLockExpired) {
      console.log("🔓 Manual lock expired — enabling auto-failback");
      state.manualLock = false;
    }

    console.log(
      "🔄 Local DB recovered — syncing cloud → local before failback...",
    );
    // Sync cloud data to local BEFORE switching back
    try {
      const syncResult = await syncBetweenPools({
        trigger: "failback",
        reason: "pre-failback",
      });
      if (!syncResult?.ok) {
        console.log(
          "⏳ Failback skipped: pre-failback sync not successful (staying on cloud)",
          syncResult,
        );
      } else {
        console.log("✅ Pre-failback sync complete");
        state.activeDb = "local";
        state.manualLock = false; // Clear manual lock after successful failback
        state.manualLockTime = null;
        const record = {
          from: "cloud",
          to: "local",
          time: new Date().toISOString(),
          reason: "Local DB recovered (synced before switch)",
        };
        state.failoverHistory.push(record);
        console.log("🔄 FAILBACK: cloud → local", record);
      }
    } catch (err) {
      console.error(
        "⚠️  Pre-failback sync error (staying on cloud):",
        err.message,
      );
    }
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
  { table: "online_invoice_audit", pk: ["id"] },
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

const SYNC_TABLES_MAP = new Map(SYNC_TABLES.map((item) => [item.table, item]));
const tableMetaCache = new Map();

function getRealtimeTargetPool() {
  return state.activeDb === "local" ? cloudPool : localPool;
}

async function getTableMeta(table) {
  if (tableMetaCache.has(table)) {
    return tableMetaCache.get(table);
  }

  const tableCfg = SYNC_TABLES_MAP.get(table);
  if (!tableCfg) return null;

  const [localColsResult, cloudColsResult] = await Promise.all([
    localPool.query(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`,
      [table],
    ),
    cloudPool.query(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`,
      [table],
    ),
  ]);

  const localColumns = localColsResult.rows.map((r) => r.column_name);
  const cloudColumns = cloudColsResult.rows.map((r) => r.column_name);
  const localTypes = new Map(
    localColsResult.rows.map((r) => [r.column_name, r.data_type]),
  );
  const cloudTypes = new Map(
    cloudColsResult.rows.map((r) => [r.column_name, r.data_type]),
  );

  const localSet = new Set(localColumns);
  const cloudSet = new Set(cloudColumns);

  const columns = localColumns.filter((c) => cloudSet.has(c));

  const localOnly = localColumns.filter((c) => !cloudSet.has(c));
  const cloudOnly = cloudColumns.filter((c) => !localSet.has(c));

  if (localOnly.length > 0 || cloudOnly.length > 0) {
    console.warn(
      `⚠️  Schema mismatch for ${table} — local only: [${localOnly.join(", ")}], cloud only: [${cloudOnly.join(", ")}]. Sync will use shared columns only.`,
    );
  }

  if (columns.length === 0) {
    console.warn(`⚠️  Skip sync for ${table}: no shared columns between DBs`);
    tableMetaCache.set(table, null);
    return null;
  }

  const missingPk = tableCfg.pk.filter((k) => !columns.includes(k));
  if (missingPk.length > 0) {
    console.warn(
      `⚠️  Skip sync for ${table}: missing PK columns in shared schema [${missingPk.join(", ")}]`,
    );
    tableMetaCache.set(table, null);
    return null;
  }

  const columnTypes = Object.fromEntries(
    columns.map((column) => [
      column,
      cloudTypes.get(column) || localTypes.get(column) || null,
    ]),
  );

  const meta = {
    table,
    pk: tableCfg.pk,
    columns,
    columnTypes,
    hasUpdatedAt: columns.includes("updated_at"),
  };

  tableMetaCache.set(table, meta);
  return meta;
}

function buildPkWhere(pk, startIndex = 1) {
  return pk.map((k, idx) => `"${k}" = $${startIndex + idx}`).join(" AND ");
}

function getPkValues(row, pk) {
  return pk.map((k) => row[k]);
}

async function getRowByPk(poolRef, table, pk, rowLike) {
  const pkValues = getPkValues(rowLike, pk);
  if (pkValues.some((v) => v === undefined || v === null)) {
    return null;
  }

  const where = buildPkWhere(pk);
  const found = await poolRef.query(
    `SELECT * FROM "${table}" WHERE ${where} LIMIT 1`,
    pkValues,
  );
  return found.rows[0] || null;
}

async function syncRowFromSourceToTarget(
  sourcePool,
  targetPool,
  meta,
  sourceRow,
) {
  const { table, pk, columns, columnTypes, hasUpdatedAt } = meta;

  const targetRow = await getRowByPk(targetPool, table, pk, sourceRow);
  if (!targetRow) {
    return upsertRow(targetPool, table, columns, pk, sourceRow, columnTypes);
  }

  if (hasUpdatedAt && sourceRow.updated_at && targetRow.updated_at) {
    const sourceTime = new Date(sourceRow.updated_at).getTime();
    const targetTime = new Date(targetRow.updated_at).getTime();
    if (sourceTime <= targetTime) return 0;
  }

  if (!rowsDifferIgnoringUpdatedAt(sourceRow, targetRow, columns)) {
    return 0;
  }

  return upsertRow(targetPool, table, columns, pk, sourceRow, columnTypes);
}

async function syncRecentRowsForTable(table, sinceIso, sourcePool, targetPool) {
  const meta = await getTableMeta(table);
  if (!meta || !meta.hasUpdatedAt) return 0;

  const changed = await sourcePool.query(
    `SELECT * FROM "${table}" WHERE "updated_at" > $1 ORDER BY "updated_at" ASC`,
    [sinceIso],
  );

  let synced = 0;
  for (const sourceRow of changed.rows) {
    const changedCount = await syncRowFromSourceToTarget(
      sourcePool,
      targetPool,
      meta,
      sourceRow,
    );
    if (changedCount > 0) synced++;
  }

  if (synced > 0) {
    console.log(`  📋 ${table}: ${synced} rows synced (realtime selective)`);
  }

  return synced;
}

async function syncOperationDetail(detail, sourcePool, targetPool) {
  if (!detail?.table) return { handled: true, synced: 0 };
  if (detail.operation === "delete") {
    return { handled: true, synced: 0 };
  }

  const meta = await getTableMeta(detail.table);
  if (!meta) {
    return { handled: true, synced: 0 };
  }

  if (meta.pk.length !== 1 || detail.id == null) {
    return { handled: false, synced: 0 };
  }

  const sourceRes = await sourcePool.query(
    `SELECT * FROM "${detail.table}" WHERE "${meta.pk[0]}" = $1 LIMIT 1`,
    [detail.id],
  );
  if (!sourceRes.rows[0]) {
    return { handled: true, synced: 0 };
  }

  const changed = await syncRowFromSourceToTarget(
    sourcePool,
    targetPool,
    meta,
    sourceRes.rows[0],
  );

  return { handled: true, synced: changed > 0 ? 1 : 0 };
}

async function syncBetweenPools(options = {}) {
  const trigger = options.trigger || "manual";
  const reason = options.reason || null;
  const details = Array.isArray(options.details) ? options.details : [];
  const selectiveOnly = Boolean(options.selectiveOnly);

  if (state.syncInProgress) {
    console.log("⏳ Sync already in progress, waiting...");
    // Wait for current sync to finish and return its result
    return new Promise((resolve) => {
      const check = setInterval(() => {
        if (!state.syncInProgress) {
          clearInterval(check);
          resolve(
            state.lastSyncResult || {
              ok: true,
              message: "المزامنة السابقة انتهت",
            },
          );
        }
      }, 1000);
      // Timeout after 2 minutes
      setTimeout(() => {
        clearInterval(check);
        resolve({ ok: false, message: "انتهت مهلة الانتظار" });
      }, 120000);
    });
  }
  if (!state.localAlive || !state.cloudAlive) {
    console.log("⚠️  Cannot sync — one or both DBs unreachable");
    const result = { ok: false, message: "أحد قواعد البيانات غير متصل" };
    pushSyncLog({
      time: new Date().toISOString(),
      trigger,
      reason,
      ok: false,
      synced: 0,
      errors: 1,
      duration: "0.0s",
      message: buildSyncMessage(false, details, result.message),
      details,
    });
    return result;
  }

  state.syncInProgress = true;
  const startTime = Date.now();
  let totalSynced = 0;
  let totalErrors = 0;
  const errorDetails = [];

  console.log("🔄 Starting bi-directional sync...");

  try {
    try {
      const localToCloudOutbox = await processSyncOutbox(
        localPool,
        cloudPool,
        "Local→Cloud",
      );
      const cloudToLocalOutbox = await processSyncOutbox(
        cloudPool,
        localPool,
        "Cloud→Local",
      );
      totalSynced += localToCloudOutbox + cloudToLocalOutbox;
    } catch (err) {
      totalErrors++;
      errorDetails.push(`outbox: ${err.message}`);
      console.error("❌ Outbox sync error:", err.message);
    }

    if (trigger === "realtime" && selectiveOnly) {
      const sourcePool = getActivePool();
      const targetPool = getRealtimeTargetPool();
      const sinceIso =
        state.lastRealtimeSyncAt ||
        new Date(Date.now() - 15 * 60 * 1000).toISOString();
      const nowIso = new Date().toISOString();

      try {
        const deleted = await syncDeletions();
        totalSynced += deleted;
        if (deleted > 0) console.log(`  🗑️  ${deleted} deletions propagated`);
      } catch (err) {
        totalErrors++;
        errorDetails.push(`deletions: ${err.message}`);
        console.error("❌ Deletion sync error:", err.message);
      }

      const fallbackTables = new Set();
      for (const detail of details) {
        if (!detail?.table || !SYNC_TABLES_MAP.has(detail.table)) continue;
        try {
          const result = await syncOperationDetail(
            detail,
            sourcePool,
            targetPool,
          );
          totalSynced += result.synced;
          if (!result.handled) fallbackTables.add(detail.table);
        } catch (err) {
          totalErrors++;
          errorDetails.push(`${detail.table}: ${err.message}`);
          console.error(
            `❌ Realtime selective sync error for ${detail.table}:`,
            err.message,
          );
        }
      }

      for (const table of fallbackTables) {
        try {
          const synced = await syncRecentRowsForTable(
            table,
            sinceIso,
            sourcePool,
            targetPool,
          );
          totalSynced += synced;
        } catch (err) {
          totalErrors++;
          errorDetails.push(`${table}: ${err.message}`);
          console.error(
            `❌ Realtime recent sync error for ${table}:`,
            err.message,
          );
        }
      }

      state.lastRealtimeSyncAt = nowIso;
    } else {
      // ── Step 1: Process deletions FIRST (before row sync re-inserts them) ──
      try {
        const deleted = await syncDeletions();
        totalSynced += deleted;
        if (deleted > 0) console.log(`  🗑️  ${deleted} deletions propagated`);
      } catch (err) {
        totalErrors++;
        errorDetails.push(`deletions: ${err.message}`);
        console.error("❌ Deletion sync error:", err.message);
      }

      // ── Step 2: Sync rows (bi-directional) ──
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

      // ── Sync sequences: ensure both DBs have sequences >= max(id) ──
      try {
        await syncSequences();
      } catch (err) {
        console.error("⚠️  Sequence sync error:", err.message);
        errorDetails.push(`sequences: ${err.message}`);
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

    pushSyncLog({
      time: state.lastSyncTime,
      trigger,
      reason,
      ok: state.lastSyncResult.ok,
      synced: totalSynced,
      errors: totalErrors,
      duration: `${duration}s`,
      message: buildSyncMessage(
        totalErrors === 0,
        details,
        totalErrors > 0 ? "انتهت مع أخطاء" : "تمت المزامنة بنجاح",
      ),
      details,
    });

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

    pushSyncLog({
      time: state.lastSyncResult.time,
      trigger,
      reason,
      ok: false,
      synced: 0,
      errors: 1,
      duration: "0.0s",
      message: buildSyncMessage(false, details, err.message),
      details,
    });

    return state.lastSyncResult;
  } finally {
    state.syncInProgress = false;
  }
}

async function syncTable(table, pk) {
  let synced = 0;

  const meta = await getTableMeta(table);
  if (!meta) return 0;

  const { pk: effectivePk, columns, hasUpdatedAt } = meta;
  pk = effectivePk;

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
      const hasMeaningfulChange = rowsDifferIgnoringUpdatedAt(
        localRow,
        cloudRow,
        columns,
      );
      if (localTime > cloudTime && hasMeaningfulChange) {
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
      const hasMeaningfulChange = rowsDifferIgnoringUpdatedAt(
        cloudRow,
        localRow,
        columns,
      );
      if (cloudTime > localTime && hasMeaningfulChange) {
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
        const changed = await upsertRow(
          op.pool,
          table,
          columns,
          pk,
          op.row,
          meta.columnTypes,
        );
        if (changed > 0) synced++;
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
      throw new Error(
        `FK constraint: ${failed.length} rows stuck after ${pass + 1} passes`,
      );
    }
    remaining = failed;
  }

  if (remaining.length > 0) {
    throw new Error(
      `FK constraint: ${remaining.length} rows could not be synced after ${MAX_PASSES} passes`,
    );
  }

  if (synced > 0) console.log(`  📋 ${table}: ${synced} rows synced`);
  return synced;
}

/* ── Sync deletions: propagate deletes from one DB to the other ── */
async function syncDeletions() {
  let totalDeleted = 0;

  // Build a lookup of table → pk columns
  const tablePkMap = {};
  for (const { table, pk } of SYNC_TABLES) {
    tablePkMap[table] = pk;
  }

  // Process deletions from LOCAL → delete on CLOUD
  const localDels = await localPool.query(
    `SELECT id, table_name, pk_value, deleted_at FROM sync_deletions ORDER BY id`,
  );
  if (localDels.rows.length > 0) {
    const cloudClient = await cloudPool.connect();
    try {
      await cloudClient.query("BEGIN");
      await enableSyncDeleteContext(cloudClient);

      for (const del of localDels.rows) {
        const pk = tablePkMap[del.table_name];
        if (!pk) continue;
        try {
          const pkParts = del.pk_value.split("|");
          const where = pk.map((k, i) => `"${k}" = $${i + 1}`).join(" AND ");
          await cloudClient.query(
            `DELETE FROM "${del.table_name}" WHERE ${where}`,
            pkParts,
          );
          totalDeleted++;
        } catch (err) {
          console.error(
            `  ⚠️  Delete ${del.table_name}(${del.pk_value}) on cloud failed:`,
            err.message,
          );
        }
      }

      await cloudClient.query("COMMIT");
    } catch (err) {
      try {
        await cloudClient.query("ROLLBACK");
      } catch {
        // ignore rollback failure
      }
      throw err;
    } finally {
      cloudClient.release();
    }
  }
  // Clear processed deletions from local
  if (localDels.rows.length > 0) {
    const maxId = localDels.rows[localDels.rows.length - 1].id;
    await localPool.query(`DELETE FROM sync_deletions WHERE id <= $1`, [maxId]);
  }

  // Process deletions from CLOUD → delete on LOCAL
  const cloudDels = await cloudPool.query(
    `SELECT id, table_name, pk_value, deleted_at FROM sync_deletions ORDER BY id`,
  );
  if (cloudDels.rows.length > 0) {
    const localClient = await localPool.connect();
    try {
      await localClient.query("BEGIN");
      await enableSyncDeleteContext(localClient);

      for (const del of cloudDels.rows) {
        const pk = tablePkMap[del.table_name];
        if (!pk) continue;
        try {
          const pkParts = del.pk_value.split("|");
          const where = pk.map((k, i) => `"${k}" = $${i + 1}`).join(" AND ");
          await localClient.query(
            `DELETE FROM "${del.table_name}" WHERE ${where}`,
            pkParts,
          );
          totalDeleted++;
        } catch (err) {
          console.error(
            `  ⚠️  Delete ${del.table_name}(${del.pk_value}) on local failed:`,
            err.message,
          );
        }
      }

      await localClient.query("COMMIT");
    } catch (err) {
      try {
        await localClient.query("ROLLBACK");
      } catch {
        // ignore rollback failure
      }
      throw err;
    } finally {
      localClient.release();
    }
  }
  // Clear processed deletions from cloud
  if (cloudDels.rows.length > 0) {
    const maxId = cloudDels.rows[cloudDels.rows.length - 1].id;
    await cloudPool.query(`DELETE FROM sync_deletions WHERE id <= $1`, [maxId]);
  }

  return totalDeleted;
}

/* ── Sync sequences: ensure both DBs have nextval >= max(id) + 1 ── */
async function syncSequences() {
  const seqQuery = `
    SELECT s.relname as seq_name, t.relname as table_name, a.attname as column_name
    FROM pg_class s
    JOIN pg_depend d ON d.objid = s.oid
    JOIN pg_class t ON t.oid = d.refobjid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
    WHERE s.relkind = 'S'
    ORDER BY t.relname
  `;

  // Fix sequences on both pools
  for (const [pool, label] of [
    [localPool, "Local"],
    [cloudPool, "Cloud"],
  ]) {
    try {
      const seqs = await pool.query(seqQuery);
      let fixed = 0;
      for (const row of seqs.rows) {
        const maxRes = await pool.query(
          `SELECT COALESCE(MAX("${row.column_name}"), 0) as mx FROM "${row.table_name}"`,
        );
        const maxVal = parseInt(maxRes.rows[0].mx);
        const currRes = await pool.query(
          `SELECT last_value FROM "${row.seq_name}"`,
        );
        const seqVal = parseInt(currRes.rows[0].last_value);
        if (maxVal >= seqVal) {
          await pool.query(
            `SELECT setval('"${row.seq_name}"', ${maxVal + 1}, false)`,
          );
          fixed++;
        }
      }
      if (fixed > 0) console.log(`  🔢 ${label}: ${fixed} sequences updated`);
    } catch (err) {
      console.error(`  ⚠️  ${label} sequence sync error:`, err.message);
    }
  }
}

function prepareColumnValue(value, dataType) {
  if (value == null) return value;
  if (dataType === "json" || dataType === "jsonb") {
    return JSON.stringify(value);
  }
  return value;
}

async function upsertRow(
  targetPool,
  table,
  columns,
  pk,
  row,
  columnTypes = {},
) {
  const vals = columns.map((c) => prepareColumnValue(row[c], columnTypes?.[c]));
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
  const colList = columns.map((c) => `"${c}"`).join(", ");
  const pkList = pk.map((k) => `"${k}"`).join(", ");
  const updateCols = columns
    .filter((c) => !pk.includes(c))
    .map((c) => `"${c}" = EXCLUDED."${c}"`)
    .join(", ");

  const compareCols = columns.filter(
    (c) => !pk.includes(c) && c !== "updated_at",
  );
  const whereDistinct = compareCols
    .map((c) => `"${table}"."${c}" IS DISTINCT FROM EXCLUDED."${c}"`)
    .join(" OR ");

  const sql = updateCols
    ? `INSERT INTO "${table}" (${colList}) VALUES (${placeholders})
       ON CONFLICT (${pkList}) DO UPDATE SET ${updateCols}${whereDistinct ? ` WHERE ${whereDistinct}` : ""}`
    : `INSERT INTO "${table}" (${colList}) VALUES (${placeholders})
       ON CONFLICT (${pkList}) DO NOTHING`;

  const result = await targetPool.query(sql, vals);
  return Number(result.rowCount) || 0;
}

/* ── Periodic sync (every 15 minutes fallback) ── */
let syncInterval = null;
const PERIODIC_SYNC_INTERVAL_MS = 15 * 60 * 1000;

async function ensureSyncSchema() {
  const ensureReceivedSql = `
    ALTER TABLE stock_transfer_items
    ADD COLUMN IF NOT EXISTS received BOOLEAN DEFAULT FALSE
  `;

  const ensureUsersAccessSql = `
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'user',
      ADD COLUMN IF NOT EXISTS permissions JSONB DEFAULT '{}'
  `;

  const ensureUsersRoleConstraintSql = `
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'users'::regclass
          AND conname = 'users_role_check'
      ) THEN
        ALTER TABLE users DROP CONSTRAINT users_role_check;
      END IF;

      ALTER TABLE users
      ADD CONSTRAINT users_role_check
      CHECK (role IS NULL OR role IN ('admin', 'cashier', 'user'));
    END $$;
  `;

  const ensureSyncOutboxSql = `
    CREATE TABLE IF NOT EXISTS sync_outbox (
      id BIGSERIAL PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id BIGINT NOT NULL,
      operation TEXT NOT NULL DEFAULT 'upsert',
      requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      processed_at TIMESTAMPTZ,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    )
  `;

  const ensureSyncOutboxIndexSql = `
    CREATE UNIQUE INDEX IF NOT EXISTS sync_outbox_pending_entity_unique
    ON sync_outbox (entity_type, entity_id)
    WHERE processed_at IS NULL
  `;

  const ensureOnlineInvoiceAuditSql = `
    CREATE TABLE IF NOT EXISTS online_invoice_audit (
      id BIGSERIAL PRIMARY KEY,
      source TEXT NOT NULL,
      external_order_id TEXT NOT NULL,
      invoice_id BIGINT,
      invoice_type TEXT NOT NULL,
      branch_id INTEGER,
      movement_type TEXT NOT NULL DEFAULT 'sale',
      customer_name TEXT,
      customer_phone TEXT,
      paid_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      previous_balance NUMERIC(12,2) NOT NULL DEFAULT 0,
      request_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      resolved_items JSONB NOT NULL DEFAULT '[]'::jsonb,
      invoice_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'created',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  const ensureOnlineInvoiceAuditIndexSql = `
    CREATE UNIQUE INDEX IF NOT EXISTS online_invoice_audit_source_external_order_unique
    ON online_invoice_audit (source, external_order_id)
  `;

  const ensureOnlineInvoiceAuditUpdatedAtTriggerSql = `
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'trg_updated_at_online_invoice_audit'
          AND tgrelid = 'online_invoice_audit'::regclass
      ) THEN
        CREATE TRIGGER trg_updated_at_online_invoice_audit
        BEFORE UPDATE ON public.online_invoice_audit
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
      END IF;
    END $$;
  `;

  const ensureTrackDeletionSql = `
    CREATE OR REPLACE FUNCTION public.track_deletion()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    DECLARE
      pk_val TEXT := '';
      val TEXT;
      cols TEXT[];
      sync_origin TEXT;
    BEGIN
      sync_origin := current_setting('app.sync_origin', true);
      IF sync_origin = 'sync' THEN
        RETURN OLD;
      END IF;

      cols := TG_ARGV;
      FOR i IN 0..array_upper(cols, 1) LOOP
        EXECUTE format('SELECT ($1).%I::TEXT', cols[i]) INTO val USING OLD;
        IF i > 0 THEN pk_val := pk_val || '|'; END IF;
        pk_val := pk_val || COALESCE(val, '');
      END LOOP;

      INSERT INTO sync_deletions (table_name, pk_value)
      VALUES (TG_TABLE_NAME, pk_val);

      RETURN OLD;
    END;
    $$
  `;

  for (const [poolRef, label] of [
    [localPool, "Local"],
    [cloudPool, "Cloud"],
  ]) {
    try {
      await poolRef.query(ensureReceivedSql);
      console.log(`✅ ${label}: stock_transfer_items.received column ready`);
    } catch (err) {
      console.error(
        `❌ ${label}: stock_transfer_items.received ensure failed:`,
        err.message,
      );
    }

    try {
      await poolRef.query(ensureUsersAccessSql);
      console.log(`✅ ${label}: users access columns ready`);
    } catch (err) {
      console.error(
        `❌ ${label}: users access columns ensure failed:`,
        err.message,
      );
    }

    try {
      await poolRef.query(ensureUsersRoleConstraintSql);
      console.log(`✅ ${label}: users.role constraint ready`);
    } catch (err) {
      console.error(
        `❌ ${label}: users.role constraint ensure failed:`,
        err.message,
      );
    }

    try {
      await poolRef.query(ensureSyncOutboxSql);
      await poolRef.query(ensureSyncOutboxIndexSql);
      console.log(`✅ ${label}: sync_outbox ready`);
    } catch (err) {
      console.error(`❌ ${label}: sync_outbox ensure failed:`, err.message);
    }

    try {
      await poolRef.query(ensureOnlineInvoiceAuditSql);
      await poolRef.query(ensureOnlineInvoiceAuditIndexSql);
      await poolRef.query(ensureOnlineInvoiceAuditUpdatedAtTriggerSql);
      console.log(`✅ ${label}: online_invoice_audit ready`);
    } catch (err) {
      console.error(
        `❌ ${label}: online_invoice_audit ensure failed:`,
        err.message,
      );
    }

    try {
      await poolRef.query(ensureTrackDeletionSql);
      console.log(`✅ ${label}: track_deletion function ready`);
    } catch (err) {
      console.error(`❌ ${label}: track_deletion ensure failed:`, err.message);
    }
  }

  tableMetaCache.clear();
}

async function runPeriodicSyncTick() {
  state.nextPeriodicSyncAt = new Date(
    Date.now() + PERIODIC_SYNC_INTERVAL_MS,
  ).toISOString();
  try {
    await syncBetweenPools({ trigger: "periodic" });
  } catch (err) {
    console.error("⚠️  Periodic sync error:", err.message);
  }
}

function startPeriodicSync() {
  state.periodicSyncIntervalMs = PERIODIC_SYNC_INTERVAL_MS;
  state.nextPeriodicSyncAt = new Date(
    Date.now() + PERIODIC_SYNC_INTERVAL_MS,
  ).toISOString();

  syncInterval = setInterval(runPeriodicSyncTick, PERIODIC_SYNC_INTERVAL_MS);
}
ensureSyncSchema().finally(() => {
  startPeriodicSync();
});

/* ── Exports ── */
// Default export is a Proxy that routes queries to the active pool
const pool = new Proxy(localPool, {
  get(target, prop) {
    const activePool = getActivePool();
    if (prop === "query") {
      return async (...args) => {
        const sql = extractSqlText(args);
        const result = await activePool.query(...args);
        if (isMutatingQuery(sql)) {
          const params = Array.isArray(args?.[1]) ? args[1] : args?.[0]?.values;
          const op = parseOperationInfo(sql, params, result);
          pushRealtimeOperation(op);
          scheduleRealtimeSync("pool.query");
        }
        return result;
      };
    }
    if (prop === "connect") {
      return async (...args) => {
        const client = await activePool.connect(...args);
        const txState = { active: false, ops: [] };
        return new Proxy(client, {
          get(cTarget, cProp) {
            if (cProp === "query") {
              return async (...qArgs) => {
                const sql = extractSqlText(qArgs);
                const txControl = getTransactionControl(sql);

                if (txControl === "begin") {
                  const result = await cTarget.query(...qArgs);
                  txState.active = true;
                  txState.ops = [];
                  return result;
                }

                if (txControl === "rollback") {
                  try {
                    return await cTarget.query(...qArgs);
                  } finally {
                    txState.active = false;
                    txState.ops = [];
                  }
                }

                if (txControl === "commit") {
                  const result = await cTarget.query(...qArgs);
                  const committedOps = txState.ops;
                  txState.active = false;
                  txState.ops = [];
                  if (committedOps.length > 0) {
                    pushRealtimeOperations(committedOps);
                    scheduleRealtimeSync("client.commit");
                  }
                  return result;
                }

                const result = await cTarget.query(...qArgs);
                if (isMutatingQuery(sql)) {
                  const params = Array.isArray(qArgs?.[1])
                    ? qArgs[1]
                    : qArgs?.[0]?.values;
                  const op = parseOperationInfo(sql, params, result);
                  if (txState.active) {
                    if (op) {
                      txState.ops.push(op);
                    }
                  } else {
                    pushRealtimeOperation(op);
                    scheduleRealtimeSync("client.query");
                  }
                }
                return result;
              };
            }
            const cVal = cTarget[cProp];
            return typeof cVal === "function" ? cVal.bind(cTarget) : cVal;
          },
        });
      };
    }
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
module.exports.getSyncLogs = getSyncLogs;
module.exports.enqueueInvoiceAggregateSync = enqueueInvoiceAggregateSync;
