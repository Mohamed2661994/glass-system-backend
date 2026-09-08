const { Pool } = require("pg");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
require("dotenv").config();

/* ══════════════════════════════════════════════════════════
   Dual-Pool DB Manager: Local (primary) + Cloud (secondary)
   ── Multi-master with automatic failover & bi-directional sync
   ══════════════════════════════════════════════════════════ */

/* ─── Pool configuration ─── */
const POOL_OPTS = {
  connectionTimeoutMillis: 10000,
  query_timeout: 60000,
  max: 30,
  idleTimeoutMillis: 30000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
};

function parseBooleanEnv(value, defaultValue = false) {
  if (value == null || value === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(
    String(value).trim().toLowerCase(),
  );
}

const PUBLIC_WEBHOOK_RETRY_DELAYS_MS = [60000, 300000, 900000, 3600000];
const PUBLIC_WEBHOOK_MAX_BATCH = 10;
const PUBLIC_WEBHOOK_DELIVERY_STALE_AFTER_MS = 5 * 60 * 1000;
const PUBLIC_WEBHOOK_SOURCE = "glass-system-backend";
const PUBLIC_WEBHOOK_CONFIG = Object.freeze({
  captureEnabled: parseBooleanEnv(
    process.env.PUBLIC_WEBHOOK_CAPTURE_ENABLED,
    false,
  ),
  deliveryEnabled: parseBooleanEnv(
    process.env.PUBLIC_WEBHOOK_DELIVERY_ENABLED,
    false,
  ),
  url: String(process.env.PUBLIC_WEBHOOK_URL || "").trim(),
  secret: String(process.env.PUBLIC_WEBHOOK_SECRET || ""),
  testRoutesEnabled: parseBooleanEnv(
    process.env.PUBLIC_WEBHOOK_TEST_ROUTES_ENABLED,
    false,
  ),
  timeoutMs: Math.max(
    1000,
    Number(process.env.PUBLIC_WEBHOOK_TIMEOUT_MS) || 3000,
  ),
  maxAttempts: Math.max(
    1,
    Number(process.env.PUBLIC_WEBHOOK_MAX_ATTEMPTS) || 5,
  ),
  pollIntervalMs: Math.max(
    5000,
    Number(process.env.PUBLIC_WEBHOOK_POLL_INTERVAL_MS) || 15000,
  ),
});

const dbConnectionConfig = process.env.DATABASE_URL
  ? {
      connectionString: process.env.DATABASE_URL,
      ssl:
        process.env.DB_SSL === "true" || process.env.DB_SSL_LOCAL === "true"
          ? { rejectUnauthorized: false }
          : false,
      ...POOL_OPTS,
    }
  : {
      host:
        process.env.DB_HOST ||
        process.env.DB_HOST_LOCAL ||
        "dbstudio.hg-alshour.online",
      port: Number(process.env.DB_PORT || process.env.DB_PORT_LOCAL || 5432),
      user: process.env.DB_USER || process.env.DB_USER_LOCAL || "glass_backend",
      password:
        process.env.DB_PASSWORD ||
        process.env.DB_PASSWORD_LOCAL ||
        "SecGlass_2026_Postgres_HA",
      database:
        process.env.DB_NAME || process.env.DB_NAME_LOCAL || "glass_system",
      ssl:
        process.env.DB_SSL === "true" || process.env.DB_SSL_LOCAL === "true"
          ? { rejectUnauthorized: false }
          : false,
      ...POOL_OPTS,
    };

const primaryPool = new Pool(dbConnectionConfig);

primaryPool.on("connect", (client) => {
  client.on("error", (err) => {
    console.error("⚠️ PostgreSQL Client socket error (handled):", err.message);
  });
  client.query("SET timezone = 'Africa/Cairo'").catch((err) => {
    console.error("Failed to set timezone on client:", err.message);
  });
});
primaryPool.on("error", (err) =>
  console.error("⚠️  Database pool error (handled):", err.message),
);

// Backward compatibility references for codebase
const localPool = primaryPool;
const cloudPool = primaryPool;

/* ── State tracking ── */
const state = {
  activeDb: "primary", // Single HA Endpoint managed by Data Studio
  localAlive: true,
  cloudAlive: true,
  lastSyncTime: new Date().toISOString(),
  syncInProgress: false,
  lastSyncResult: {
    ok: true,
    synced: 0,
    message: "Data Studio High Availability Cluster active",
  },
  failoverHistory: [],
  manualLock: false,
  manualLockTime: null,
  periodicSyncIntervalMs: 0,
  nextPeriodicSyncAt: null,
  lastRealtimeSyncAt: null,
  syncLogs: [],
  publicWebhook: {
    captureEnabled: PUBLIC_WEBHOOK_CONFIG.captureEnabled,
    deliveryEnabled: Boolean(
      PUBLIC_WEBHOOK_CONFIG.deliveryEnabled ||
        (PUBLIC_WEBHOOK_CONFIG.url && PUBLIC_WEBHOOK_CONFIG.secret)
    ),
    lastClaimedAt: null,
    lastDeliveryAt: null,
    lastDeliveryError: null,
  },
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

function isPublicWebhookCaptureEnabled() {
  return PUBLIC_WEBHOOK_CONFIG.captureEnabled;
}

function isPublicWebhookDeliveryEnabled() {
  return Boolean(
    PUBLIC_WEBHOOK_CONFIG.deliveryEnabled ||
      (PUBLIC_WEBHOOK_CONFIG.url && PUBLIC_WEBHOOK_CONFIG.secret),
  );
}

function isPublicWebhookDeliveryConfigured() {
  return Boolean(PUBLIC_WEBHOOK_CONFIG.url && PUBLIC_WEBHOOK_CONFIG.secret);
}

function arePublicWebhookTestRoutesEnabled() {
  return Boolean(
    PUBLIC_WEBHOOK_CONFIG.testRoutesEnabled ||
      (PUBLIC_WEBHOOK_CONFIG.url && PUBLIC_WEBHOOK_CONFIG.secret),
  );
}

function getPublicWebhookRetryDelayMs(attemptNumber) {
  const index = Math.max(
    0,
    Math.min(
      Number(attemptNumber || 1) - 1,
      PUBLIC_WEBHOOK_RETRY_DELAYS_MS.length - 1,
    ),
  );
  return PUBLIC_WEBHOOK_RETRY_DELAYS_MS[index];
}

function buildPublicWebhookSignature(timestamp, rawBody) {
  return `sha256=${crypto
    .createHmac("sha256", PUBLIC_WEBHOOK_CONFIG.secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex")}`;
}

function buildPublicWebhookHeaders(delivery, rawBody) {
  const timestamp = new Date().toISOString();
  return {
    timestamp,
    headers: {
      "Content-Type": "application/json",
      "X-Glass-Event-Id": delivery.event_id,
      "X-Glass-Event-Type": delivery.event_type,
      "X-Glass-Timestamp": timestamp,
      "X-Glass-Signature": buildPublicWebhookSignature(timestamp, rawBody),
    },
  };
}

function sendPublicWebhookRequest(rawBody, headers) {
  return new Promise((resolve, reject) => {
    const url = new URL(PUBLIC_WEBHOOK_CONFIG.url);
    const transport = url.protocol === "http:" ? http : https;
    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        timeout: PUBLIC_WEBHOOK_CONFIG.timeoutMs,
        headers: {
          ...headers,
          "Content-Length": Buffer.byteLength(rawBody),
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          if (body.length < 4000) body += chunk;
        });
        res.on("end", () => {
          resolve({
            statusCode: Number(res.statusCode) || 0,
            body,
          });
        });
      },
    );

    req.on("timeout", () => {
      req.destroy(
        new Error(
          `Public webhook request timed out after ${PUBLIC_WEBHOOK_CONFIG.timeoutMs}ms`,
        ),
      );
    });
    req.on("error", reject);
    req.write(rawBody);
    req.end();
  });
}

async function claimPendingPublicWebhookDeliveries(
  poolRef,
  limit = PUBLIC_WEBHOOK_MAX_BATCH,
) {
  const result = await poolRef.query(
    `
    WITH next_delivery AS (
      SELECT id
      FROM public_webhook_deliveries
      WHERE attempts < $1
        AND (
          status = 'pending'
          OR (status = 'failed' AND next_attempt_at <= NOW())
          OR (
            status = 'delivering'
            AND updated_at <= NOW() - ($3::int * INTERVAL '1 millisecond')
          )
        )
      ORDER BY revision ASC
      LIMIT $2
      FOR UPDATE SKIP LOCKED
    )
    UPDATE public_webhook_deliveries d
    SET status = 'delivering',
        updated_at = NOW()
    FROM next_delivery nd
    WHERE d.id = nd.id
    RETURNING d.id, d.event_type, d.event_id, d.revision, d.payload, d.attempts
    `,
    [
      PUBLIC_WEBHOOK_CONFIG.maxAttempts,
      limit,
      PUBLIC_WEBHOOK_DELIVERY_STALE_AFTER_MS,
    ],
  );

  return result.rows;
}

async function markPublicWebhookDelivered(poolRef, deliveryId) {
  await poolRef.query(
    `
    UPDATE public_webhook_deliveries
    SET status = 'delivered',
        delivered_at = NOW(),
        last_error = NULL,
        updated_at = NOW()
    WHERE id = $1
    `,
    [deliveryId],
  );
}

async function markPublicWebhookFailed(
  poolRef,
  deliveryId,
  currentAttempts,
  errorMessage,
) {
  await poolRef.query(
    `
    UPDATE public_webhook_deliveries
    SET status = 'failed',
        attempts = attempts + 1,
        next_attempt_at = NOW() + ($2::int * INTERVAL '1 millisecond'),
        last_error = LEFT($3, 1000),
        updated_at = NOW()
    WHERE id = $1
    `,
    [
      deliveryId,
      getPublicWebhookRetryDelayMs(Number(currentAttempts || 0) + 1),
      errorMessage || 'Public webhook delivery failed',
    ],
  );
}

async function enqueuePublicWebhookDelivery(target, entry) {
  if (!entry || typeof entry !== "object") return null;

  const batchTxid = Number(entry.batchTxid) || 0;
  const eventType = String(entry.eventType || "").trim();
  const eventId = String(entry.eventId || "").trim();
  const scopeMode = String(entry.scopeMode || "items").trim() || "items";
  const payload = entry.payload && typeof entry.payload === "object"
    ? entry.payload
    : null;

  if (!eventType || !eventId || !payload) {
    return null;
  }

  const result = await target.query(
    `
    INSERT INTO public_webhook_deliveries
      (batch_txid, event_type, event_id, scope_mode, payload, status, next_attempt_at)
    VALUES
      ($1, $2, $3, $4, $5::jsonb, 'pending', NOW())
    ON CONFLICT (event_id)
    DO UPDATE
      SET payload = EXCLUDED.payload,
          scope_mode = EXCLUDED.scope_mode,
          updated_at = NOW()
    RETURNING id, revision, event_id, event_type
    `,
    [batchTxid, eventType, eventId, scopeMode, JSON.stringify(payload)],
  );

  return result.rows[0] || null;
}

function buildPublicWebhookEventId(eventType, batchTxid) {
  const normalizedType = String(eventType || "event")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `evt_${normalizedType}_${String(batchTxid || "0")}`;
}

function normalizeChangedFields(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).filter(Boolean);
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return normalizeChangedFields(parsed);
    } catch {
      return value ? [value] : [];
    }
  }
  return [];
}

function unionChangedFields(rows) {
  const seen = new Set();
  for (const row of rows) {
    for (const field of normalizeChangedFields(row.changed_fields)) {
      seen.add(field);
    }
  }
  return [...seen];
}

function getLastRow(rows) {
  return Array.isArray(rows) && rows.length > 0 ? rows[rows.length - 1] : null;
}

function getFirstNonNull(rows, key) {
  for (const row of rows) {
    if (row?.[key] !== null && row?.[key] !== undefined) {
      return row[key];
    }
  }
  return null;
}

function getLastNonNull(rows, key) {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row?.[key] !== null && row?.[key] !== undefined) {
      return row[key];
    }
  }
  return null;
}

function toIsoTimestamp(value) {
  if (!value) return new Date().toISOString();

  const normalized = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(normalized.getTime())) {
    return new Date().toISOString();
  }

  return normalized.toISOString();
}

async function listPendingPublicWebhookBatches(
  poolRef,
  limit = PUBLIC_WEBHOOK_MAX_BATCH,
) {
  const result = await poolRef.query(
    `
    SELECT
      l.batch_txid,
      l.event_type,
      CASE
        WHEN BOOL_OR(l.scope_mode = 'full') THEN 'full'
        WHEN BOOL_OR(l.scope_mode = 'branch') THEN 'branch'
        ELSE 'items'
      END AS scope_mode,
      MIN(l.id) AS first_change_id
    FROM public_webhook_change_log l
    LEFT JOIN public_webhook_deliveries d
      ON d.batch_txid = l.batch_txid
     AND d.event_type = l.event_type
    WHERE d.id IS NULL
    GROUP BY l.batch_txid, l.event_type
    ORDER BY MIN(l.id) ASC
    LIMIT $1
    `,
    [limit],
  );

  return result.rows;
}

async function getPublicWebhookChangeRows(poolRef, batchTxid, eventType) {
  const result = await poolRef.query(
    `
    SELECT
      id,
      batch_txid,
      event_type,
      scope_mode,
      product_id,
      variant_id,
      warehouse_id,
      branch_id,
      operation,
      changed_fields,
      old_stock,
      new_stock,
      created_at
    FROM public_webhook_change_log
    WHERE batch_txid = $1
      AND event_type = $2
    ORDER BY id ASC
    `,
    [batchTxid, eventType],
  );

  return result.rows;
}

async function loadPublicWebhookLookups(poolRef, rows) {
  const productIds = [
    ...new Set(
      rows
        .map((row) => Number(row.product_id || 0))
        .filter((value) => Number.isInteger(value) && value > 0),
    ),
  ];
  const variantIds = [
    ...new Set(
      rows
        .map((row) => Number(row.variant_id || 0))
        .filter((value) => Number.isInteger(value) && value > 0),
    ),
  ];
  const warehouseIds = [
    ...new Set(
      rows
        .map((row) => Number(row.warehouse_id || 0))
        .filter((value) => Number.isInteger(value) && value > 0),
    ),
  ];

  const productById = new Map();
  const variantById = new Map();
  const warehouseById = new Map();

  if (productIds.length > 0) {
    const productsRes = await poolRef.query(
      `SELECT id, barcode FROM products WHERE id = ANY($1::bigint[])`,
      [productIds],
    );
    for (const row of productsRes.rows) {
      productById.set(Number(row.id), row);
    }
  }

  if (variantIds.length > 0) {
    const variantsRes = await poolRef.query(
      `SELECT id, product_id, barcode FROM product_variants WHERE id = ANY($1::bigint[])`,
      [variantIds],
    );
    for (const row of variantsRes.rows) {
      variantById.set(Number(row.id), row);
    }
  }

  if (warehouseIds.length > 0) {
    const warehousesRes = await poolRef.query(
      `SELECT id, branch_id FROM warehouses WHERE id = ANY($1::bigint[])`,
      [warehouseIds],
    );
    for (const row of warehousesRes.rows) {
      warehouseById.set(Number(row.id), row);
    }
  }

  return { productById, variantById, warehouseById };
}

function buildPublicProductsItems(rows, lookups) {
  const grouped = new Map();

  for (const row of rows) {
    const productId = Number(row.product_id || 0);
    if (!productId) continue;
    if (!grouped.has(productId)) {
      grouped.set(productId, []);
    }
    grouped.get(productId).push(row);
  }

  const items = [];
  for (const [productId, groupRows] of grouped) {
    const lastRow = getLastRow(groupRows);
    const product = lookups.productById.get(productId);
    items.push({
      productId,
      productCode: productId,
      barcode: product?.barcode || null,
      operation: lastRow?.operation === "delete" ? "delete" : "upsert",
      changedFields: unionChangedFields(groupRows),
    });
  }

  return items;
}

function buildPublicStockItems(rows, lookups) {
  const grouped = new Map();

  for (const row of rows) {
    const productId = Number(row.product_id || 0);
    const variantId = row.variant_id == null ? 0 : Number(row.variant_id);
    const warehouseId =
      row.warehouse_id == null ? null : Number(row.warehouse_id);
    const key = `${productId}|${variantId}|${warehouseId}`;
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key).push(row);
  }

  const items = [];
  for (const [, groupRows] of grouped) {
    const lastRow = getLastRow(groupRows);
    const productId = Number(getLastNonNull(groupRows, "product_id") || 0);
    if (!productId) continue;

    const variantIdRaw = getLastNonNull(groupRows, "variant_id");
    const warehouseIdRaw = getLastNonNull(groupRows, "warehouse_id");
    const variantId = variantIdRaw == null ? 0 : Number(variantIdRaw);
    const warehouseId = warehouseIdRaw == null ? null : Number(warehouseIdRaw);
    const warehouse =
      warehouseId == null ? null : lookups.warehouseById.get(warehouseId);
    const variant = variantId > 0 ? lookups.variantById.get(variantId) : null;
    const product = lookups.productById.get(productId);

    items.push({
      productId,
      productCode: productId,
      variantId,
      barcode: variant?.barcode || product?.barcode || null,
      warehouseId,
      branchId:
        getLastNonNull(groupRows, "branch_id") ?? warehouse?.branch_id ?? null,
      operation: lastRow?.operation === "delete" ? "delete" : "upsert",
      oldStock: getFirstNonNull(groupRows, "old_stock"),
      newStock: getLastNonNull(groupRows, "new_stock"),
      changedFields: unionChangedFields(groupRows),
    });
  }

  return items;
}

async function buildPublicWebhookPayload(poolRef, candidate, rows) {
  const scopeMode = String(candidate.scope_mode || "items");
  const lookups =
    scopeMode === "items"
      ? await loadPublicWebhookLookups(poolRef, rows)
      : { productById: new Map(), variantById: new Map(), warehouseById: new Map() };

  let items = [];
  if (scopeMode === "items") {
    if (candidate.event_type === "public.products.changed") {
      items = buildPublicProductsItems(rows, lookups);
    } else if (candidate.event_type === "public.stock.changed") {
      items = buildPublicStockItems(rows, lookups);
    }
  }

  return {
    eventId: buildPublicWebhookEventId(candidate.event_type, candidate.batch_txid),
    eventType: candidate.event_type,
    changedAt: toIsoTimestamp(getLastNonNull(rows, "created_at")),
    revision: null,
    source: PUBLIC_WEBHOOK_SOURCE,
    scope: {
      mode: scopeMode,
    },
    items,
  };
}

async function materializePendingPublicWebhookDeliveries(
  poolRef,
  limit = PUBLIC_WEBHOOK_MAX_BATCH,
) {
  const candidates = await listPendingPublicWebhookBatches(poolRef, limit);
  let materializedCount = 0;

  for (const candidate of candidates) {
    const rows = await getPublicWebhookChangeRows(
      poolRef,
      candidate.batch_txid,
      candidate.event_type,
    );
    if (rows.length === 0) continue;

    const payload = await buildPublicWebhookPayload(poolRef, candidate, rows);
    const delivery = await enqueuePublicWebhookDelivery(poolRef, {
      batchTxid: candidate.batch_txid,
      eventType: candidate.event_type,
      eventId: payload.eventId,
      scopeMode: candidate.scope_mode,
      payload,
    });

    if (!delivery) continue;

    await poolRef.query(
      `
      UPDATE public_webhook_deliveries
      SET payload = jsonb_set(payload, '{revision}', to_jsonb(revision), true),
          updated_at = NOW()
      WHERE id = $1
      `,
      [delivery.id],
    );
    console.log(
      `🧾 Public webhook queued: ${candidate.event_type}#${delivery.revision}`,
    );
    materializedCount += 1;
  }

  return materializedCount;
}

function buildDefaultPublicWebhookTestItems(eventType, scopeMode) {
  if (scopeMode === "full") {
    return [];
  }

  if (eventType === "public.products.changed") {
    return [
      {
        productId: 999001,
        productCode: 999001,
        barcode: "TEST-PRODUCT-999001",
        operation: "upsert",
        changedFields: ["name", "retail_price"],
      },
    ];
  }

  return [
    {
      productId: 999001,
      productCode: 999001,
      variantId: 0,
      barcode: "TEST-STOCK-999001",
      warehouseId: 1,
      branchId: 1,
      operation: "upsert",
      oldStock: 10,
      newStock: 12,
      changedFields: ["quantity"],
    },
  ];
}

async function queuePublicWebhookTestEvent(target, options = {}) {
  const eventType = String(options.eventType || "").trim();
  const scopeMode =
    String(options.scopeMode || "items").trim().toLowerCase() === "full"
      ? "full"
      : "items";

  if (
    ![
      "public.products.changed",
      "public.stock.changed",
    ].includes(eventType)
  ) {
    throw new Error("Unsupported public webhook event type");
  }

  const batchTxid = Date.now();
  const eventId = `evt_test_${String(eventType)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")}_${batchTxid}`;
  const items = Array.isArray(options.items)
    ? options.items
    : buildDefaultPublicWebhookTestItems(eventType, scopeMode);
  const payload = {
    eventId,
    eventType,
    changedAt: new Date().toISOString(),
    revision: null,
    source: PUBLIC_WEBHOOK_SOURCE,
    scope: {
      mode: scopeMode,
    },
    items,
  };

  const delivery = await enqueuePublicWebhookDelivery(target, {
    batchTxid,
    eventType,
    eventId,
    scopeMode,
    payload,
  });

  if (!delivery) {
    throw new Error("Failed to queue public webhook test event");
  }

  const updated = await target.query(
    `
    UPDATE public_webhook_deliveries
    SET payload = jsonb_set(payload, '{revision}', to_jsonb(revision), true),
        updated_at = NOW()
    WHERE id = $1
    RETURNING id, event_id, event_type, revision, status, payload
    `,
    [delivery.id],
  );

  const queued = updated.rows[0] || null;
  if (queued) {
    console.log(
      `🧪 Public webhook test queued: ${queued.event_type}#${queued.revision}`,
    );
  }

  return queued;
}

async function replayPublicWebhookDelivery(target, options = {}) {
  const eventId = String(options.eventId || "").trim() || null;
  const revision = Number(options.revision || 0) || null;

  if (!eventId && !revision) {
    throw new Error("eventId or revision is required to replay a delivery");
  }

  const result = await target.query(
    `
    UPDATE public_webhook_deliveries
    SET status = 'pending',
        attempts = 0,
        next_attempt_at = NOW(),
        last_error = NULL,
        delivered_at = NULL,
        updated_at = NOW()
    WHERE ($1::text IS NULL OR event_id = $1)
      AND ($2::bigint IS NULL OR revision = $2)
    RETURNING id, event_id, event_type, revision, status, payload
    `,
    [eventId, revision],
  );

  return result.rows;
}

let publicWebhookDeliveryInterval = null;

async function runPublicWebhookDeliveryTick() {
  if (!isPublicWebhookDeliveryEnabled()) return;

  if (!isPublicWebhookDeliveryConfigured()) {
    const message =
      "Public webhook delivery is enabled but PUBLIC_WEBHOOK_URL or PUBLIC_WEBHOOK_SECRET is missing";
    if (state.publicWebhook.lastDeliveryError !== message) {
      console.warn(`⚠️  ${message}`);
      state.publicWebhook.lastDeliveryError = message;
    }
    return;
  }

  const deliveryPool = getActivePool();
  let claimed = [];

  if (isPublicWebhookCaptureEnabled()) {
    try {
      const materialized = await materializePendingPublicWebhookDeliveries(
        deliveryPool,
      );
      if (materialized > 0) {
        console.log(
          `📦 Public webhook deliveries materialized: ${materialized} batches`,
        );
      }
    } catch (err) {
      state.publicWebhook.lastDeliveryError = err.message;
      console.error("❌ Public webhook materialization error:", err.message);
      return;
    }
  }

  try {
    claimed = await claimPendingPublicWebhookDeliveries(deliveryPool);
  } catch (err) {
    state.publicWebhook.lastDeliveryError = err.message;
    console.error("❌ Public webhook claim error:", err.message);
    return;
  }

  if (claimed.length === 0) return;
  state.publicWebhook.lastClaimedAt = new Date().toISOString();

  for (const delivery of claimed) {
    try {
      const payload =
        delivery.payload && typeof delivery.payload === "object"
          ? delivery.payload
          : {};
      const rawBody = JSON.stringify(payload);
      const { headers } = buildPublicWebhookHeaders(delivery, rawBody);
      const response = await sendPublicWebhookRequest(rawBody, headers);

      if (response.statusCode >= 200 && response.statusCode < 300) {
        await markPublicWebhookDelivered(deliveryPool, delivery.id);
        state.publicWebhook.lastDeliveryAt = new Date().toISOString();
        state.publicWebhook.lastDeliveryError = null;
        console.log(
          `✅ Public webhook delivered: ${delivery.event_type}#${delivery.revision} (${response.statusCode})`,
        );
        continue;
      }

      const responseError = `Public webhook returned status ${response.statusCode}${response.body ? `: ${response.body.slice(0, 300)}` : ""}`;
      await markPublicWebhookFailed(
        deliveryPool,
        delivery.id,
        delivery.attempts,
        responseError,
      );
      state.publicWebhook.lastDeliveryError = responseError;
      console.error("❌", responseError);
    } catch (err) {
      const deliveryError = err.message || "Public webhook delivery failed";
      await markPublicWebhookFailed(
        deliveryPool,
        delivery.id,
        delivery.attempts,
        deliveryError,
      );
      state.publicWebhook.lastDeliveryError = deliveryError;
      console.error(
        `❌ Public webhook delivery failed for ${delivery.event_type}#${delivery.revision}:`,
        deliveryError,
      );
    }
  }
}

function startPublicWebhookDelivery() {
  if (!isPublicWebhookDeliveryEnabled() || publicWebhookDeliveryInterval) {
    return;
  }

  publicWebhookDeliveryInterval = setInterval(() => {
    runPublicWebhookDeliveryTick().catch((err) => {
      state.publicWebhook.lastDeliveryError = err.message;
      console.error("❌ Public webhook interval error:", err.message);
    });
  }, PUBLIC_WEBHOOK_CONFIG.pollIntervalMs);

  runPublicWebhookDeliveryTick().catch((err) => {
    state.publicWebhook.lastDeliveryError = err.message;
    console.error("❌ Public webhook startup tick error:", err.message);
  });
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
  // Data Studio HA cluster handles replication natively
  return;
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

async function syncInvoiceReferenceRows(sourcePool, targetClient, invoiceRow) {
  if (!invoiceRow) return;

  const customerId = Number(invoiceRow.customer_id || 0);
  const supplierId = Number(invoiceRow.supplier_id || 0);

  if (customerId > 0) {
    const customerMeta = await getTableMeta("customers");
    const customerPhonesMeta = await getTableMeta("customer_phones");
    const customerRes = await sourcePool.query(
      `SELECT * FROM customers WHERE id = $1 LIMIT 1`,
      [customerId],
    );
    const customerRow = customerRes.rows[0] || null;
    if (customerRow) {
      await upsertRow(
        targetClient,
        customerMeta.table,
        customerMeta.columns,
        customerMeta.pk,
        customerRow,
        customerMeta.columnTypes,
      );

      const customerPhonesRes = await sourcePool.query(
        `SELECT * FROM customer_phones WHERE customer_id = $1 ORDER BY id ASC`,
        [customerId],
      );
      for (const phoneRow of customerPhonesRes.rows) {
        await upsertRow(
          targetClient,
          customerPhonesMeta.table,
          customerPhonesMeta.columns,
          customerPhonesMeta.pk,
          phoneRow,
          customerPhonesMeta.columnTypes,
        );
      }
    }
  }

  if (supplierId > 0) {
    const supplierMeta = await getTableMeta("suppliers");
    const supplierPhonesMeta = await getTableMeta("supplier_phones");
    const supplierRes = await sourcePool.query(
      `SELECT * FROM suppliers WHERE id = $1 LIMIT 1`,
      [supplierId],
    );
    const supplierRow = supplierRes.rows[0] || null;
    if (supplierRow) {
      await upsertRow(
        targetClient,
        supplierMeta.table,
        supplierMeta.columns,
        supplierMeta.pk,
        supplierRow,
        supplierMeta.columnTypes,
      );

      const supplierPhonesRes = await sourcePool.query(
        `SELECT * FROM supplier_phones WHERE supplier_id = $1 ORDER BY id ASC`,
        [supplierId],
      );
      for (const phoneRow of supplierPhonesRes.rows) {
        await upsertRow(
          targetClient,
          supplierPhonesMeta.table,
          supplierPhonesMeta.columns,
          supplierPhonesMeta.pk,
          phoneRow,
          supplierPhonesMeta.columnTypes,
        );
      }
    }
  }
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

    await syncInvoiceReferenceRows(sourcePool, targetClient, invoiceRow);

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
  // Unified Data Studio HA Cluster handles replication natively
}

/* ── Health check helpers ── */
async function checkPool(poolInstance, label = "DataStudio DB") {
  try {
    const targetPool = poolInstance || primaryPool;
    const client = await targetPool.connect();
    await client.query("SELECT 1");
    client.release();
    return true;
  } catch (err) {
    console.error(`❌ ${label} health check failed:`, err.message);
    return false;
  }
}

/* ── Periodic health checks (every 30s) ── */
const healthCheckInterval = setInterval(async () => {
  if (primaryPool.ending || primaryPool.ended) return;
  const alive = await checkPool(primaryPool, "DataStudio DB");
  state.localAlive = alive;
  state.cloudAlive = alive;
}, 30000);
if (typeof healthCheckInterval.unref === "function") {
  healthCheckInterval.unref();
}

/* ── Get the active pool ── */
function getActivePool() {
  return primaryPool;
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

async function syncReferencedRowById(sourcePool, targetPool, table, id) {
  if (id === undefined || id === null || id === "") {
    return 0;
  }

  const meta = await getTableMeta(table);
  if (!meta || meta.pk.length !== 1) {
    return 0;
  }

  const sourceRes = await sourcePool.query(
    `SELECT * FROM "${table}" WHERE "${meta.pk[0]}" = $1 LIMIT 1`,
    [id],
  );
  const sourceRow = sourceRes.rows[0];
  if (!sourceRow) {
    return 0;
  }

  return syncRowFromSourceToTarget(sourcePool, targetPool, meta, sourceRow);
}

async function syncCashInDependencies(sourcePool, targetPool, cashInRow) {
  if (!cashInRow) return 0;

  let synced = 0;

  synced += await syncReferencedRowById(
    sourcePool,
    targetPool,
    "customers",
    cashInRow.customer_id,
  );

  if (cashInRow.invoice_id !== undefined && cashInRow.invoice_id !== null) {
    const invoiceMeta = await getTableMeta("invoices");
    if (invoiceMeta && invoiceMeta.pk.length === 1) {
      const invoiceRes = await sourcePool.query(
        `SELECT * FROM "invoices" WHERE "${invoiceMeta.pk[0]}" = $1 LIMIT 1`,
        [cashInRow.invoice_id],
      );
      const invoiceRow = invoiceRes.rows[0];
      if (invoiceRow) {
        synced += await syncReferencedRowById(
          sourcePool,
          targetPool,
          "customers",
          invoiceRow.customer_id,
        );
        synced += await syncReferencedRowById(
          sourcePool,
          targetPool,
          "suppliers",
          invoiceRow.supplier_id,
        );
        synced += await syncRowFromSourceToTarget(
          sourcePool,
          targetPool,
          invoiceMeta,
          invoiceRow,
        );
      }
    }
  }

  synced += await syncReferencedRowById(
    sourcePool,
    targetPool,
    "daily_cash",
    cashInRow.daily_cash_id,
  );

  return synced;
}

async function syncRowFromSourceToTarget(
  sourcePool,
  targetPool,
  meta,
  sourceRow,
) {
  const { table, pk, columns, columnTypes, hasUpdatedAt } = meta;

  if (table === "cash_in") {
    await syncCashInDependencies(sourcePool, targetPool, sourceRow);
  }

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
  if (table === "invoice_items") {
    return 0; // Handled exclusively by syncInvoiceAggregate
  }

  const meta = await getTableMeta(table);
  if (!meta || !meta.hasUpdatedAt) return 0;

  let queryStr = `SELECT * FROM "${table}" WHERE "updated_at" > $1 ORDER BY "updated_at" ASC`;
  if (table === "stock_movements") {
    queryStr = `SELECT * FROM "stock_movements" WHERE "updated_at" > $1 AND "invoice_id" IS NULL ORDER BY "updated_at" ASC`;
  } else if (table === "cash_in") {
    queryStr = `SELECT * FROM "cash_in" WHERE "updated_at" > $1 AND "invoice_id" IS NULL ORDER BY "updated_at" ASC`;
  }

  const changed = await sourcePool.query(queryStr, [sinceIso]);

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
  if (detail.table === "invoice_items") {
    return { handled: true, synced: 0 }; // Handled exclusively by syncInvoiceAggregate
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
  const row = sourceRes.rows[0];
  if (!row) {
    return { handled: true, synced: 0 };
  }

  if (detail.table === "stock_movements" && row.invoice_id != null) {
    return { handled: true, synced: 0 };
  }
  if (detail.table === "cash_in" && row.invoice_id != null) {
    return { handled: true, synced: 0 };
  }

  const changed = await syncRowFromSourceToTarget(
    sourcePool,
    targetPool,
    meta,
    row,
  );

  return { handled: true, synced: changed > 0 ? 1 : 0 };
}

async function syncBetweenPools(options = {}) {
  const result = {
    ok: true,
    synced: 0,
    errors: 0,
    duration: "0.0s",
    time: new Date().toISOString(),
    message: "قاعدة البيانات موحدة عبر خادم Data Studio HA Cluster (المزامنة تدار تلقائياً عبر السيرفر)",
  };
  state.lastSyncResult = result;
  state.lastSyncTime = result.time;
  return result;
}

async function syncTable(table, pk) {
  if (table === "invoice_items") {
    return 0; // Handled exclusively by syncInvoiceAggregate
  }

  let synced = 0;

  const meta = await getTableMeta(table);
  if (!meta) return 0;

  const { pk: effectivePk, columns, hasUpdatedAt } = meta;
  pk = effectivePk;

  let queryStr = `SELECT * FROM "${table}"`;
  if (table === "stock_movements") {
    queryStr = `SELECT * FROM "stock_movements" WHERE "invoice_id" IS NULL`;
  } else if (table === "cash_in") {
    queryStr = `SELECT * FROM "cash_in" WHERE "invoice_id" IS NULL`;
  }

  // Fetch all rows from both sides
  const localRows = await localPool.query(queryStr);
  const cloudRows = await cloudPool.query(queryStr);

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
  if (process.env.ENABLE_STARTUP_MIGRATIONS !== "true") {
    console.log("ℹ️  Startup DDL schema checks bypassed (fast production mode).");
    return;
  }
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

  const ensurePublicWebhookRevisionSeqSql = `
    CREATE SEQUENCE IF NOT EXISTS public_webhook_revision_seq AS BIGINT
  `;

  const ensurePublicWebhookChangeLogSql = `
    CREATE TABLE IF NOT EXISTS public_webhook_change_log (
      id BIGSERIAL PRIMARY KEY,
      batch_txid BIGINT NOT NULL,
      event_type TEXT NOT NULL,
      scope_mode TEXT NOT NULL DEFAULT 'items',
      product_id BIGINT,
      variant_id BIGINT,
      warehouse_id BIGINT,
      branch_id BIGINT,
      operation TEXT NOT NULL DEFAULT 'upsert',
      changed_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
      old_stock NUMERIC,
      new_stock NUMERIC,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  const ensurePublicWebhookChangeLogBatchIndexSql = `
    CREATE INDEX IF NOT EXISTS public_webhook_change_log_batch_idx
    ON public_webhook_change_log (batch_txid)
  `;

  const ensurePublicWebhookChangeLogEventIndexSql = `
    CREATE INDEX IF NOT EXISTS public_webhook_change_log_event_type_idx
    ON public_webhook_change_log (event_type)
  `;

  const ensurePublicWebhookChangeLogItemIndexSql = `
    CREATE INDEX IF NOT EXISTS public_webhook_change_log_item_idx
    ON public_webhook_change_log (product_id, variant_id, warehouse_id)
  `;

  const ensurePublicWebhookChangeLogCreatedAtIndexSql = `
    CREATE INDEX IF NOT EXISTS public_webhook_change_log_created_at_idx
    ON public_webhook_change_log (created_at)
  `;

  const ensurePublicWebhookDeliveriesSql = `
    CREATE TABLE IF NOT EXISTS public_webhook_deliveries (
      id BIGSERIAL PRIMARY KEY,
      batch_txid BIGINT NOT NULL,
      event_type TEXT NOT NULL,
      event_id TEXT NOT NULL,
      revision BIGINT NOT NULL DEFAULT nextval('public_webhook_revision_seq'),
      scope_mode TEXT NOT NULL DEFAULT 'items',
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_error TEXT,
      delivered_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  const ensurePublicWebhookDeliveriesEventIdUniqueSql = `
    CREATE UNIQUE INDEX IF NOT EXISTS public_webhook_deliveries_event_id_uidx
    ON public_webhook_deliveries (event_id)
  `;

  const ensurePublicWebhookDeliveriesBatchEventUniqueSql = `
    CREATE UNIQUE INDEX IF NOT EXISTS public_webhook_deliveries_batch_event_uidx
    ON public_webhook_deliveries (batch_txid, event_type)
  `;

  const ensurePublicWebhookDeliveriesPendingIndexSql = `
    CREATE INDEX IF NOT EXISTS public_webhook_deliveries_pending_idx
    ON public_webhook_deliveries (status, next_attempt_at)
  `;

  const ensurePublicWebhookDeliveriesRevisionIndexSql = `
    CREATE INDEX IF NOT EXISTS public_webhook_deliveries_revision_idx
    ON public_webhook_deliveries (revision)
  `;

  const ensurePublicWebhookHelperFunctionsSql = `
    CREATE OR REPLACE FUNCTION public.log_public_webhook_change(
      p_event_type TEXT,
      p_scope_mode TEXT DEFAULT 'items',
      p_product_id BIGINT DEFAULT NULL,
      p_variant_id BIGINT DEFAULT NULL,
      p_warehouse_id BIGINT DEFAULT NULL,
      p_branch_id BIGINT DEFAULT NULL,
      p_operation TEXT DEFAULT 'upsert',
      p_changed_fields JSONB DEFAULT '[]'::jsonb,
      p_old_stock NUMERIC DEFAULT NULL,
      p_new_stock NUMERIC DEFAULT NULL
    )
    RETURNS VOID
    LANGUAGE plpgsql
    AS $$
    BEGIN
      INSERT INTO public_webhook_change_log (
        batch_txid,
        event_type,
        scope_mode,
        product_id,
        variant_id,
        warehouse_id,
        branch_id,
        operation,
        changed_fields,
        old_stock,
        new_stock
      )
      VALUES (
        txid_current(),
        p_event_type,
        COALESCE(NULLIF(p_scope_mode, ''), 'items'),
        p_product_id,
        p_variant_id,
        p_warehouse_id,
        p_branch_id,
        COALESCE(NULLIF(p_operation, ''), 'upsert'),
        COALESCE(p_changed_fields, '[]'::jsonb),
        p_old_stock,
        p_new_stock
      );
    END;
    $$;

    CREATE OR REPLACE FUNCTION public.is_public_product_active(p_product_id BIGINT)
    RETURNS BOOLEAN
    LANGUAGE SQL
    STABLE
    AS $$
      SELECT COALESCE((
        SELECT p.is_active
        FROM products p
        WHERE p.id = p_product_id
        LIMIT 1
      ), FALSE)
    $$;

    CREATE OR REPLACE FUNCTION public.public_webhook_branch_for_warehouse(p_warehouse_id BIGINT)
    RETURNS BIGINT
    LANGUAGE SQL
    STABLE
    AS $$
      SELECT w.branch_id
      FROM warehouses w
      WHERE w.id = p_warehouse_id
      LIMIT 1
    $$;
  `;

  const ensurePublicWebhookCaptureFunctionsSql = `
    CREATE OR REPLACE FUNCTION public.capture_public_products_changes()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    DECLARE
      product_fields TEXT[] := ARRAY[]::TEXT[];
      stock_fields TEXT[] := ARRAY[]::TEXT[];
      was_public BOOLEAN := FALSE;
      is_public BOOLEAN := FALSE;
      target_id BIGINT := NULL;
      product_operation TEXT := 'upsert';
      stock_operation TEXT := 'upsert';
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF COALESCE(NEW.is_active, FALSE) THEN
          PERFORM public.log_public_webhook_change(
            'public.products.changed',
            'items',
            NEW.id,
            NULL,
            NULL,
            NULL,
            'upsert',
            to_jsonb(ARRAY['name', 'wholesale_price', 'retail_price', 'discount_amount', 'barcode', 'is_active'])
          );
          PERFORM public.log_public_webhook_change(
            'public.stock.changed',
            'items',
            NEW.id,
            NULL,
            NULL,
            NULL,
            'upsert',
            to_jsonb(ARRAY['name', 'barcode', 'manufacturer', 'wholesale_package', 'retail_package', 'wholesale_price', 'retail_price', 'description', 'is_active'])
          );
        END IF;
        RETURN NEW;
      END IF;

      IF TG_OP = 'DELETE' THEN
        IF COALESCE(OLD.is_active, FALSE) THEN
          PERFORM public.log_public_webhook_change(
            'public.products.changed',
            'items',
            OLD.id,
            NULL,
            NULL,
            NULL,
            'delete',
            to_jsonb(ARRAY['is_active'])
          );
          PERFORM public.log_public_webhook_change(
            'public.stock.changed',
            'items',
            OLD.id,
            NULL,
            NULL,
            NULL,
            'delete',
            to_jsonb(ARRAY['is_active'])
          );
        END IF;
        RETURN OLD;
      END IF;

      was_public := COALESCE(OLD.is_active, FALSE);
      is_public := COALESCE(NEW.is_active, FALSE);
      target_id := COALESCE(NEW.id, OLD.id);

      IF NEW.name IS DISTINCT FROM OLD.name THEN
        product_fields := array_append(product_fields, 'name');
        stock_fields := array_append(stock_fields, 'name');
      END IF;
      IF NEW.wholesale_price IS DISTINCT FROM OLD.wholesale_price THEN
        product_fields := array_append(product_fields, 'wholesale_price');
        stock_fields := array_append(stock_fields, 'wholesale_price');
      END IF;
      IF NEW.retail_price IS DISTINCT FROM OLD.retail_price THEN
        product_fields := array_append(product_fields, 'retail_price');
        stock_fields := array_append(stock_fields, 'retail_price');
      END IF;
      IF NEW.discount_amount IS DISTINCT FROM OLD.discount_amount THEN
        product_fields := array_append(product_fields, 'discount_amount');
      END IF;
      IF NEW.barcode IS DISTINCT FROM OLD.barcode THEN
        product_fields := array_append(product_fields, 'barcode');
        stock_fields := array_append(stock_fields, 'barcode');
      END IF;
      IF NEW.manufacturer IS DISTINCT FROM OLD.manufacturer THEN
        stock_fields := array_append(stock_fields, 'manufacturer');
      END IF;
      IF NEW.wholesale_package IS DISTINCT FROM OLD.wholesale_package THEN
        stock_fields := array_append(stock_fields, 'wholesale_package');
      END IF;
      IF NEW.retail_package IS DISTINCT FROM OLD.retail_package THEN
        stock_fields := array_append(stock_fields, 'retail_package');
      END IF;
      IF NEW.description IS DISTINCT FROM OLD.description THEN
        stock_fields := array_append(stock_fields, 'description');
      END IF;
      IF NEW.is_active IS DISTINCT FROM OLD.is_active THEN
        product_fields := array_append(product_fields, 'is_active');
        stock_fields := array_append(stock_fields, 'is_active');
      END IF;

      IF NOT was_public AND NOT is_public THEN
        RETURN NEW;
      END IF;

      IF was_public AND NOT is_public THEN
        product_operation := 'delete';
        stock_operation := 'delete';
      END IF;

      IF array_length(product_fields, 1) IS NOT NULL THEN
        PERFORM public.log_public_webhook_change(
          'public.products.changed',
          'items',
          target_id,
          NULL,
          NULL,
          NULL,
          product_operation,
          to_jsonb(product_fields)
        );
      END IF;

      IF array_length(stock_fields, 1) IS NOT NULL THEN
        PERFORM public.log_public_webhook_change(
          'public.stock.changed',
          'items',
          target_id,
          NULL,
          NULL,
          NULL,
          stock_operation,
          to_jsonb(stock_fields)
        );
      END IF;

      RETURN NEW;
    END;
    $$;

    CREATE OR REPLACE FUNCTION public.capture_public_product_variant_changes()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    DECLARE
      field_names TEXT[] := ARRAY[]::TEXT[];
      target_product_id BIGINT := NULL;
      target_variant_id BIGINT := NULL;
      is_public_product BOOLEAN := FALSE;
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF public.is_public_product_active(NEW.product_id) THEN
          PERFORM public.log_public_webhook_change(
            'public.stock.changed',
            'items',
            NEW.product_id,
            NEW.id,
            NULL,
            NULL,
            'upsert',
            to_jsonb(ARRAY['label', 'barcode', 'retail_price', 'wholesale_price'])
          );
        END IF;
        RETURN NEW;
      END IF;

      IF TG_OP = 'DELETE' THEN
        IF public.is_public_product_active(OLD.product_id) THEN
          PERFORM public.log_public_webhook_change(
            'public.stock.changed',
            'items',
            OLD.product_id,
            OLD.id,
            NULL,
            NULL,
            'delete',
            to_jsonb(ARRAY['label', 'barcode', 'retail_price', 'wholesale_price'])
          );
        END IF;
        RETURN OLD;
      END IF;

      IF NEW.product_id IS DISTINCT FROM OLD.product_id THEN
        PERFORM public.log_public_webhook_change(
          'public.stock.changed',
          'full',
          NULL,
          NULL,
          NULL,
          NULL,
          'upsert',
          '[]'::jsonb
        );
        RETURN NEW;
      END IF;

      target_product_id := COALESCE(NEW.product_id, OLD.product_id);
      target_variant_id := COALESCE(NEW.id, OLD.id);
      is_public_product := public.is_public_product_active(target_product_id);

      IF NOT is_public_product THEN
        RETURN NEW;
      END IF;

      IF NEW.label IS DISTINCT FROM OLD.label THEN
        field_names := array_append(field_names, 'label');
      END IF;
      IF NEW.barcode IS DISTINCT FROM OLD.barcode THEN
        field_names := array_append(field_names, 'barcode');
      END IF;
      IF NEW.retail_price IS DISTINCT FROM OLD.retail_price THEN
        field_names := array_append(field_names, 'retail_price');
      END IF;
      IF NEW.wholesale_price IS DISTINCT FROM OLD.wholesale_price THEN
        field_names := array_append(field_names, 'wholesale_price');
      END IF;

      IF array_length(field_names, 1) IS NOT NULL THEN
        PERFORM public.log_public_webhook_change(
          'public.stock.changed',
          'items',
          target_product_id,
          target_variant_id,
          NULL,
          NULL,
          'upsert',
          to_jsonb(field_names)
        );
      END IF;

      RETURN NEW;
    END;
    $$;

    CREATE OR REPLACE FUNCTION public.capture_public_stock_changes()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    DECLARE
      target_product_id BIGINT := NULL;
      target_variant_id BIGINT := NULL;
      target_warehouse_id BIGINT := NULL;
      target_branch_id BIGINT := NULL;
      is_public_product BOOLEAN := FALSE;
    BEGIN
      IF TG_OP = 'INSERT' THEN
        target_product_id := NEW.product_id;
        target_variant_id := COALESCE(NEW.variant_id, 0);
        target_warehouse_id := NEW.warehouse_id;
        IF NOT public.is_public_product_active(target_product_id) THEN
          RETURN NEW;
        END IF;
        target_branch_id := public.public_webhook_branch_for_warehouse(target_warehouse_id);
        PERFORM public.log_public_webhook_change(
          'public.stock.changed',
          'items',
          target_product_id,
          target_variant_id,
          target_warehouse_id,
          target_branch_id,
          'upsert',
          to_jsonb(ARRAY['quantity']),
          0,
          COALESCE(NEW.quantity, 0)
        );
        RETURN NEW;
      END IF;

      IF TG_OP = 'DELETE' THEN
        target_product_id := OLD.product_id;
        target_variant_id := COALESCE(OLD.variant_id, 0);
        target_warehouse_id := OLD.warehouse_id;
        IF NOT public.is_public_product_active(target_product_id) THEN
          RETURN OLD;
        END IF;
        target_branch_id := public.public_webhook_branch_for_warehouse(target_warehouse_id);
        PERFORM public.log_public_webhook_change(
          'public.stock.changed',
          'items',
          target_product_id,
          target_variant_id,
          target_warehouse_id,
          target_branch_id,
          'delete',
          to_jsonb(ARRAY['quantity']),
          COALESCE(OLD.quantity, 0),
          0
        );
        RETURN OLD;
      END IF;

      target_product_id := NEW.product_id;
      target_variant_id := COALESCE(NEW.variant_id, 0);
      target_warehouse_id := NEW.warehouse_id;
      is_public_product := public.is_public_product_active(target_product_id);
      IF NOT is_public_product OR NEW.quantity IS NOT DISTINCT FROM OLD.quantity THEN
        RETURN NEW;
      END IF;

      target_branch_id := public.public_webhook_branch_for_warehouse(target_warehouse_id);
      PERFORM public.log_public_webhook_change(
        'public.stock.changed',
        'items',
        target_product_id,
        target_variant_id,
        target_warehouse_id,
        target_branch_id,
        'upsert',
        to_jsonb(ARRAY['quantity']),
        COALESCE(OLD.quantity, 0),
        COALESCE(NEW.quantity, 0)
      );
      RETURN NEW;
    END;
    $$;

    CREATE OR REPLACE FUNCTION public.capture_public_warehouse_changes()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    DECLARE
      target_branch_id BIGINT := NULL;
    BEGIN
      IF TG_OP = 'INSERT' THEN
        target_branch_id := NEW.branch_id;
        PERFORM public.log_public_webhook_change(
          'public.stock.changed',
          'full',
          NULL,
          NULL,
          NULL,
          target_branch_id,
          'upsert',
          '[]'::jsonb
        );
        RETURN NEW;
      END IF;

      IF TG_OP = 'DELETE' THEN
        target_branch_id := OLD.branch_id;
        PERFORM public.log_public_webhook_change(
          'public.stock.changed',
          'full',
          NULL,
          NULL,
          NULL,
          target_branch_id,
          'upsert',
          '[]'::jsonb
        );
        RETURN OLD;
      END IF;

      IF NEW.name IS NOT DISTINCT FROM OLD.name
         AND NEW.branch_id IS NOT DISTINCT FROM OLD.branch_id THEN
        RETURN NEW;
      END IF;

      target_branch_id := COALESCE(NEW.branch_id, OLD.branch_id);
      PERFORM public.log_public_webhook_change(
        'public.stock.changed',
        'full',
        NULL,
        NULL,
        NULL,
        target_branch_id,
        'upsert',
        '[]'::jsonb
      );
      RETURN NEW;
    END;
    $$;
  `;

  const dropPublicWebhookCaptureTriggersSql = `
    DO $$
    BEGIN
      IF to_regclass('public.products') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS trg_capture_public_products_changes ON public.products;
      END IF;
      IF to_regclass('public.product_variants') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS trg_capture_public_product_variant_changes ON public.product_variants;
      END IF;
      IF to_regclass('public.stock') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS trg_capture_public_stock_changes ON public.stock;
      END IF;
      IF to_regclass('public.warehouses') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS trg_capture_public_warehouse_changes ON public.warehouses;
      END IF;
    END;
    $$;
  `;

  const ensurePublicWebhookCaptureTriggersSql = `
    DO $$
    BEGIN
      IF to_regclass('public.products') IS NOT NULL THEN
        CREATE TRIGGER trg_capture_public_products_changes
        AFTER INSERT OR UPDATE OR DELETE ON public.products
        FOR EACH ROW EXECUTE FUNCTION public.capture_public_products_changes();
      END IF;

      IF to_regclass('public.product_variants') IS NOT NULL THEN
        CREATE TRIGGER trg_capture_public_product_variant_changes
        AFTER INSERT OR UPDATE OR DELETE ON public.product_variants
        FOR EACH ROW EXECUTE FUNCTION public.capture_public_product_variant_changes();
      END IF;

      IF to_regclass('public.stock') IS NOT NULL THEN
        CREATE TRIGGER trg_capture_public_stock_changes
        AFTER INSERT OR UPDATE OF quantity OR DELETE ON public.stock
        FOR EACH ROW EXECUTE FUNCTION public.capture_public_stock_changes();
      END IF;

      IF to_regclass('public.warehouses') IS NOT NULL THEN
        CREATE TRIGGER trg_capture_public_warehouse_changes
        AFTER INSERT OR UPDATE OR DELETE ON public.warehouses
        FOR EACH ROW EXECUTE FUNCTION public.capture_public_warehouse_changes();
      END IF;
    END;
    $$;
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

    try {
      await poolRef.query(ensurePublicWebhookRevisionSeqSql);
      await poolRef.query(ensurePublicWebhookChangeLogSql);
      await poolRef.query(ensurePublicWebhookChangeLogBatchIndexSql);
      await poolRef.query(ensurePublicWebhookChangeLogEventIndexSql);
      await poolRef.query(ensurePublicWebhookChangeLogItemIndexSql);
      await poolRef.query(ensurePublicWebhookChangeLogCreatedAtIndexSql);
      await poolRef.query(ensurePublicWebhookDeliveriesSql);
      await poolRef.query(ensurePublicWebhookDeliveriesEventIdUniqueSql);
      await poolRef.query(ensurePublicWebhookDeliveriesBatchEventUniqueSql);
      await poolRef.query(ensurePublicWebhookDeliveriesPendingIndexSql);
      await poolRef.query(ensurePublicWebhookDeliveriesRevisionIndexSql);
      console.log(`✅ ${label}: public webhook schema ready`);
    } catch (err) {
      console.error(
        `❌ ${label}: public webhook schema ensure failed:`,
        err.message,
      );
    }

    try {
      await poolRef.query(ensurePublicWebhookHelperFunctionsSql);
      await poolRef.query(ensurePublicWebhookCaptureFunctionsSql);
      await poolRef.query(dropPublicWebhookCaptureTriggersSql);

      if (isPublicWebhookCaptureEnabled()) {
        await poolRef.query(ensurePublicWebhookCaptureTriggersSql);
        console.log(`✅ ${label}: public webhook capture triggers ready`);
      } else {
        console.log(`ℹ️  ${label}: public webhook capture disabled`);
      }
    } catch (err) {
      console.error(
        `❌ ${label}: public webhook capture ensure failed:`,
        err.message,
      );
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

/* ── Continuous Standby Backup Sync (Data Studio ➔ AWS Cloud Standby) ── */
let backupSyncTimer = null;

function startContinuousStandbyBackup() {
  const isEnabled = parseBooleanEnv(process.env.STANDBY_BACKUP_ENABLED, true);
  if (!isEnabled) {
    console.log("ℹ️  Standby backup sync to AWS Cloud is disabled.");
    return;
  }

  const intervalMs = Math.max(30000, Number(process.env.STANDBY_BACKUP_INTERVAL_MS) || 120000);
  console.log(`🛡️  Standby continuous backup initialized (interval: ${intervalMs / 1000}s)`);

  backupSyncTimer = setInterval(() => {
    try {
      const { safeRunBackupSync } = require("./sync_studio_to_cloud_backup");
      safeRunBackupSync().catch((err) => {
        console.warn("⚠️ Standby backup sync error:", err.message);
      });
    } catch (err) {
      console.warn("⚠️ Standby backup sync loader error:", err.message);
    }
  }, intervalMs);

  // Initial sync 15s after startup
  setTimeout(() => {
    try {
      const { safeRunBackupSync } = require("./sync_studio_to_cloud_backup");
      safeRunBackupSync().catch((err) => {
        console.warn("⚠️ Standby initial backup sync error:", err.message);
      });
    } catch (err) {}
  }, 15000);
}

function startPeriodicSync() {
  // Bi-directional sync disabled: unified on Data Studio HA Cluster
}

// Start background services
startPublicWebhookDelivery();
startContinuousStandbyBackup();

/* ── Exports ── */
const pool = primaryPool;

pool.localPool = primaryPool;
pool.cloudPool = primaryPool;
pool.dbState = state;
pool.syncBetweenPools = syncBetweenPools;
pool.checkPool = checkPool;
pool.getActivePool = getActivePool;
pool.getSyncLogs = getSyncLogs;
pool.enqueueInvoiceAggregateSync = enqueueInvoiceAggregateSync;
pool.enqueuePublicWebhookDelivery = enqueuePublicWebhookDelivery;
pool.queuePublicWebhookTestEvent = queuePublicWebhookTestEvent;
pool.replayPublicWebhookDelivery = replayPublicWebhookDelivery;
pool.arePublicWebhookTestRoutesEnabled = arePublicWebhookTestRoutesEnabled;
pool.publicWebhookConfig = PUBLIC_WEBHOOK_CONFIG;

module.exports = pool;
module.exports.localPool = primaryPool;
module.exports.cloudPool = primaryPool;
module.exports.dbState = state;
module.exports.syncBetweenPools = syncBetweenPools;
module.exports.checkPool = checkPool;
module.exports.getActivePool = getActivePool;
module.exports.getSyncLogs = getSyncLogs;
module.exports.enqueueInvoiceAggregateSync = enqueueInvoiceAggregateSync;
module.exports.enqueuePublicWebhookDelivery = enqueuePublicWebhookDelivery;
module.exports.queuePublicWebhookTestEvent = queuePublicWebhookTestEvent;
module.exports.replayPublicWebhookDelivery = replayPublicWebhookDelivery;
module.exports.arePublicWebhookTestRoutesEnabled =
  arePublicWebhookTestRoutesEnabled;
module.exports.publicWebhookConfig = PUBLIC_WEBHOOK_CONFIG;
