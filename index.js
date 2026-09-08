const express = require("express");
const cors = require("cors");
require("dotenv").config();

process.on("unhandledRejection", (reason, promise) => {
  console.error("⚠️ Unhandled Rejection (handled):", reason);
});
process.on("uncaughtException", (err) => {
  console.error("⚠️ Uncaught Exception (handled):", err.message || err);
});
const { exec } = require("child_process");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const puppeteer = require("puppeteer");
let chromium;
try {
  chromium = require("@sparticuz/chromium");
} catch (e) {}

const launchPuppeteer = async () => {
  const isWin = process.platform === "win32";
  return await puppeteer.launch({
    args: isWin ? ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] : chromium.args,
    defaultViewport: isWin ? null : chromium.defaultViewport,
    executablePath: isWin ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : await chromium.executablePath(),
    headless: isWin ? "new" : chromium.headless,
  });
};
const webPush = require("web-push");

// VAPID keys for Web Push
const VAPID_PUBLIC_KEY =
  process.env.VAPID_PUBLIC_KEY ||
  "BE_kwDw7wWI1zcNDVcuzNvqGQTAclRtQq1P92xfHrMlzTzRaDnD9nh5byh545XCZ_4seODj7BbHrdee8kTMxkuQ";
const VAPID_PRIVATE_KEY =
  process.env.VAPID_PRIVATE_KEY ||
  "zDbY6LS9Ixyxr7ej8Ocp3zdCnt_7Q6xY2v7c5Ikf43U";
webPush.setVapidDetails(
  "mailto:admin@glass-system.com",
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY,
);
const pool = require("./db");
const {
  localPool,
  cloudPool,
  dbState,
  syncBetweenPools,
  checkPool,
  getSyncLogs,
  enqueueInvoiceAggregateSync,
  queuePublicWebhookTestEvent,
  replayPublicWebhookDelivery,
  arePublicWebhookTestRoutesEnabled,
} = require("./db");
const {
  convertWholesaleToRetail,
} = require("./services/wholesaleToRetailConverter");

const STARTUP_DB_TARGETS = [
  [localPool, "Local"],
  [cloudPool, "Cloud"],
];

async function runStartupSqlOnAllPools(label, sql) {
  if (process.env.ENABLE_STARTUP_MIGRATIONS !== 'true') return;
  await Promise.allSettled(
    STARTUP_DB_TARGETS.map(async ([targetPool, targetLabel]) => {
      await targetPool.query(sql);
      console.log(`✅ ${targetLabel}: ${label}`);
    }),
  ).then((results) => {
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        console.error(
          `❌ ${STARTUP_DB_TARGETS[index][1]}: ${label} failed:`,
          result.reason?.message || result.reason,
        );
      }
    });
  });
}

function normalizeNumbers(text) {
  if (!text) return text;

  const arabic = "٠١٢٣٤٥٦٧٨٩";
  const english = "0123456789";

  return text.replace(/[٠-٩]/g, (d) => english[arabic.indexOf(d)]);
}

/** Return today's date as YYYY-MM-DD in Africa/Cairo timezone */
function getCairoDate() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });
}

const app = express();
app.use(
  cors({
    origin: [
      "https://homeglass-web.vercel.app",
      "https://house-of-glass-phi.vercel.app",
      "https://x.hg-alshour.online",
      "http://localhost:3000", "http://localhost:3001", "http://localhost:3002",
      "http://localhost:8000",
      "http://192.168.1.63:3000",
      "https://hg-alshour.online",
      "https://www.hg-alshour.online",
    ],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization", "X-API-Key"],
    credentials: true,
  }),
);

app.use(express.json({ limit: "50mb" }));
app.use("/assets", express.static(path.join(__dirname, "assets")));

// Global auth middleware — protects ALL routes except public ones
const PUBLIC_PATHS = [
  "/login",
  "/health",
  "/public",
  "/admin",
  "/integrations",
  "/chat/media",
  "/api/inter-branch/webhook",
];
const jwt_auth = require("jsonwebtoken");
app.use((req, res, next) => {
  // Allow public paths
  if (PUBLIC_PATHS.some((p) => req.path === p || req.path.startsWith(p + "/")))
    return next();
  // Allow static files
  if (req.path.startsWith("/assets") || req.path.startsWith("/uploads"))
    return next();
  // Allow Socket.IO
  if (req.path.startsWith("/socket.io")) return next();
  // Check auth
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "Unauthorized" });
  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt_auth.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Token غير صالح" });
  }
});

// Health check endpoint (for Render / monitoring)
app.get("/health", async (req, res) => {
  // Find latest backup file
  let lastBackup = null;
  try {
    const bDir =
      process.platform === "win32"
        ? "D:\\glass-backups"
        : path.join(__dirname, "backups");
    if (fs.existsSync(bDir)) {
      const files = fs
        .readdirSync(bDir)
        .filter((f) => f.startsWith("glass_system_") && f.endsWith(".sql"))
        .map((f) => ({
          name: f,
          mtime: fs.statSync(path.join(bDir, f)).mtime,
        }))
        .sort((a, b) => b.mtime - a.mtime);
      if (files.length > 0) {
        lastBackup = {
          file: files[0].name,
          time: files[0].mtime.toISOString(),
          count: files.length,
        };
      }
    }
  } catch {
    /* ignore */
  }

  let primaryHost = process.env.DB_HOST || "dbstudio.hg-alshour.online";
  if (process.env.DATABASE_URL) {
    try {
      primaryHost = new URL(process.env.DATABASE_URL).hostname;
    } catch {}
  }
  const standbyHost = process.env.BACKUP_DB_HOST || "18.185.48.10";

  res.json({
    status: "ok",
    activeDb: dbState.activeDb || "primary",
    activeServer: {
      name: primaryHost.includes("dbstudio") ? "Data Studio HA Cluster" : "AWS Cloud",
      host: primaryHost,
      role: "الأساسي (Master)",
      status: "online",
      isDataStudio: primaryHost.includes("dbstudio")
    },
    standbyServer: {
      name: "AWS Cloud Standby",
      host: standbyHost,
      role: "الاحتياطي اللحظي (Standby)",
      status: "synchronized"
    },
    localAlive: dbState.localAlive,
    cloudAlive: dbState.cloudAlive,
    syncInProgress: dbState.syncInProgress,
    lastSync: dbState.lastSyncResult,
    periodicSyncIntervalMs: dbState.periodicSyncIntervalMs,
    nextPeriodicSyncAt: dbState.nextPeriodicSyncAt,
    failoverHistory: dbState.failoverHistory.slice(-5),
    lastBackup,
    lastAutoBackup: lastAutoBackup || null,
    manualLock: dbState.manualLock,
    manualLockExpiredAt:
      dbState.manualLock && dbState.manualLockTime
        ? new Date(dbState.manualLockTime + 3600000).toISOString()
        : null,
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

/* ── Admin: Switch Active DB ── */
app.post("/admin/switch-db", async (req, res) => {
  try {
    const target = req.body.target; // "local" | "cloud"
    if (!target || !["local", "cloud"].includes(target)) {
      return res
        .status(400)
        .json({ error: 'target must be "local" or "cloud"' });
    }
    const pool = target === "local" ? localPool : cloudPool;
    const alive = await checkPool(pool, target);
    if (!alive) {
      return res.status(503).json({ error: `${target} DB is unreachable` });
    }
    const prev = dbState.activeDb;
    dbState.activeDb = target;
    dbState.manualLock = true; // Lock to prevent auto-failback
    dbState.manualLockTime = Date.now(); // Record when lock was set (1-hour timeout)
    dbState.failoverHistory.push({
      from: prev,
      to: target,
      time: new Date().toISOString(),
      reason: "Manual switch (locked)",
    });
    console.log(
      `🔄 Manual switch: ${prev} → ${target} (auto-failback locked for 1 hour)`,
    );
    res.json({ ok: true, activeDb: target, previous: prev });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── Admin: Trigger Sync ── */
app.post("/admin/sync", async (req, res) => {
  try {
    const result = await syncBetweenPools({ trigger: "manual" });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── Admin: Read recent sync logs ── */
app.get("/admin/sync-logs", (req, res) => {
  try {
    const limit = Number(req.query.limit) || 100;
    const logs = getSyncLogs(limit);
    res.json({ ok: true, logs });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ── Admin: Queue public webhook test delivery ── */
app.post("/admin/public-webhooks/test-delivery", authMiddleware, async (req, res) => {
  try {
    const currentUser = await requireAdminUser(req, res);
    if (!currentUser) return;

    if (!arePublicWebhookTestRoutesEnabled()) {
      return res.status(403).json({
        error: "Public webhook test routes are disabled",
      });
    }

    const eventType = String(req.body.eventType || "").trim();
    const scopeMode = String(req.body.scopeMode || "items")
      .trim()
      .toLowerCase();
    const allowedEventTypes = [
      "public.products.changed",
      "public.stock.changed",
    ];

    if (!allowedEventTypes.includes(eventType)) {
      return res.status(400).json({
        error:
          "eventType must be public.products.changed or public.stock.changed",
      });
    }

    if (!["items", "full"].includes(scopeMode)) {
      return res.status(400).json({
        error: 'scopeMode must be "items" or "full"',
      });
    }

    const delivery = await queuePublicWebhookTestEvent(pool, {
      eventType,
      scopeMode,
      items: Array.isArray(req.body.items) ? req.body.items : undefined,
    });

    res.status(201).json({
      ok: true,
      delivery,
      delivery_enabled: dbState.publicWebhook.deliveryEnabled,
    });
  } catch (err) {
    console.error("PUBLIC WEBHOOK TEST DELIVERY ERROR:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

/* ── Admin: Public webhook status ── */
app.get("/admin/public-webhooks/status", authMiddleware, async (req, res) => {
  try {
    const currentUser = await requireAdminUser(req, res);
    if (!currentUser) return;

    if (!arePublicWebhookTestRoutesEnabled()) {
      return res.status(403).json({
        error: "Public webhook test routes are disabled",
      });
    }

    const summaryResult = await pool.query(
      `
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending') AS pending_count,
        COUNT(*) FILTER (WHERE status = 'delivering') AS delivering_count,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed_count,
        COUNT(*) FILTER (WHERE status = 'delivered') AS delivered_count,
        MIN(next_attempt_at) FILTER (
          WHERE status IN ('pending', 'failed', 'delivering')
        ) AS oldest_pending_at,
        MAX(delivered_at) AS last_delivered_at
      FROM public_webhook_deliveries
      `,
    );

    const unqueuedResult = await pool.query(
      `
      SELECT COUNT(*) AS unqueued_change_rows
      FROM public_webhook_change_log l
      LEFT JOIN public_webhook_deliveries d
        ON d.batch_txid = l.batch_txid
       AND d.event_type = l.event_type
      WHERE d.id IS NULL
      `,
    );

    const recentDeliveriesResult = await pool.query(
      `
      SELECT event_id, event_type, revision, status, attempts, next_attempt_at, delivered_at, updated_at
      FROM public_webhook_deliveries
      ORDER BY revision DESC
      LIMIT 10
      `,
    );

    res.json({
      ok: true,
      config: {
        capture_enabled: dbState.publicWebhook.captureEnabled,
        delivery_enabled: dbState.publicWebhook.deliveryEnabled,
        test_routes_enabled: arePublicWebhookTestRoutesEnabled(),
      },
      runtime: {
        last_claimed_at: dbState.publicWebhook.lastClaimedAt,
        last_delivery_at: dbState.publicWebhook.lastDeliveryAt,
        last_delivery_error: dbState.publicWebhook.lastDeliveryError,
      },
      summary: {
        ...summaryResult.rows[0],
        unqueued_change_rows: Number(
          unqueuedResult.rows[0]?.unqueued_change_rows || 0,
        ),
      },
      recent_deliveries: recentDeliveriesResult.rows,
    });
  } catch (err) {
    console.error("PUBLIC WEBHOOK STATUS ERROR:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

/* ── Admin: Replay public webhook delivery ── */
app.post("/admin/public-webhooks/replay", authMiddleware, async (req, res) => {
  try {
    const currentUser = await requireAdminUser(req, res);
    if (!currentUser) return;

    if (!arePublicWebhookTestRoutesEnabled()) {
      return res.status(403).json({
        error: "Public webhook test routes are disabled",
      });
    }

    const eventId = String(req.body.eventId || "").trim();
    const revision = Number(req.body.revision || 0) || null;

    if (!eventId && !revision) {
      return res.status(400).json({
        error: "eventId or revision is required",
      });
    }

    const deliveries = await replayPublicWebhookDelivery(pool, {
      eventId,
      revision,
    });

    if (!deliveries.length) {
      return res.status(404).json({ error: "Delivery not found" });
    }

    res.json({
      ok: true,
      deliveries,
      delivery_enabled: dbState.publicWebhook.deliveryEnabled,
    });
  } catch (err) {
    console.error("PUBLIC WEBHOOK REPLAY ERROR:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

/* ── Cross-platform helpers ── */
const isWindows = process.platform === "win32";
const BACKUP_DIR = isWindows
  ? "D:\\glass-backups"
  : path.join(__dirname, "backups");
const PG_DUMP = isWindows
  ? '"C:\\Program Files\\PostgreSQL\\18\\bin\\pg_dump.exe"'
  : "pg_dump";

function getDbEnv(target) {
  if (target === "cloud") {
    return {
      host: process.env.DB_HOST_CLOUD,
      port: process.env.DB_PORT_CLOUD || "5432",
      user: process.env.DB_USER_CLOUD,
      pass: process.env.DB_PASSWORD_CLOUD,
      name: process.env.DB_NAME_CLOUD,
    };
  }
  return {
    host: process.env.DB_HOST_LOCAL,
    port: process.env.DB_PORT_LOCAL || "5432",
    user: process.env.DB_USER_LOCAL,
    pass: process.env.DB_PASSWORD_LOCAL,
    name: process.env.DB_NAME_LOCAL,
  };
}

function buildPgCmd(tool, dbEnv, extraArgs) {
  const { host, port, user, pass, name } = dbEnv;
  const passEnv = isWindows
    ? `set PGPASSWORD=${pass}&&`
    : `PGPASSWORD='${pass}' `;
  return `${passEnv}${tool} -U ${user} -h ${host} -p ${port} -d ${name} ${extraArgs}`;
}

/* ── Google Drive: download latest backup (with progress callback) ── */
async function downloadLatestFromDrive(onProgress) {
  const { google } = require("googleapis");

  let clientId, clientSecret, refreshToken;
  const credFile = path.join(__dirname, "credentials", "oauth-client.json");
  const tokenFile = path.join(__dirname, "credentials", "gdrive-token.json");

  if (fs.existsSync(credFile) && fs.existsSync(tokenFile)) {
    const creds = JSON.parse(fs.readFileSync(credFile, "utf8"));
    const key = Object.keys(creds)[0];
    clientId = creds[key].client_id;
    clientSecret = creds[key].client_secret;
    const tokens = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
    refreshToken = tokens.refresh_token;
  } else {
    clientId = process.env.GDRIVE_CLIENT_ID;
    clientSecret = process.env.GDRIVE_CLIENT_SECRET;
    refreshToken = process.env.GDRIVE_REFRESH_TOKEN;
  }

  const folderId =
    process.env.GDRIVE_FOLDER_ID || "1sOVQgZ2A_Vfr2KfZ5I1yjjwSIMH3R3Iw";

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Google Drive credentials not configured");
  }

  const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
  oauth2.setCredentials({ refresh_token: refreshToken });
  const drive = google.drive({ version: "v3", auth: oauth2 });

  const list = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false and name contains 'glass_system'`,
    orderBy: "createdTime desc",
    pageSize: 1,
    fields: "files(id, name, size)",
  });

  if (!list.data.files?.length) {
    throw new Error("No backup files found on Google Drive");
  }

  const file = list.data.files[0];
  const totalSize = parseInt(file.size || "0");
  const tmpDir = require("os").tmpdir();
  const tmpFile = path.join(tmpDir, file.name);

  const response = await drive.files.get(
    { fileId: file.id, alt: "media" },
    { responseType: "stream" },
  );

  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(tmpFile);
    let downloaded = 0;
    response.data.on("data", (chunk) => {
      downloaded += chunk.length;
      if (totalSize > 0 && onProgress) {
        const pct = Math.round((downloaded / totalSize) * 100);
        onProgress(pct);
      }
    });
    response.data.pipe(ws);
    ws.on("finish", resolve);
    ws.on("error", reject);
  });

  const sizeMB = (fs.statSync(tmpFile).size / 1024 / 1024).toFixed(2);
  return { filePath: tmpFile, fileName: file.name, sizeMB };
}

/* ── SSE helper ── */
function setupSSE(res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  const send = (pct, msg, done, error, extra) => {
    const payload = { progress: pct, message: msg };
    if (done) payload.done = true;
    if (error) payload.error = true;
    if (extra) Object.assign(payload, extra);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    if (done || error) setTimeout(() => res.end(), 100);
  };
  return send;
}

/* ── Google Drive: upload file (works with files OR env vars) ── */
async function uploadToDrive(filePath) {
  const { google } = require("googleapis");

  let clientId, clientSecret, refreshToken;
  const credFile = path.join(__dirname, "credentials", "oauth-client.json");
  const tokenFile = path.join(__dirname, "credentials", "gdrive-token.json");

  if (fs.existsSync(credFile) && fs.existsSync(tokenFile)) {
    const creds = JSON.parse(fs.readFileSync(credFile, "utf8"));
    const key = Object.keys(creds)[0];
    clientId = creds[key].client_id;
    clientSecret = creds[key].client_secret;
    const tokens = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
    refreshToken = tokens.refresh_token;
  } else {
    clientId = process.env.GDRIVE_CLIENT_ID;
    clientSecret = process.env.GDRIVE_CLIENT_SECRET;
    refreshToken = process.env.GDRIVE_REFRESH_TOKEN;
  }

  const folderId =
    process.env.GDRIVE_FOLDER_ID || "1sOVQgZ2A_Vfr2KfZ5I1yjjwSIMH3R3Iw";

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Google Drive credentials not configured");
  }

  const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
  oauth2.setCredentials({ refresh_token: refreshToken });
  const drive = google.drive({ version: "v3", auth: oauth2 });

  const fileName = path.basename(filePath);
  const res = await drive.files.create({
    requestBody: { name: fileName, parents: [folderId] },
    media: {
      mimeType: "application/sql",
      body: fs.createReadStream(filePath),
    },
    fields: "id,name",
  });

  // Cleanup old files (keep last 5)
  const list = await drive.files.list({
    q: `'${folderId}' in parents and trashed=false`,
    orderBy: "createdTime desc",
    pageSize: 100,
    fields: "files(id,name)",
  });
  const files = list.data.files || [];
  if (files.length > 5) {
    for (const f of files.slice(5)) {
      await drive.files.delete({ fileId: f.id }).catch(() => {});
    }
  }

  return res.data;
}

/* ── Admin: Manual Backup (SSE progress) ── */
app.post("/admin/backup", (req, res) => {
  const send = setupSSE(res);
  send(5, "جاري تجهيز الباك أب...");

  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }

  const ts = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}_${String(d.getHours()).padStart(2, "0")}-${String(d.getMinutes()).padStart(2, "0")}`;
  })();
  const backupFile = path.join(BACKUP_DIR, `glass_system_${ts}.sql`);

  const dbEnv = getDbEnv();
  const cmd = buildPgCmd(
    PG_DUMP,
    dbEnv,
    `--clean --if-exists --no-owner --no-privileges --inserts --encoding=UTF8 -f "${backupFile}"`,
  );

  send(15, "جاري تصدير قاعدة البيانات...");

  exec(cmd, { timeout: 180000 }, async (err, stdout, stderr) => {
    if (err) {
      console.error("backup error:", err.message, stderr);
      return send(0, `فشل الباك أب: ${err.message}`, false, true);
    }
    try {
      const size = fs.statSync(backupFile).size;
      const sizeMB = (size / 1024 / 1024).toFixed(2);

      send(65, `تم التصدير (${sizeMB} MB) — جاري الرفع على Google Drive...`);

      try {
        await uploadToDrive(backupFile);
        send(
          100,
          `تم الباك أب + الرفع على Drive: ${path.basename(backupFile)} (${sizeMB} MB)`,
          true,
          false,
          { file: path.basename(backupFile), sizeMB: parseFloat(sizeMB) },
        );
      } catch (uploadErr) {
        console.error("Drive upload error:", uploadErr.message);
        send(
          100,
          `تم الباك أب: ${path.basename(backupFile)} (${sizeMB} MB) — فشل الرفع على Drive: ${uploadErr.message}`,
          true,
          false,
          { file: path.basename(backupFile), sizeMB: parseFloat(sizeMB) },
        );
      }
    } catch (e) {
      send(0, e.message, false, true);
    }
  });
});

function roundMoney(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) {
    return 0;
  }

  return Math.round(amount * 100) / 100;
}

function formatInvoiceCashMetadataValue(value) {
  return roundMoney(value)
    .toFixed(2)
    .replace(/\.00$/, "")
    .replace(/(\.\d*[1-9])0$/, "$1");
}

function extractInvoiceIdFromCashDescription(description) {
  const match = String(description || "").match(/#\s*(\d+)/);
  return match ? Number(match[1]) : null;
}

function buildInvoiceCashDescription(
  invoiceType,
  invoiceId,
  totalAmount,
  paidAmount,
  remainingAmount,
) {
  const label =
    invoiceType === "retail" ? "فاتورة قطاعي رقم #" : "فاتورة جملة رقم #";
  return `${label}${invoiceId}{{${formatInvoiceCashMetadataValue(totalAmount)}|${formatInvoiceCashMetadataValue(paidAmount)}|${formatInvoiceCashMetadataValue(remainingAmount)}}}`;
}

async function syncInvoiceCashEntry(
  client,
  {
    invoiceId,
    branchId,
    invoiceType,
    customerId = null,
    customerName,
    totalAmount,
    paidAmount,
    remainingAmount,
    transactionDate,
  },
) {
  const normalizedInvoiceId = Number(invoiceId);
  const normalizedBranchId = Number(branchId);
  const normalizedTotalAmount = roundMoney(totalAmount);
  const normalizedPaidAmount = roundMoney(paidAmount);
  const normalizedRemainingAmount = roundMoney(remainingAmount);
  const normalizedCustomerName = customerName?.trim() || "عميل نقدي";
  const description = buildInvoiceCashDescription(
    invoiceType,
    normalizedInvoiceId,
    normalizedTotalAmount,
    normalizedPaidAmount,
    normalizedRemainingAmount,
  );

  const cashRowsRes = await client.query(
    `
    SELECT id, invoice_id, description
    FROM cash_in
    WHERE source_type = 'invoice'
      AND branch_id = $2
      AND (invoice_id = $1 OR invoice_id IS NULL)
    ORDER BY CASE WHEN invoice_id = $1 THEN 0 ELSE 1 END, id ASC
    `,
    [normalizedInvoiceId, normalizedBranchId],
  );

  const matchingRows = cashRowsRes.rows.filter((row) => {
    if (Number(row.invoice_id) === normalizedInvoiceId) {
      return true;
    }

    return (
      row.invoice_id == null &&
      extractInvoiceIdFromCashDescription(row.description) ===
        normalizedInvoiceId
    );
  });

  if (!matchingRows.length && normalizedPaidAmount <= 0) {
    return { action: "skipped", duplicateIds: [] };
  }

  if (matchingRows.length) {
    const primaryRow = matchingRows[0];
    const duplicateIds = matchingRows.slice(1).map((row) => Number(row.id));

    await client.query(
      `
      UPDATE cash_in
      SET
        branch_id = $1,
        invoice_id = $2,
        customer_id = $3,
        customer_name = $4,
        amount = $5,
        paid_amount = $6,
        remaining_amount = $7,
        description = $8,
        transaction_date = COALESCE($9::date, transaction_date)
      WHERE id = $10
      `,
      [
        normalizedBranchId,
        normalizedInvoiceId,
        customerId,
        normalizedCustomerName,
        normalizedTotalAmount,
        normalizedPaidAmount,
        normalizedRemainingAmount,
        description,
        transactionDate || null,
        primaryRow.id,
      ],
    );

    if (duplicateIds.length) {
      await client.query(`DELETE FROM cash_in WHERE id = ANY($1::int[])`, [
        duplicateIds,
      ]);
    }

    return { action: "updated", duplicateIds };
  }

  await client.query(
    `
    INSERT INTO cash_in
    (
      branch_id,
      invoice_id,
      customer_id,
      customer_name,
      amount,
      paid_amount,
      remaining_amount,
      description,
      source_type,
      transaction_date
    )
    VALUES
    ($1,$2,$3,$4,$5,$6,$7,$8,'invoice',COALESCE($9::date, CURRENT_DATE))
    `,
    [
      normalizedBranchId,
      normalizedInvoiceId,
      customerId,
      normalizedCustomerName,
      normalizedTotalAmount,
      normalizedPaidAmount,
      normalizedRemainingAmount,
      description,
      transactionDate || null,
    ],
  );

  return { action: "inserted", duplicateIds: [] };
}

/* ── Automatic Hourly Backup to Google Drive ── */
let lastAutoBackup = null;

async function autoBackupToDrive() {
  console.log("⏰ Auto-backup: starting hourly backup...");
  try {
    if (!fs.existsSync(BACKUP_DIR)) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }

    const ts = (() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}_${String(d.getHours()).padStart(2, "0")}-00`;
    })();
    const backupFile = path.join(BACKUP_DIR, `glass_system_${ts}.sql`);

    const dbEnv = getDbEnv();
    const cmd = buildPgCmd(
      PG_DUMP,
      dbEnv,
      `--clean --if-exists --no-owner --no-privileges --inserts --encoding=UTF8 -f "${backupFile}"`,
    );

    await new Promise((resolve, reject) => {
      exec(cmd, { timeout: 180000 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        resolve();
      });
    });

    const size = fs.statSync(backupFile).size;
    const sizeMB = (size / 1024 / 1024).toFixed(2);
    console.log(`⏰ Auto-backup: exported ${sizeMB} MB, uploading to Drive...`);

    await uploadToDrive(backupFile);

    lastAutoBackup = {
      file: path.basename(backupFile),
      sizeMB: parseFloat(sizeMB),
      time: new Date().toISOString(),
    };
    console.log(
      `✅ Auto-backup complete: ${lastAutoBackup.file} (${sizeMB} MB)`,
    );
  } catch (err) {
    console.error("❌ Auto-backup failed:", err.message);
  }
}

// Run auto-backup every hour (first one after 2 minutes of startup)
setTimeout(() => autoBackupToDrive(), 2 * 60 * 1000);
setInterval(() => autoBackupToDrive(), 60 * 60 * 1000);

/* ── Admin: Restore from Google Drive → local DB (SSE progress) ── */
app.post("/admin/restore", async (req, res) => {
  const send = setupSSE(res);

  try {
    send(5, "جاري الاتصال بـ Google Drive...");
    let tmpFile = null;
    let lastPct = 5;

    const dl = await downloadLatestFromDrive((dlPct) => {
      const mapped = Math.round(5 + (dlPct * 45) / 100);
      if (mapped > lastPct) {
        lastPct = mapped;
        send(mapped, `جاري التنزيل: ${dlPct}%`);
      }
    });
    tmpFile = dl.filePath;
    send(52, `تم التنزيل (${dl.sizeMB} MB) — جاري القراءة...`);

    let sql = fs.readFileSync(dl.filePath, "utf8");
    sql = sql.replace(
      /^COPY\s+.*?FROM\s+stdin;[\s\S]*?^\\\./gm,
      "-- [COPY block removed]",
    );
    send(60, "جاري تجهيز الاتصال بقاعدة البيانات...");

    const dbEnv = getDbEnv();
    const { Pool: PgPool } = require("pg");
    const restorePool = new PgPool({
      host: dbEnv.host,
      port: Number(dbEnv.port),
      user: dbEnv.user,
      password: dbEnv.pass,
      database: dbEnv.name,
      ssl:
        process.env.DB_SSL_LOCAL === "true"
          ? { rejectUnauthorized: false }
          : false,
      statement_timeout: 600000,
    });

    send(65, "جاري تنفيذ الريستور...");

    const statements = sql.split(/;\s*\n/).filter((s) => s.trim());
    const total = statements.length;
    const client = await restorePool.connect();
    let executed = 0;
    let errors = 0;

    try {
      await client.query("BEGIN");
      for (const stmt of statements) {
        const trimmed = stmt.trim();
        if (!trimmed || trimmed.startsWith("--")) {
          executed++;
          continue;
        }
        try {
          await client.query(trimmed);
        } catch {
          errors++;
        }
        executed++;
        const pct = Math.round(65 + (executed / total) * 30);
        if (pct > lastPct + 4) {
          lastPct = pct;
          send(pct, `جاري التنفيذ: ${Math.round((executed / total) * 100)}%`);
        }
      }
      await client.query("COMMIT");
    } catch (txErr) {
      try {
        await client.query("ROLLBACK");
      } catch {}
      throw txErr;
    } finally {
      client.release();
      await restorePool.end();
    }

    try {
      fs.unlinkSync(tmpFile);
    } catch {}

    send(
      100,
      `تم الريستور: ${dl.fileName} (${errors > 0 ? errors + " تحذيرات" : "بدون أخطاء"})`,
      true,
      false,
      { file: dl.fileName },
    );
  } catch (err) {
    console.error("restore error:", err);
    send(0, `فشل الريستور: ${err.message}`, false, true);
  }
});

const chatUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Sound uploads
const soundsDir = path.join(__dirname, "uploads", "sounds");
if (!fs.existsSync(soundsDir)) {
  fs.mkdirSync(soundsDir, { recursive: true });
}
const soundUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, soundsDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || ".mp3";
      cb(
        null,
        `sound_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`,
      );
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("audio/")) {
      cb(null, true);
    } else {
      cb(new Error("Only audio files are allowed"));
    }
  },
});

/* ========== Real-time: auto-emit socket events on successful writes ========== */
app.use((req, res, next) => {
  if (["POST", "PUT", "DELETE"].includes(req.method)) {
    const originalJson = res.json.bind(res);
    res.json = function (data) {
      if (res.statusCode < 400) {
        const io = req.app.get("io");
        if (io) {
          const p = req.originalUrl || req.url;
          let channel = "data:misc";
          if (p.includes("/invoices")) channel = "data:invoices";
          else if (p.includes("/cash")) channel = "data:cash";
          else if (p.includes("/stock") || p.includes("/transfer"))
            channel = "data:stock";
          else if (p.includes("/products") || p.includes("/manufacturers"))
            channel = "data:products";
          else if (p.includes("/customers")) channel = "data:customers";
          else if (p.includes("/users")) channel = "data:users";
          else if (p.includes("/opening-stock")) channel = "data:stock";
          io.emit(channel, {
            action: req.method,
            path: p,
            ts: Date.now(),
          });
        }
      }
      return originalJson(data);
    };
  }
  next();
});

const reportsRoutes = require("./reports/reports.routes");
app.use("/reports", reportsRoutes);

const interBranchRoutes = require("./inter-branch/inter-branch.routes");
app.use("/api/inter-branch", interBranchRoutes);

const productsRoutes = require("./modules/products/products.routes");

//app.use("/products", productsRoutes);

app.get("/", (req, res) => {
  res.send("Glass System Backend Running 🚀");
});

if (process.env.ENABLE_STARTUP_MIGRATIONS === "true") {
// 📋 إنشاء جدول سجل النشاط لو مش موجود
pool
  .query(
    `
  CREATE TABLE IF NOT EXISTS user_activity (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    username VARCHAR(100) NOT NULL,
    action VARCHAR(20) NOT NULL,
    ip_address VARCHAR(100),
    created_at TIMESTAMP DEFAULT NOW()
  )
`,
  )
  .then(() => console.log("✅ user_activity table ready"))
  .catch((e) => console.error("❌ user_activity table error:", e.message));

// � أعمدة تتبع اليوزر في الفواتير
pool
  .query(
    `
  ALTER TABLE invoices
    ADD COLUMN IF NOT EXISTS created_by INTEGER,
    ADD COLUMN IF NOT EXISTS created_by_name VARCHAR(100),
    ADD COLUMN IF NOT EXISTS updated_by INTEGER,
    ADD COLUMN IF NOT EXISTS updated_by_name VARCHAR(100)
  `,
  )
  .then(() => console.log("✅ invoices audit columns ready"))
  .catch((e) => console.error("❌ invoices audit columns error:", e.message));

// ✅ إضافة عمود استلام الصنف في التحويلات
pool
  .query(
    `
  ALTER TABLE stock_transfer_items
    ADD COLUMN IF NOT EXISTS received BOOLEAN DEFAULT FALSE
  `,
  )
  .then(() => console.log("✅ stock_transfer_items.received column ready"))
  .catch((e) =>
    console.error("❌ stock_transfer_items.received error:", e.message),
  );

// ✅ عمود أساس الخصم للمصنع: 'purchase' (افتراضي) أو 'sale'
pool
  .query(
    `ALTER TABLE manufacturers
       ADD COLUMN IF NOT EXISTS discount_base VARCHAR(20) NOT NULL DEFAULT 'purchase'`,
  )
  .then(() => console.log("✅ manufacturers.discount_base column ready"))
  .catch((e) =>
    console.error("❌ manufacturers.discount_base error:", e.message),
  );

// 📦 إنشاء جدول الأكواد الفرعية (عبوات بديلة) لو مش موجود
pool
  .query(
    `
  CREATE TABLE IF NOT EXISTS product_variants (
    id SERIAL PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    label VARCHAR(255),
    barcode VARCHAR(100),
    wholesale_package VARCHAR(255),
    retail_package VARCHAR(255),
    purchase_price NUMERIC DEFAULT 0,
    retail_purchase_price NUMERIC DEFAULT 0,
    wholesale_price NUMERIC DEFAULT 0,
    retail_price NUMERIC DEFAULT 0,
    discount_amount NUMERIC DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
  )
`,
  )
  .then(() => console.log("✅ product_variants table ready"))
  .catch((e) => console.error("❌ product_variants table error:", e.message));

// 📋 عمود تفضيلات اليوزر (JSON)
pool
  .query(
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS preferences JSONB DEFAULT '{}'`,
  )
  .then(() => console.log("✅ users.preferences column ready"))
  .catch((e) => console.error("❌ users.preferences column error:", e.message));

// إضافة عمود الخصم لو مش موجود
pool
  .query(
    `ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS discount_amount NUMERIC DEFAULT 0`,
  )
  .then(() => console.log("✅ discount_amount column ready"))
  .catch((e) => console.error("❌ discount_amount column error:", e.message));

// إضافة عمود الوصف/كلمات مفتاحية للأصناف
pool
  .query(
    `ALTER TABLE products ADD COLUMN IF NOT EXISTS description TEXT DEFAULT ''`,
  )
  .then(() => console.log("✅ products.description column ready"))
  .catch((e) =>
    console.error("❌ products.description column error:", e.message),
  );

// إضافة عمود الاسم بالكامل للمستخدمين
pool
  .query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name TEXT DEFAULT ''`)
  .then(() => console.log("✅ users.full_name column ready"))
  .catch((e) => console.error("❌ users.full_name column error:", e.message));

pool
  .query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'user'`)
  .then(() => console.log("✅ users.role column ready"))
  .catch((e) => console.error("❌ users.role column error:", e.message));

pool
  .query(
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions JSONB DEFAULT '{}'`,
  )
  .then(() => console.log("✅ users.permissions column ready"))
  .catch((e) => console.error("❌ users.permissions column error:", e.message));

// إضافة عمود has_wholesale للأصناف
pool
  .query(
    `ALTER TABLE products ADD COLUMN IF NOT EXISTS has_wholesale BOOLEAN DEFAULT true`,
  )
  .then(() => console.log("✅ products.has_wholesale column ready"))
  .catch((e) =>
    console.error("❌ products.has_wholesale column error:", e.message),
  );

pool
  .query(
    `ALTER TABLE products
      ADD COLUMN IF NOT EXISTS purchase_price_adjustment NUMERIC DEFAULT 0,
      ADD COLUMN IF NOT EXISTS purchase_price_adjustment_is_percentage BOOLEAN DEFAULT false`,
  )
  .then(() => console.log("✅ products.purchase adjustment columns ready"))
  .catch((e) =>
    console.error("❌ products.purchase adjustment columns error:", e.message),
  );

// إضافة عمود المرتجع للفواتير
pool
  .query(
    `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS is_return BOOLEAN DEFAULT false`,
  )
  .then(() => console.log("✅ invoices.is_return column ready"))
  .catch((e) =>
    console.error("❌ invoices.is_return column error:", e.message),
  );

// إضافة عمود الملاحظات للفواتير
pool
  .query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS notes TEXT`)
  .then(() => console.log("✅ invoices.notes column ready"))
  .catch((e) => console.error("❌ invoices.notes column error:", e.message));

// إضافة عمود المرتجع للأصناف (item-level)
pool
  .query(
    `ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS is_return BOOLEAN DEFAULT false`,
  )
  .then(() => console.log("✅ invoice_items.is_return column ready"))
  .catch((e) =>
    console.error("❌ invoice_items.is_return column error:", e.message),
  );

pool
  .query(
    `ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS cost_price NUMERIC`,
  )
  .then(() => console.log("✅ invoice_items.cost_price column ready"))
  .catch((e) =>
    console.error("❌ invoice_items.cost_price column error:", e.message),
  );

// 📦 migrations لـ variant_id (متسلسلة عشان الـ constraint يشتغل بعد الأعمدة)
(async () => {
  try {
    await pool.query(
      `ALTER TABLE stock ADD COLUMN IF NOT EXISTS variant_id INTEGER DEFAULT 0`,
    );
    console.log("✅ stock.variant_id column ready");

    await pool.query(
      `ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS variant_id INTEGER DEFAULT 0`,
    );
    console.log("✅ stock_movements.variant_id column ready");

    await pool.query(
      `ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS variant_id INTEGER DEFAULT 0`,
    );
    console.log("✅ invoice_items.variant_id column ready");

    // تحديث constraint بعد التأكد إن العمود موجود
    await pool.query(`
      DO $$
      BEGIN
        -- حذف القيد القديم لو موجود (unique)
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_warehouse_id_product_id_key') THEN
          ALTER TABLE stock DROP CONSTRAINT stock_warehouse_id_product_id_key;
        END IF;

        -- حذف الـ primary key القديم لو مبني على (warehouse_id, product_id) بدون variant_id
        IF EXISTS (
          SELECT 1 FROM pg_constraint c
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
          WHERE c.conrelid = 'stock'::regclass
            AND c.contype = 'p'
          GROUP BY c.oid
          HAVING COUNT(*) = 2
             AND BOOL_AND(a.attname IN ('warehouse_id','product_id'))
        ) THEN
          ALTER TABLE stock DROP CONSTRAINT stock_pkey;
          ALTER TABLE stock ADD PRIMARY KEY (warehouse_id, product_id, variant_id);
        END IF;

        -- إنشاء القيد الجديد لو مش موجود (احتياطي)
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_warehouse_product_variant_unique')
           AND NOT EXISTS (
             SELECT 1 FROM pg_constraint
             WHERE conrelid = 'stock'::regclass AND contype = 'p'
           )
        THEN
          ALTER TABLE stock ADD CONSTRAINT stock_warehouse_product_variant_unique UNIQUE (warehouse_id, product_id, variant_id);
        END IF;
      END $$;
    `);
    console.log("✅ stock unique constraint updated");

    // 🔧 تصليح البيانات القديمة: لو كل الرصيد في variant_id=0 والحركات فيها variant_ids مختلفة
    // نعيد حساب الرصيد من الحركات
    await pool.query(`
      DO $$
      DECLARE
        r RECORD;
      BEGIN
        FOR r IN
          SELECT warehouse_id, product_id, variant_id, SUM(
            CASE
              WHEN movement_type IN ('purchase','transfer_in','replace_in','return_sale','inter_branch_in') THEN quantity
              WHEN movement_type IN ('sale','transfer_out','replace_out','return_purchase','inter_branch_out') THEN -quantity
              ELSE 0
            END
          ) AS calc_qty
          FROM stock_movements
          WHERE variant_id IS NOT NULL AND variant_id != 0
          GROUP BY warehouse_id, product_id, variant_id
          HAVING SUM(
            CASE
              WHEN movement_type IN ('purchase','transfer_in','replace_in','return_sale','inter_branch_in') THEN quantity
              WHEN movement_type IN ('sale','transfer_out','replace_out','return_purchase','inter_branch_out') THEN -quantity
              ELSE 0
            END
          ) > 0
        LOOP
          INSERT INTO stock (warehouse_id, product_id, variant_id, quantity)
          VALUES (r.warehouse_id, r.product_id, r.variant_id, r.calc_qty)
          ON CONFLICT (warehouse_id, product_id, variant_id)
          DO UPDATE SET quantity = r.calc_qty;
        END LOOP;

        -- حساب رصيد variant_id=0 من الحركات
        FOR r IN
          SELECT warehouse_id, product_id, SUM(
            CASE
              WHEN movement_type IN ('purchase','transfer_in','replace_in','return_sale','inter_branch_in') THEN quantity
              WHEN movement_type IN ('sale','transfer_out','replace_out','return_purchase','inter_branch_out') THEN -quantity
              ELSE 0
            END
          ) AS calc_qty
          FROM stock_movements
          WHERE COALESCE(variant_id, 0) = 0
          GROUP BY warehouse_id, product_id
        LOOP
          INSERT INTO stock (warehouse_id, product_id, variant_id, quantity)
          VALUES (r.warehouse_id, r.product_id, 0, GREATEST(r.calc_qty, 0))
          ON CONFLICT (warehouse_id, product_id, variant_id)
          DO UPDATE SET quantity = GREATEST(r.calc_qty, 0);
        END LOOP;
      END $$;
    `);
    console.log("✅ stock data recalculated from movements");
  } catch (e) {
    console.error("❌ variant migrations error:", e.message);
  }
})();
}

// � جدول الموردين
(async () => {
  try {
    await runStartupSqlOnAllPools(
      "suppliers table ready",
      `
      CREATE TABLE IF NOT EXISTS suppliers (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `,
    );

    await runStartupSqlOnAllPools(
      "supplier_phones table ready",
      `
      CREATE TABLE IF NOT EXISTS supplier_phones (
        id SERIAL PRIMARY KEY,
        supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
        phone VARCHAR(50) UNIQUE NOT NULL
      )
    `,
    );

    // أعمدة المورد في الفواتير
    await runStartupSqlOnAllPools(
      "invoices supplier columns ready",
      `
      ALTER TABLE invoices
        ADD COLUMN IF NOT EXISTS supplier_id INTEGER REFERENCES suppliers(id),
        ADD COLUMN IF NOT EXISTS supplier_name VARCHAR(255),
        ADD COLUMN IF NOT EXISTS supplier_phone VARCHAR(50)
    `,
    );

    // عمود المورد في المنصرفات (لدفعات الموردين)
    await runStartupSqlOnAllPools(
      "cash_out supplier_id column ready",
      `
      ALTER TABLE cash_out
        ADD COLUMN IF NOT EXISTS supplier_id INTEGER REFERENCES suppliers(id)
    `,
    );
  } catch (e) {
    console.error("❌ suppliers migration error:", e.message);
  }
})();

// 📊 Database indexes for performance
(async () => {
  try {
    await runStartupSqlOnAllPools(
      "database indexes ready",
      `
      ALTER TABLE invoices
      ADD COLUMN IF NOT EXISTS invoice_source TEXT;
      ALTER TABLE invoices
      ADD COLUMN IF NOT EXISTS external_order_id TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_source_external_order
      ON invoices (invoice_source, external_order_id)
      WHERE external_order_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_invoices_type_date ON invoices (invoice_type, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices (customer_name);
      CREATE INDEX IF NOT EXISTS idx_invoices_movement ON invoices (movement_type);
      CREATE INDEX IF NOT EXISTS idx_invoices_payment ON invoices (payment_status);
      CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items (invoice_id);
      CREATE INDEX IF NOT EXISTS idx_invoice_items_product ON invoice_items (product_id);
      CREATE INDEX IF NOT EXISTS idx_stock_warehouse_product ON stock (warehouse_id, product_id);
      CREATE INDEX IF NOT EXISTS idx_stock_movements_product ON stock_movements (product_id);
      CREATE INDEX IF NOT EXISTS idx_stock_movements_warehouse ON stock_movements (warehouse_id);
      CREATE INDEX IF NOT EXISTS idx_cash_in_invoice ON cash_in (invoice_id);
      CREATE INDEX IF NOT EXISTS idx_invoices_supplier ON invoices (supplier_id);
    `,
    );
  } catch (e) {
    console.error("❌ database indexes error:", e.message);
  }
})();

function getWarehouseIdByInvoiceType(invoice_type) {
  if (invoice_type === "retail") {
    return 1; // مخزن المعرض
  }

  if (invoice_type === "wholesale") {
    return 2; // المخزن الرئيسي
  }
  if (invoice_type === "transfer") return null; // 👈 مهم
  throw new Error("invoice_type غير معروف");
}

/* ===============================
   🚀 GITHUB WEBHOOK (Auto Pull)
================================ */
app.post("/webhook/github", (req, res) => {
  const token = req.query.token;
  // If not configured, deny access
  if (!process.env.GITHUB_WEBHOOK_SECRET || token !== process.env.GITHUB_WEBHOOK_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Acknowledge request immediately
  res.json({ success: true, message: "Deployment started" });
  console.log("🚀 Webhook received: Starting Git Pull...");

  exec("git pull", (err, stdout, stderr) => {
    if (err) {
      console.error("Git Pull Error:", err);
      return;
    }
    console.log("Git Pull Output:", stdout);
    
    console.log("🔄 Exiting process to allow PM2 to auto-restart and load new code...");
    setTimeout(() => {
      process.exit(0);
    }, 1000);
  });
});

async function decrementStockOrThrow(
  client,
  { warehouseId, productId, variantId = 0, quantity, reason },
) {
  const normalizedQuantity = Number(quantity || 0);
  const normalizedVariantId = Number(variantId || 0);

  const result = await client.query(
    `
    UPDATE stock
    SET quantity = quantity - $1
    WHERE warehouse_id = $2
      AND product_id = $3
      AND variant_id = $4
      AND quantity >= $1
    `,
    [normalizedQuantity, warehouseId, productId, normalizedVariantId],
  );

  if (!result.rowCount) {
    throw new Error(
      reason ||
        `STOCK_DECREMENT_FAILED:${warehouseId}:${productId}:${normalizedVariantId}`,
    );
  }
}

async function getWholesaleWarehouseByBranch(branch_id, client = pool) {
  const res = await client.query(
    `
    SELECT id
    FROM warehouses
    WHERE branch_id = $1
    ORDER BY id DESC
    LIMIT 1
    `,
    [branch_id],
  );

  if (!res.rows.length) {
    throw new Error("لا يوجد مخزن للفرع");
  }

  return res.rows[0].id;
}

let ensureCustomersMarketColumnPromise = null;

async function ensureCustomersMarketColumn() {
  if (!ensureCustomersMarketColumnPromise) {
    ensureCustomersMarketColumnPromise = pool
      .query(
        `
        ALTER TABLE customers
        ADD COLUMN IF NOT EXISTS is_market_customer BOOLEAN DEFAULT false
        `,
      )
      .catch((error) => {
        ensureCustomersMarketColumnPromise = null;
        throw error;
      });
  }

  return ensureCustomersMarketColumnPromise;
}

async function getInvoiceItemCostSnapshot(
  productId,
  variantId,
  invoiceType,
  client = pool,
) {
  const resolvedVariantId = Number(variantId) || 0;
  const result = await client.query(
    `
    SELECT
      p.purchase_price,
      p.retail_purchase_price,
      pv.purchase_price AS variant_purchase_price,
      pv.retail_purchase_price AS variant_retail_purchase_price
    FROM products p
    LEFT JOIN product_variants pv
      ON pv.id = $2 AND pv.product_id = p.id
    WHERE p.id = $1
    LIMIT 1
    `,
    [productId, resolvedVariantId],
  );

  if (!result.rows.length) return 0;

  const row = result.rows[0];
  const productPurchasePrice = Number(row.purchase_price || 0);
  const productRetailPurchasePrice = Number(row.retail_purchase_price || 0);
  const variantPurchasePrice = Number(row.variant_purchase_price || 0);
  const variantRetailPurchasePrice = Number(
    row.variant_retail_purchase_price || 0,
  );

  if (invoiceType === "retail") {
    return (
      variantRetailPurchasePrice ||
      productRetailPurchasePrice ||
      variantPurchasePrice ||
      productPurchasePrice
    );
  }

  return (
    variantPurchasePrice ||
    productPurchasePrice ||
    variantRetailPurchasePrice ||
    productRetailPurchasePrice
  );
}

function getOnlineIntegrationApiKeyFromRequest(req) {
  const apiKeyHeader = String(req.headers["x-api-key"] || "").trim();
  if (apiKeyHeader) {
    return apiKeyHeader;
  }

  const authHeader = String(req.headers.authorization || "").trim();
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    return authHeader.slice(7).trim();
  }

  return "";
}

function secureCompareStrings(a, b) {
  const aBuffer = Buffer.from(String(a || ""));
  const bBuffer = Buffer.from(String(b || ""));

  if (aBuffer.length !== bBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(aBuffer, bBuffer);
}

function onlineIntegrationAuthMiddleware(req, res, next) {
  const expectedApiKey = String(
    process.env.ONLINE_INVOICE_API_KEY || "",
  ).trim();

  if (!expectedApiKey) {
    return res.status(500).json({
      error: "ONLINE_INVOICE_API_KEY غير مضبوط على السيرفر",
    });
  }

  const providedApiKey = getOnlineIntegrationApiKeyFromRequest(req);
  if (
    !providedApiKey ||
    !secureCompareStrings(providedApiKey, expectedApiKey)
  ) {
    return res.status(401).json({ error: "Unauthorized integration request" });
  }

  next();
}

function normalizeOnlineInvoiceSource(source) {
  const normalizedSource = String(source || "website")
    .trim()
    .toLowerCase();
  return normalizedSource || "website";
}

function getOnlineInvoiceDefaultBranchId(invoiceType) {
  const configuredBranchId = Number(process.env.ONLINE_INVOICE_BRANCH_ID || 0);
  if (configuredBranchId > 0) {
    return configuredBranchId;
  }

  return invoiceType === "wholesale" ? 2 : 1;
}

function buildOnlineInvoiceReferenceNote(notes, source, externalOrderId) {
  const referenceLine = `طلب اونلاين ${source} #${externalOrderId}`;
  const normalizedNotes = String(notes || "").trim();

  if (!normalizedNotes) {
    return referenceLine;
  }

  if (normalizedNotes.includes(referenceLine)) {
    return normalizedNotes;
  }

  return `${referenceLine}\n${normalizedNotes}`;
}

function buildOnlineInvoiceResolvedItemsSnapshot(items) {
  return items.map((item) => ({
    product_id: Number(item.product_id || 0),
    product_name: item.product_name || "",
    variant_id: Number(item.variant_id || 0),
    package: item.package || "",
    price: Number(item.price || 0),
    quantity: Number(item.quantity || 0),
    discount: Number(item.discount || 0),
    item_total: Number(item.itemTotal || 0),
    cost_price: Number(item.costPrice || 0),
    is_return: Boolean(item.itemIsReturn),
  }));
}

async function upsertOnlineInvoiceAuditRecord(
  {
    source,
    externalOrderId,
    invoiceId,
    invoiceType,
    branchId,
    movementType,
    customerName,
    customerPhone,
    paidAmount,
    previousBalance,
    requestPayload,
    resolvedItems,
    invoiceSnapshot,
    status = "created",
  },
  client,
) {
  await client.query(
    `
    INSERT INTO online_invoice_audit (
      source,
      external_order_id,
      invoice_id,
      invoice_type,
      branch_id,
      movement_type,
      customer_name,
      customer_phone,
      paid_amount,
      previous_balance,
      request_payload,
      resolved_items,
      invoice_snapshot,
      status
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13::jsonb, $14
    )
    ON CONFLICT (source, external_order_id)
    DO UPDATE SET
      invoice_id = EXCLUDED.invoice_id,
      invoice_type = EXCLUDED.invoice_type,
      branch_id = EXCLUDED.branch_id,
      movement_type = EXCLUDED.movement_type,
      customer_name = EXCLUDED.customer_name,
      customer_phone = EXCLUDED.customer_phone,
      paid_amount = EXCLUDED.paid_amount,
      previous_balance = EXCLUDED.previous_balance,
      request_payload = EXCLUDED.request_payload,
      resolved_items = EXCLUDED.resolved_items,
      invoice_snapshot = EXCLUDED.invoice_snapshot,
      status = EXCLUDED.status,
      updated_at = NOW()
    `,
    [
      source,
      externalOrderId,
      invoiceId || null,
      invoiceType,
      Number(branchId || 0) || null,
      movementType,
      customerName || null,
      customerPhone || null,
      roundMoney(paidAmount),
      roundMoney(previousBalance),
      JSON.stringify(requestPayload || {}),
      JSON.stringify(resolvedItems || []),
      JSON.stringify(invoiceSnapshot || {}),
      status,
    ],
  );
}

async function upsertOnlineInvoiceCustomer(
  customerName,
  customerPhone,
  invoiceType,
  applyItemsDiscount,
  client,
) {
  const normalizedName = String(customerName || "").trim();
  const normalizedPhone = String(customerPhone || "").trim();

  if (!normalizedName) {
    return null;
  }

  const existingCustomer = await client.query(
    `SELECT id FROM customers WHERE name = $1 LIMIT 1`,
    [normalizedName],
  );

  let customerId = existingCustomer.rows[0]?.id || null;
  if (!customerId) {
    const newCustomer = await client.query(
      `
      INSERT INTO customers (name, customer_type)
      VALUES ($1, $2)
      RETURNING id
      `,
      [normalizedName, invoiceType],
    );
    customerId = newCustomer.rows[0].id;
  }

  if (normalizedPhone) {
    await client.query(
      `
      INSERT INTO customer_phones (customer_id, phone)
      VALUES ($1, $2)
      ON CONFLICT (phone) DO NOTHING
      `,
      [customerId, normalizedPhone],
    );
  }

  await client.query(
    `UPDATE customers SET apply_items_discount = $1 WHERE id = $2`,
    [Boolean(applyItemsDiscount), customerId],
  );

  return customerId;
}

async function findCatalogItemByBarcode(code, client = pool) {
  const result = await client.query(
    `
    WITH candidates AS (
      SELECT
        0 AS priority,
        p.id AS product_id,
        0 AS variant_id,
        p.name AS product_name,
        COALESCE(p.wholesale_price, 0) AS wholesale_price,
        COALESCE(p.retail_price, 0) AS retail_price,
        COALESCE(p.discount_amount, 0) AS discount_amount,
        COALESCE(NULLIF(TRIM(p.wholesale_package), ''), '') AS wholesale_package,
        COALESCE(NULLIF(TRIM(p.retail_package), ''), '') AS retail_package
      FROM products p
      WHERE p.barcode = $1

      UNION ALL

      SELECT
        1 AS priority,
        p.id AS product_id,
        pv.id AS variant_id,
        CASE
          WHEN COALESCE(NULLIF(TRIM(pv.label), ''), '') = '' THEN p.name
          ELSE p.name || ' - ' || pv.label
        END AS product_name,
        COALESCE(pv.wholesale_price, p.wholesale_price, 0) AS wholesale_price,
        COALESCE(pv.retail_price, p.retail_price, 0) AS retail_price,
        COALESCE(pv.discount_amount, p.discount_amount, 0) AS discount_amount,
        COALESCE(NULLIF(TRIM(pv.wholesale_package), ''), COALESCE(NULLIF(TRIM(p.wholesale_package), ''), '')) AS wholesale_package,
        COALESCE(NULLIF(TRIM(pv.retail_package), ''), COALESCE(NULLIF(TRIM(p.retail_package), ''), '')) AS retail_package
      FROM product_variants pv
      JOIN products p ON p.id = pv.product_id
      WHERE pv.barcode = $1
    )
    SELECT *
    FROM candidates
    ORDER BY priority DESC
    LIMIT 1
    `,
    [code],
  );

  return result.rows[0] || null;
}

async function buildOnlineInvoiceItems(items, invoiceType, client = pool) {
  const mergedItems = new Map();

  for (const rawItem of items) {
    const code = String(rawItem?.code || rawItem?.barcode || "").trim();
    const quantity = Number(rawItem?.quantity || 0);
    const requestedPackage = normalizePackageName(rawItem?.package);

    if (!code) {
      throw new Error("كل صنف لازم يكون له code أو barcode");
    }

    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error(`الكمية غير صحيحة للصنف ${code}`);
    }

    const catalogItem = await findCatalogItemByBarcode(code, client);
    if (!catalogItem) {
      throw new Error(`الكود ${code} غير موجود في الأصناف`);
    }

    const variantId = Number(catalogItem.variant_id || 0);
    const resolvedPackage =
      requestedPackage ||
      normalizePackageName(
        invoiceType === "retail"
          ? catalogItem.retail_package
          : catalogItem.wholesale_package,
      );
    const price = roundMoney(
      invoiceType === "retail"
        ? catalogItem.retail_price
        : catalogItem.wholesale_price,
    );
    const discount = roundMoney(
      invoiceType === "retail" ? catalogItem.discount_amount || 0 : 0,
    );

    const mergeKey = [
      catalogItem.product_id,
      variantId,
      resolvedPackage,
      price,
      discount,
    ].join(":");

    if (!mergedItems.has(mergeKey)) {
      mergedItems.set(mergeKey, {
        product_id: Number(catalogItem.product_id),
        product_name: catalogItem.product_name,
        variant_id: variantId,
        package: resolvedPackage,
        price,
        quantity: 0,
        discount,
        itemIsReturn: false,
      });
    }

    const currentItem = mergedItems.get(mergeKey);
    currentItem.quantity = roundMoney(currentItem.quantity + quantity);
  }

  const normalizedItems = [];
  for (const item of mergedItems.values()) {
    normalizedItems.push({
      ...item,
      itemTotal: roundMoney((item.price - item.discount) * item.quantity),
      costPrice: await getInvoiceItemCostSnapshot(
        item.product_id,
        item.variant_id,
        invoiceType,
        client,
      ),
    });
  }

  return normalizedItems;
}

function normalizePackageName(packageName) {
  return String(packageName || "").trim();
}

async function getProductVariantPackageMeta(
  productId,
  client = pool,
  cache = new Map(),
) {
  const normalizedProductId = Number(productId || 0);
  if (!normalizedProductId) {
    return {
      validVariantIds: new Set(),
      variantPackageMap: new Map(),
      basePackages: new Set(),
    };
  }

  if (cache.has(normalizedProductId)) {
    return cache.get(normalizedProductId);
  }

  const [productResult, variantsResult] = await Promise.all([
    client.query(
      `SELECT wholesale_package, retail_package FROM products WHERE id = $1 LIMIT 1`,
      [normalizedProductId],
    ),
    client.query(
      `SELECT id, wholesale_package, retail_package FROM product_variants WHERE product_id = $1`,
      [normalizedProductId],
    ),
  ]);

  const basePackages = new Set();
  const variantPackageMap = new Map();
  const validVariantIds = new Set();

  const productRow = productResult.rows[0] || {};
  const wholesalePackage = normalizePackageName(productRow.wholesale_package);
  const retailPackage = normalizePackageName(productRow.retail_package);

  if (wholesalePackage) basePackages.add(wholesalePackage);
  if (retailPackage) basePackages.add(retailPackage);

  for (const variant of variantsResult.rows) {
    const variantId = Number(variant.id || 0);
    if (!variantId) continue;

    validVariantIds.add(variantId);

    const variantWholesalePackage = normalizePackageName(
      variant.wholesale_package,
    );
    const variantRetailPackage = normalizePackageName(variant.retail_package);

    if (variantWholesalePackage) {
      variantPackageMap.set(variantWholesalePackage, variantId);
    }
    if (variantRetailPackage) {
      variantPackageMap.set(variantRetailPackage, variantId);
    }
  }

  const meta = {
    validVariantIds,
    variantPackageMap,
    basePackages,
  };

  cache.set(normalizedProductId, meta);
  return meta;
}

async function updateRetailWeightedAverageCost(
  client,
  productId,
  addedRetailQty,
  addedTotalCost,
) {
  if (addedRetailQty <= 0) return;
  const stockRes = await client.query(
    "SELECT quantity FROM stock WHERE product_id =  AND warehouse_id = 1 AND variant_id = 0",
    [productId],
  );
  const oldQty = stockRes.rows.length ? Number(stockRes.rows[0].quantity) : 0;
  const prodRes = await client.query(
    "SELECT retail_purchase_price FROM products WHERE id = ",
    [productId],
  );
  if (!prodRes.rows.length) return;
  const oldPrice = Number(prodRes.rows[0].retail_purchase_price || 0);
  const validOldQty = oldQty > 0 ? oldQty : 0;
  const newQty = validOldQty + addedRetailQty;
  if (newQty > 0) {
    const newPrice = (validOldQty * oldPrice + Number(addedTotalCost)) / newQty;
    await client.query(
      "UPDATE products SET retail_purchase_price =  WHERE id = ",
      [newPrice, productId],
    );
  }
}

async function resolveInvoiceItemVariantId(
  item,
  invoiceType,
  client = pool,
  cache = new Map(),
) {
  // 🔥 دمج كود القطاعي: أي فاتورة قطاعي تُحفظ إجبارياً على الكود الأساسي (0)
  if (invoiceType === "retail") {
    return 0;
  }

  const incomingVariantId = Number(item?.variant_id || 0);
  const productId = Number(item?.product_id || 0);
  const packageName = normalizePackageName(item?.package);

  if (!productId) {
    return incomingVariantId > 0 ? incomingVariantId : 0;
  }

  const { validVariantIds, variantPackageMap, basePackages } =
    await getProductVariantPackageMeta(productId, client, cache);

  const matchedVariantId = packageName
    ? Number(variantPackageMap.get(packageName) || 0)
    : 0;

  if (matchedVariantId) {
    return matchedVariantId;
  }

  if (packageName && basePackages.has(packageName)) {
    return 0;
  }

  if (incomingVariantId > 0 && validVariantIds.has(incomingVariantId)) {
    return incomingVariantId;
  }

  return 0;
}

async function normalizeInvoiceItemsForStorage(
  items,
  invoiceType,
  client = pool,
) {
  const normalizedItems = [];
  const variantMetaCache = new Map();

  for (const item of items) {
    const quantity = Number(item.quantity || 0);
    const price = Number(item.price || 0);
    const discount = Number(item.discount || 0);
    const variantId = await resolveInvoiceItemVariantId(
      item,
      invoiceType,
      client,
      variantMetaCache,
    );

    normalizedItems.push({
      ...item,
      package: item.package || "",
      quantity,
      price,
      discount,
      variant_id: variantId,
      itemIsReturn: Boolean(item.is_return),
      itemTotal: price * quantity - discount * quantity,
      costPrice: await getInvoiceItemCostSnapshot(
        item.product_id,
        variantId,
        invoiceType,
        client,
      ),
    });
  }

  return normalizedItems;
}

function buildInvoiceItemStructureSnapshot(item) {
  return {
    product_id: Number(item?.product_id || 0),
    variant_id: Number(item?.variant_id || 0),
    package: normalizePackageName(item?.package),
    price: Number(item?.price || 0),
    quantity: Number(item?.quantity || 0),
    discount: Number(item?.discount || 0),
    is_return: Boolean(item?.itemIsReturn ?? item?.is_return),
  };
}

function buildInvoiceItemStockImpactSnapshot(item) {
  return {
    product_id: Number(item?.product_id || 0),
    variant_id: Number(item?.variant_id || 0),
    quantity: Number(item?.quantity || 0),
    is_return: Boolean(item?.itemIsReturn ?? item?.is_return),
  };
}

function compareInvoiceItemStructure(a, b) {
  return (
    a.product_id - b.product_id ||
    a.variant_id - b.variant_id ||
    a.package.localeCompare(b.package) ||
    a.price - b.price ||
    a.quantity - b.quantity ||
    a.discount - b.discount ||
    Number(a.is_return) - Number(b.is_return)
  );
}

function compareInvoiceItemStockImpact(a, b) {
  return (
    a.product_id - b.product_id ||
    a.variant_id - b.variant_id ||
    a.quantity - b.quantity ||
    Number(a.is_return) - Number(b.is_return)
  );
}

async function invoiceItemsHaveStructuralChanges(
  invoiceId,
  normalizedItems,
  client = pool,
) {
  const currentItemsRes = await client.query(
    `
    SELECT
      product_id,
      COALESCE(variant_id, 0) AS variant_id,
      package,
      price,
      quantity,
      discount,
      is_return
    FROM invoice_items
    WHERE invoice_id = $1
    `,
    [invoiceId],
  );

  const currentItems = currentItemsRes.rows
    .map(buildInvoiceItemStructureSnapshot)
    .sort(compareInvoiceItemStructure);

  const incomingItems = normalizedItems
    .map(buildInvoiceItemStructureSnapshot)
    .sort(compareInvoiceItemStructure);

  if (currentItems.length !== incomingItems.length) {
    return true;
  }

  for (let index = 0; index < currentItems.length; index++) {
    const currentItem = currentItems[index];
    const incomingItem = incomingItems[index];

    if (
      currentItem.product_id !== incomingItem.product_id ||
      currentItem.variant_id !== incomingItem.variant_id ||
      currentItem.package !== incomingItem.package ||
      currentItem.price !== incomingItem.price ||
      currentItem.quantity !== incomingItem.quantity ||
      currentItem.discount !== incomingItem.discount ||
      currentItem.is_return !== incomingItem.is_return
    ) {
      return true;
    }
  }

  return false;
}

async function invoiceItemsRequireStockRebuild(
  invoiceId,
  normalizedItems,
  client = pool,
) {
  const currentItemsRes = await client.query(
    `
    SELECT
      product_id,
      COALESCE(variant_id, 0) AS variant_id,
      quantity,
      is_return
    FROM invoice_items
    WHERE invoice_id = $1
    `,
    [invoiceId],
  );

  const currentItems = currentItemsRes.rows
    .map(buildInvoiceItemStockImpactSnapshot)
    .sort(compareInvoiceItemStockImpact);

  const incomingItems = normalizedItems
    .map(buildInvoiceItemStockImpactSnapshot)
    .sort(compareInvoiceItemStockImpact);

  if (currentItems.length !== incomingItems.length) {
    return true;
  }

  for (let index = 0; index < currentItems.length; index++) {
    const currentItem = currentItems[index];
    const incomingItem = incomingItems[index];

    if (
      currentItem.product_id !== incomingItem.product_id ||
      currentItem.variant_id !== incomingItem.variant_id ||
      currentItem.quantity !== incomingItem.quantity ||
      currentItem.is_return !== incomingItem.is_return
    ) {
      return true;
    }
  }

  return false;
}

function buildStockDeltaKey(productId, variantId) {
  return `${Number(productId || 0)}:${Number(variantId || 0)}`;
}

function getInvoiceItemStockEffect(item, movementType) {
  const quantity = Number(item?.quantity || 0);
  const isReturn = Boolean(item?.itemIsReturn ?? item?.is_return);

  if (movementType === "purchase") {
    return isReturn ? -quantity : quantity;
  }

  return isReturn ? quantity : -quantity;
}

async function computeInvoiceStockDeltas(
  invoiceId,
  normalizedItems,
  movementType,
  client = pool,
) {
  const currentItemsRes = await client.query(
    `
    SELECT
      product_id,
      COALESCE(variant_id, 0) AS variant_id,
      quantity,
      is_return
    FROM invoice_items
    WHERE invoice_id = $1
    `,
    [invoiceId],
  );

  const currentEffects = new Map();
  for (const item of currentItemsRes.rows) {
    const key = buildStockDeltaKey(item.product_id, item.variant_id);
    currentEffects.set(
      key,
      (currentEffects.get(key) || 0) +
        getInvoiceItemStockEffect(item, movementType),
    );
  }

  const incomingEffects = new Map();
  for (const item of normalizedItems) {
    const key = buildStockDeltaKey(item.product_id, item.variant_id);
    incomingEffects.set(
      key,
      (incomingEffects.get(key) || 0) +
        getInvoiceItemStockEffect(item, movementType),
    );
  }

  const allKeys = new Set([
    ...currentEffects.keys(),
    ...incomingEffects.keys(),
  ]);
  const deltas = [];

  for (const key of allKeys) {
    const [productId, variantId] = key.split(":").map(Number);
    const delta = Number(
      (incomingEffects.get(key) || 0) - (currentEffects.get(key) || 0),
    );

    if (!delta) continue;

    deltas.push({
      productId,
      variantId,
      delta,
    });
  }

  return deltas;
}

class InvoiceRevisionConflictError extends Error {
  constructor(currentRevision) {
    super(
      "الفاتورة تم تعديلها من شاشة أخرى. أعد تحميل الفاتورة ثم حاول مرة أخرى",
    );
    this.name = "InvoiceRevisionConflictError";
    this.currentRevision = Number(currentRevision || 0);
  }
}

function parseInvoiceRevision(value) {
  const revision = Number(value);

  if (!Number.isInteger(revision) || revision < 0) {
    throw new Error("رقم مراجعة الفاتورة غير صالح");
  }

  return revision;
}

function assertInvoiceRevisionMatches(currentRevision, incomingRevision) {
  const expectedRevision = parseInvoiceRevision(incomingRevision);
  const actualRevision = Number(currentRevision || 0);

  if (expectedRevision !== actualRevision) {
    throw new InvoiceRevisionConflictError(actualRevision);
  }

  return actualRevision;
}

app.get("/products", async (req, res) => {
  try {
    const { branch_id, invoice_type, movement_type } = req.query;

    if (!branch_id || !invoice_type || !movement_type) {
      return res.status(400).json({
        error: "branch_id و invoice_type و movement_type مطلوبين",
      });
    }

    // نجيب المخزن بتاع الفرع
    const warehouseId = getWarehouseIdByInvoiceType(invoice_type);

    // نجيب الأصناف + الرصيد + السعر حسب نوع الفاتورة
    let productsResult;

    if (movement_type === "sale") {
      // 🔹 بيع → كل الأصناف (اللي رصيدها 0 هتكون disabled في الفرونت)
      productsResult = await pool.query(
        `
     SELECT
      p.id,
      p.name,
      p.barcode,
      p.wholesale_package,
      p.retail_package,
      p.manufacturer,
      p.description,
      p.has_wholesale,
      CASE
        WHEN $1 = 'wholesale' THEN p.wholesale_price
        ELSE p.retail_price
      END AS price,
      p.wholesale_price,
      p.retail_price,
      p.discount_amount,
      COALESCE(SUM(s.quantity), 0) AS available_quantity,
      (
        SELECT json_agg(json_build_object(
          'variant_id', vs.variant_id,
          'package_name', COALESCE(pv.wholesale_package, p.wholesale_package),
          'quantity', vs.quantity,
          'price', CASE WHEN $1 = 'wholesale' THEN pv.wholesale_price ELSE pv.retail_price END
        ) ORDER BY vs.variant_id)
        FROM stock vs
        LEFT JOIN product_variants pv ON pv.id = vs.variant_id AND pv.product_id = p.id
        WHERE vs.product_id = p.id AND vs.warehouse_id = $2
      ) AS variant_stock
    FROM products p
    LEFT JOIN stock s
      ON s.product_id = p.id
      AND s.warehouse_id = $2
    WHERE p.is_active = true
    GROUP BY p.id, p.name, p.barcode, p.wholesale_package, p.retail_package,
             p.manufacturer, p.description, p.has_wholesale, p.wholesale_price, p.retail_price, p.discount_amount
    ORDER BY p.name
    `,
        [invoice_type, warehouseId],
      );
    } else {
      // 🔹 شراء → كل الأصناف حتى لو الرصيد صفر (نجمع كل الـ variants في سطر واحد)
      productsResult = await pool.query(
        `
   SELECT
      p.id,
      p.name,
      p.barcode,
      p.wholesale_package,
      p.retail_package,
      p.manufacturer,
      p.description,
      p.has_wholesale,
      CASE
        WHEN $1 = 'wholesale' THEN p.purchase_price
        ELSE p.retail_purchase_price
      END AS price,
      p.discount_amount,
     COALESCE(SUM(s.quantity), 0) AS available_quantity,
      (
        SELECT json_agg(json_build_object(
          'variant_id', vs.variant_id,
          'package_name', COALESCE(pv.wholesale_package, p.wholesale_package),
          'quantity', vs.quantity,
          'price', CASE WHEN $1 = 'wholesale' THEN pv.purchase_price ELSE pv.retail_purchase_price END
        ) ORDER BY vs.variant_id)
        FROM stock vs
        LEFT JOIN product_variants pv ON pv.id = vs.variant_id AND pv.product_id = p.id
        WHERE vs.product_id = p.id AND vs.warehouse_id = $2
      ) AS variant_stock
    FROM products p
    LEFT JOIN stock s
      ON s.product_id = p.id
      AND s.warehouse_id = $2
    WHERE p.is_active = true
    GROUP BY p.id, p.name, p.barcode, p.wholesale_package, p.retail_package,
             p.manufacturer, p.description, p.has_wholesale, p.purchase_price, p.retail_purchase_price, p.discount_amount
    ORDER BY p.name
    `,
        [invoice_type, warehouseId],
      );
    }

    res.json(productsResult.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Server error" });
  }
});

// جلب الأكواد الفرعية لمجموعة أصناف (لاستخدام الفواتير)
app.get("/products/variants", async (req, res) => {
  try {
    const { product_ids } = req.query;
    if (!product_ids) return res.json([]);

    const ids = product_ids.split(",").map(Number).filter(Boolean);
    if (ids.length === 0) return res.json([]);

    const result = await pool.query(
      `SELECT pv.*, 
              COALESCE(NULLIF(pv.retail_package, ''), p.retail_package) AS retail_package
       FROM product_variants pv
       JOIN products p ON p.id = pv.product_id
       WHERE pv.product_id = ANY($1) ORDER BY pv.product_id, pv.id`,
      [ids],
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});
// 🌐 Public API لعرض الأصناف لموقع خارجي
app.get("/public/products", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id AS product_code,
        name,
        wholesale_price,
        retail_price,
        discount_amount,
        barcode
      FROM products
      WHERE is_active = true
      ORDER BY name
    `);

    res.json(result.rows);
  } catch (err) {
    console.error("PUBLIC PRODUCTS ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// 📦 Public API — أرصدة الأصناف مع الكميات المتاحة
// GET /public/stock?branch_id=1&search=زجاج
// branch_id (اختياري): تصفية بفرع معين
// search (اختياري): بحث في اسم الصنف أو الباركود
app.get("/public/stock", async (req, res) => {
  try {
    const { branch_id, search } = req.query;
    const branchId = branch_id ? Number(branch_id) : null;
    const searchTerm = search ? `%${search}%` : null;

    const result = await pool.query(
      `
      SELECT
        p.id,
        p.name,
        p.barcode,
        p.manufacturer,
        p.wholesale_package,
        p.retail_package,
        p.wholesale_price,
        p.retail_price,
        p.description,
        COALESCE((
          SELECT SUM(s.quantity)
          FROM stock s
          JOIN warehouses w ON w.id = s.warehouse_id
          WHERE s.product_id = p.id
            AND ($1::int IS NULL OR w.branch_id = $1)
        ), 0) AS total_stock,
        (
          SELECT json_agg(json_build_object(
            'warehouse_id', sq.wid,
            'warehouse_name', sq.wname,
            'quantity', sq.qty
          ) ORDER BY sq.wid)
          FROM (
            SELECT s.warehouse_id AS wid, w.name AS wname, SUM(s.quantity) AS qty
            FROM stock s
            JOIN warehouses w ON w.id = s.warehouse_id
            WHERE s.product_id = p.id
              AND ($1::int IS NULL OR w.branch_id = $1)
            GROUP BY s.warehouse_id, w.name
          ) sq
        ) AS stock_by_warehouse,
        (
          SELECT json_agg(json_build_object(
            'id', pv.id,
            'label', pv.label,
            'barcode', pv.barcode,
            'retail_price', pv.retail_price,
            'wholesale_price', pv.wholesale_price,
            'total_stock', COALESCE((
              SELECT SUM(sv.quantity)
              FROM stock sv
              JOIN warehouses wv ON wv.id = sv.warehouse_id
              WHERE sv.product_id = p.id AND sv.variant_id = pv.id
                AND ($1::int IS NULL OR wv.branch_id = $1)
            ), 0)
          ) ORDER BY pv.id)
          FROM product_variants pv
          WHERE pv.product_id = p.id
        ) AS variants
      FROM products p
      WHERE p.is_active = true
        AND ($2::text IS NULL OR p.name ILIKE $2 OR p.barcode ILIKE $2)
      ORDER BY p.name
      `,
      [branchId, searchTerm],
    );

    res.json({
      count: result.rows.length,
      products: result.rows.map((row) => ({
        ...row,
        total_stock: Number(row.total_stock),
        variants: row.variants || [],
        stock_by_warehouse: row.stock_by_warehouse || [],
      })),
    });
  } catch (err) {
    console.error("PUBLIC STOCK ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/customers/search", async (req, res) => {
  try {
    const { name } = req.query;
    if (!name || name.length < 2) return res.json([]);

    const result = await pool.query(
      `
      SELECT DISTINCT c.id, c.name, c.apply_items_discount,
             (SELECT phone FROM customer_phones 
              WHERE customer_id = c.id 
              ORDER BY id ASC LIMIT 1) AS phone
      FROM customers c
      LEFT JOIN customer_phones cp ON cp.customer_id = c.id
      WHERE c.name ILIKE $1 OR cp.phone ILIKE $1
      ORDER BY c.name
      LIMIT 10
      `,
      [`%${name}%`],
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/customers/:id/phones", async (req, res) => {
  try {
    const { id } = req.params;
    const { phone } = req.body;

    if (!phone) return res.status(400).json({ error: "رقم الهاتف مطلوب" });

    await pool.query(
      `INSERT INTO customer_phones (customer_id, phone) VALUES ($1, $2)`,
      [id, phone],
    );

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: "الرقم مسجل بالفعل" });
  }
});

app.get("/customers/:id/phones", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, phone FROM customer_phones WHERE customer_id = $1`,
      [req.params.id],
    );

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/customers/by-phone", async (req, res) => {
  try {
    const { phone } = req.query;
    if (!phone) return res.json(null);

    const customerResult = await pool.query(
      `
      SELECT c.id, c.name, c.apply_items_discount, cp.phone
      FROM customer_phones cp
      JOIN customers c ON c.id = cp.customer_id
      WHERE cp.phone ILIKE $1
      ORDER BY cp.phone
      LIMIT 10
      `,
      [`%${phone}%`],
    );

    if (customerResult.rows.length === 0) return res.json([]);

    // Build unique customers with their phones
    const customersMap = new Map();
    for (const row of customerResult.rows) {
      if (!customersMap.has(row.id)) {
        customersMap.set(row.id, {
          id: row.id,
          name: row.name,
          phone: row.phone,
          apply_items_discount: row.apply_items_discount,
        });
      }
    }

    res.json(Array.from(customersMap.values()));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

/* =========================================================
   Customer Management Endpoints
   ========================================================= */

// List all customers with phones
app.get("/customers", async (req, res) => {
  try {
    
    const { search, market_only } = req.query;
    let query = `
      SELECT c.id, c.name, c.apply_items_discount,
             COALESCE(c.is_market_customer, false) AS is_market_customer,
             COALESCE(
               json_agg(json_build_object('id', cp.id, 'phone', cp.phone))
               FILTER (WHERE cp.id IS NOT NULL), '[]'
             ) AS phones
      FROM customers c
      LEFT JOIN customer_phones cp ON cp.customer_id = c.id
    `;
    const params = [];
    const whereClauses = [];
    if (search && search.trim().length >= 2) {
      params.push(`%${search.trim()}%`);
      const searchParamIndex = params.length;
      whereClauses.push(
        `(c.name ILIKE $${searchParamIndex} OR c.id::text ILIKE $${searchParamIndex} OR EXISTS (SELECT 1 FROM customer_phones cp2 WHERE cp2.customer_id = c.id AND cp2.phone ILIKE $${searchParamIndex}))`,
      );
    }
    if (String(market_only || "") === "1") {
      whereClauses.push(`COALESCE(c.is_market_customer, false) = true`);
    }
    if (whereClauses.length > 0) {
      query += ` WHERE ${whereClauses.join(" AND ")}`;
    }
    query += ` GROUP BY c.id ORDER BY c.name`;
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// Update customer name
app.put("/customers/:id", async (req, res) => {
  try {
    
    const { id } = req.params;
    const { name, is_market_customer } = req.body;
    const updates = [];
    const params = [];

    if (name !== undefined) {
      if (!String(name).trim()) {
        return res.status(400).json({ error: "الاسم مطلوب" });
      }
      params.push(String(name).trim());
      updates.push(`name = $${params.length}`);
    }

    if (typeof is_market_customer === "boolean") {
      params.push(is_market_customer);
      updates.push(`is_market_customer = $${params.length}`);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: "لا توجد بيانات للتحديث" });
    }

    params.push(id);
    await pool.query(
      `UPDATE customers SET ${updates.join(", ")} WHERE id = $${params.length}`,
      params,
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// Delete a phone from customer
app.delete("/customers/:id/phones/:phoneId", async (req, res) => {
  try {
    const { id, phoneId } = req.params;
    await pool.query(
      `DELETE FROM customer_phones WHERE id = $1 AND customer_id = $2`,
      [phoneId, id],
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// Delete a customer (only if no invoices reference them)
app.delete("/customers/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "معرف عميل غير صالح" });
    }

    const normalizeArabicName = (value = "") =>
      String(value)
        .trim()
        .replace(/[أإآ]/g, "ا")
        .replace(/ى/g, "ي")
        .replace(/ة/g, "ه")
        .replace(/\s+/g, " ");

    const customerRes = await pool.query(
      `SELECT id, name FROM customers WHERE id = $1 LIMIT 1`,
      [id],
    );

    if (!customerRes.rows.length) {
      return res.status(404).json({ error: "العميل غير موجود" });
    }

    const normalizedCustomerName = normalizeArabicName(
      customerRes.rows[0].name,
    );

    const linkedInvoicesRes = await pool.query(
      `SELECT id, customer_name FROM invoices WHERE customer_id = $1`,
      [id],
    );

    const staleInvoiceIds = linkedInvoicesRes.rows
      .filter(
        (inv) =>
          normalizeArabicName(inv.customer_name) !== normalizedCustomerName,
      )
      .map((inv) => inv.id);

    if (staleInvoiceIds.length > 0) {
      await pool.query(
        `UPDATE invoices SET customer_id = NULL WHERE id = ANY($1::int[])`,
        [staleInvoiceIds],
      );
    }

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM invoices WHERE customer_id = $1`,
      [id],
    );
    if (rows[0].cnt > 0) {
      return res
        .status(400)
        .json({ error: "لا يمكن حذف عميل لديه فواتير مسجلة" });
    }
    // Delete phones first, then customer
    await pool.query(`DELETE FROM customer_phones WHERE customer_id = $1`, [
      id,
    ]);
    await pool.query(`DELETE FROM customers WHERE id = $1`, [id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

/* =========================================================
   Supplier Management Endpoints (الموردين)
   ========================================================= */

// Search suppliers by name or phone
app.get("/suppliers/search", async (req, res) => {
  try {
    const { name } = req.query;
    if (!name || name.length < 2) return res.json([]);

    const result = await pool.query(
      `
      SELECT DISTINCT s.id, s.name,
             (SELECT phone FROM supplier_phones
              WHERE supplier_id = s.id
              ORDER BY id ASC LIMIT 1) AS phone
      FROM suppliers s
      LEFT JOIN supplier_phones sp ON sp.supplier_id = s.id
      WHERE s.name ILIKE $1 OR sp.phone ILIKE $1
      ORDER BY s.name
      LIMIT 10
      `,
      [`%${name}%`],
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// List all suppliers with phones
app.get("/suppliers", async (req, res) => {
  try {
    const { search } = req.query;
    let query = `
      SELECT s.id, s.name,
             COALESCE(
               json_agg(json_build_object('id', sp.id, 'phone', sp.phone))
               FILTER (WHERE sp.id IS NOT NULL), '[]'
             ) AS phones
      FROM suppliers s
      LEFT JOIN supplier_phones sp ON sp.supplier_id = s.id
    `;
    const params = [];
    if (search && search.trim().length >= 2) {
      query += ` WHERE s.name ILIKE $1 OR s.id::text = $1 OR EXISTS (SELECT 1 FROM supplier_phones sp2 WHERE sp2.supplier_id = s.id AND sp2.phone ILIKE $1)`;
      params.push(`%${search.trim()}%`);
    }
    query += ` GROUP BY s.id ORDER BY s.name`;
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// Get single supplier
app.get("/suppliers/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const supplierRes = await pool.query(
      `SELECT id, name FROM suppliers WHERE id = $1`,
      [id],
    );
    if (!supplierRes.rows.length)
      return res.status(404).json({ error: "مورد غير موجود" });

    const phonesRes = await pool.query(
      `SELECT id, phone FROM supplier_phones WHERE supplier_id = $1`,
      [id],
    );

    res.json({ ...supplierRes.rows[0], phones: phonesRes.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// Update supplier name
app.put("/suppliers/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;
    if (!name || !name.trim())
      return res.status(400).json({ error: "الاسم مطلوب" });
    await pool.query(`UPDATE suppliers SET name = $1 WHERE id = $2`, [
      name.trim(),
      id,
    ]);

    const io = req.app.get("io");
    if (io) io.emit("data:suppliers", { action: "update" });

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// Add phone to supplier
app.post("/suppliers/:id/phones", async (req, res) => {
  try {
    const { id } = req.params;
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: "رقم الهاتف مطلوب" });

    await pool.query(
      `INSERT INTO supplier_phones (supplier_id, phone) VALUES ($1, $2)`,
      [id, phone],
    );

    const io = req.app.get("io");
    if (io) io.emit("data:suppliers", { action: "update" });

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: "الرقم مسجل بالفعل" });
  }
});

// List supplier phones
app.get("/suppliers/:id/phones", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, phone FROM supplier_phones WHERE supplier_id = $1`,
      [req.params.id],
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Delete a phone from supplier
app.delete("/suppliers/:id/phones/:phoneId", async (req, res) => {
  try {
    const { id, phoneId } = req.params;
    await pool.query(
      `DELETE FROM supplier_phones WHERE id = $1 AND supplier_id = $2`,
      [phoneId, id],
    );

    const io = req.app.get("io");
    if (io) io.emit("data:suppliers", { action: "update" });

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// Get supplier balance (total debt from purchase invoices minus supplier payments)
app.get("/suppliers/:id/balance", async (req, res) => {
  try {
    const { id } = req.params;
    // إجمالي المديونية من فواتير المشتريات
    const invoiceResult = await pool.query(
      `
      SELECT COALESCE(SUM(remaining_amount), 0) AS debt
      FROM invoices
      WHERE supplier_id = $1
        AND movement_type = 'purchase'
        AND is_void IS NOT TRUE
      `,
      [id],
    );
    // إجمالي المدفوع كدفعات مورد
    const paymentResult = await pool.query(
      `
      SELECT COALESCE(SUM(amount), 0) AS paid
      FROM cash_out
      WHERE supplier_id = $1
        AND entry_type = 'supplier_payment'
      `,
      [id],
    );
    const debt = Number(invoiceResult.rows[0].debt);
    const paid = Number(paymentResult.rows[0].paid);
    res.json({ balance: debt - paid, debt, paid });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// Get supplier statement (purchase invoices + supplier payments)
app.get("/suppliers/:id/statement", async (req, res) => {
  try {
    const { id } = req.params;
    // فواتير المشتريات
    const invoicesResult = await pool.query(
      `
      SELECT id, 'invoice' AS type, invoice_type, invoice_date AS date, total AS amount,
             paid_amount, remaining_amount, payment_status, created_at
      FROM invoices
      WHERE supplier_id = $1
        AND movement_type = 'purchase'
        AND is_void IS NOT TRUE
      ORDER BY invoice_date DESC, id DESC
      `,
      [id],
    );
    // دفعات المورد
    const paymentsResult = await pool.query(
      `
      SELECT id, 'payment' AS type, permission_number,
             to_char(transaction_date, 'YYYY-MM-DD') AS date,
             amount, notes, created_at
      FROM cash_out
      WHERE supplier_id = $1
        AND entry_type = 'supplier_payment'
      ORDER BY transaction_date DESC, id DESC
      `,
      [id],
    );
    res.json({
      invoices: invoicesResult.rows,
      payments: paymentsResult.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post(
  "/integrations/online-invoices",
  onlineIntegrationAuthMiddleware,
  async (req, res) => {
    const client = await pool.connect();

    try {
      const source = normalizeOnlineInvoiceSource(req.body.source);
      const externalOrderId = String(
        req.body.externalOrderId || req.body.external_order_id || "",
      ).trim();
      const invoiceType = String(
        req.body.invoiceType || req.body.invoice_type || "",
      )
        .trim()
        .toLowerCase();
      const movementType = "sale";
      const invoiceDate = String(
        req.body.invoiceDate || req.body.invoice_date || getCairoDate(),
      ).trim();
      const branchId =
        Number(req.body.branch_id || req.body.branchId) ||
        getOnlineInvoiceDefaultBranchId(invoiceType);
      const paidAmount = roundMoney(
        req.body.paid_amount || req.body.paidAmount || 0,
      );
      const previousBalance = roundMoney(
        req.body.previous_balance || req.body.previousBalance || 0,
      );
      const customerName = String(
        req.body.customer?.name ||
          req.body.customer_name ||
          req.body.customerName ||
          "",
      ).trim();
      const customerPhone = String(
        req.body.customer?.phone ||
          req.body.customer_phone ||
          req.body.customerPhone ||
          "",
      ).trim();
      const rawItems = Array.isArray(req.body.items) ? req.body.items : [];

      if (!externalOrderId) {
        return res.status(400).json({ error: "externalOrderId مطلوب" });
      }

      if (!["retail", "wholesale"].includes(invoiceType)) {
        return res.status(400).json({
          error: "invoiceType لازم يكون retail أو wholesale",
        });
      }

      if (!customerName) {
        return res.status(400).json({ error: "اسم العميل مطلوب" });
      }

      if (!rawItems.length) {
        return res.status(400).json({ error: "لازم ترسل items" });
      }

      await client.query("BEGIN");

      const existingInvoice = await client.query(
        `
        SELECT id, invoice_type, total, paid_amount, remaining_amount
        FROM invoices
        WHERE invoice_source = $1 AND external_order_id = $2
        LIMIT 1
        `,
        [source, externalOrderId],
      );

      if (existingInvoice.rows.length > 0) {
        await client.query("ROLLBACK");
        return res.json({
          success: true,
          duplicate: true,
          invoice_id: existingInvoice.rows[0].id,
          invoice_type: existingInvoice.rows[0].invoice_type,
          total: Number(existingInvoice.rows[0].total || 0),
          paid_amount: Number(existingInvoice.rows[0].paid_amount || 0),
          remaining_amount: Number(
            existingInvoice.rows[0].remaining_amount || 0,
          ),
        });
      }

      const normalizedItems = await buildOnlineInvoiceItems(
        rawItems,
        invoiceType,
        client,
      );
      const resolvedItemsSnapshot =
        buildOnlineInvoiceResolvedItemsSnapshot(normalizedItems);

      const subtotal = roundMoney(
        normalizedItems.reduce(
          (sum, item) =>
            sum + Number(item.price || 0) * Number(item.quantity || 0),
          0,
        ),
      );
      const discountTotal = roundMoney(
        normalizedItems.reduce(
          (sum, item) =>
            sum + Number(item.discount || 0) * Number(item.quantity || 0),
          0,
        ),
      );
      const total = roundMoney(subtotal - discountTotal);
      const totalWithPrevious = roundMoney(total + previousBalance);
      const remainingAmount = roundMoney(totalWithPrevious - paidAmount);
      const paymentStatus =
        remainingAmount <= 0 ? "paid" : paidAmount > 0 ? "partial" : "unpaid";
      const invoiceNotes = buildOnlineInvoiceReferenceNote(
        req.body.notes,
        source,
        externalOrderId,
      );

      const customerId = await upsertOnlineInvoiceCustomer(
        customerName,
        customerPhone,
        invoiceType,
        false,
        client,
      );

      const invoiceRes = await client.query(
        `
        INSERT INTO invoices (
          branch_id,
          invoice_type,
          movement_type,
          invoice_date,
          customer_id,
          customer_name,
          customer_phone,
          previous_balance,
          subtotal,
          manual_discount,
          discount_total,
          total,
          paid_amount,
          remaining_amount,
          payment_status,
          apply_items_discount,
          is_return,
          created_by,
          created_by_name,
          supplier_id,
          supplier_name,
          supplier_phone,
          notes,
          invoice_source,
          external_order_id
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25
        )
        RETURNING id
        `,
        [
          branchId,
          invoiceType,
          movementType,
          invoiceDate || getCairoDate(),
          customerId,
          customerName,
          customerPhone || null,
          previousBalance,
          subtotal,
          0,
          discountTotal,
          total,
          paidAmount,
          remainingAmount,
          paymentStatus,
          invoiceType === "retail",
          false,
          null,
          "Online Integration",
          null,
          null,
          null,
          invoiceNotes,
          source,
          externalOrderId,
        ],
      );

      const invoiceId = invoiceRes.rows[0].id;
      const warehouseId = getWarehouseIdByInvoiceType(invoiceType);

      await upsertOnlineInvoiceAuditRecord(
        {
          source,
          externalOrderId,
          invoiceId,
          invoiceType,
          branchId,
          movementType,
          customerName,
          customerPhone,
          paidAmount,
          previousBalance,
          requestPayload: req.body,
          resolvedItems: resolvedItemsSnapshot,
          invoiceSnapshot: {
            invoice_id: invoiceId,
            warehouse_id: warehouseId,
            subtotal,
            discount_total: discountTotal,
            total,
            paid_amount: paidAmount,
            remaining_amount: remainingAmount,
            payment_status: paymentStatus,
            invoice_date: invoiceDate || getCairoDate(),
          },
          status: "created",
        },
        client,
      );

      if (normalizedItems.length > 0) {
        const itemValues = [];
        const itemParams = [];
        let paramIdx = 1;

        for (const item of normalizedItems) {
          itemValues.push(
            `($${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++})`,
          );
          itemParams.push(
            invoiceId,
            item.product_id,
            item.product_name,
            item.package || "",
            item.price,
            item.quantity,
            item.discount,
            item.itemTotal,
            item.variant_id || 0,
            false,
            item.costPrice,
          );
        }

        await client.query(
          `
          INSERT INTO invoice_items
            (invoice_id, product_id, product_name, package, price, quantity, discount, total, variant_id, is_return, cost_price)
          VALUES ${itemValues.join(",")}
          `,
          itemParams,
        );
      }

      for (const item of normalizedItems) {
        await decrementStockOrThrow(client, {
          warehouseId,
          productId: item.product_id,
          variantId: item.variant_id || 0,
          quantity: item.quantity,
          reason: `رصيد غير كافٍ أو الصنف غير موجود للمخزن: ${item.product_name}`,
        });

        await client.query(
          `
          INSERT INTO stock_movements
            (invoice_id, warehouse_id, product_id, variant_id, quantity, movement_type)
          VALUES ($1,$2,$3,$4,$5,'sale')
          `,
          [
            invoiceId,
            warehouseId,
            item.product_id,
            item.variant_id || 0,
            item.quantity,
          ],
        );
      }

      let journalPosted = false;
      if (invoiceType === "retail" && paidAmount > 0) {
        await client.query(
          `
          INSERT INTO cash_in
            (branch_id, invoice_id, customer_name, amount, paid_amount, remaining_amount, description, source_type, transaction_date)
          VALUES ($1, $2, $3, $4, $5, $6, $7, 'invoice', $8)
          `,
          [
            branchId,
            invoiceId,
            customerName || "عميل نقدي",
            total,
            paidAmount,
            remainingAmount,
            `فاتورة قطاعي رقم #${invoiceId}`,
            invoiceDate || getCairoDate(),
          ],
        );
        journalPosted = true;
      }

      if (
        invoiceType === "wholesale" &&
        paidAmount > 0 &&
        Number(branchId) === 2
      ) {
        await client.query(
          `
          INSERT INTO cash_in
            (branch_id, invoice_id, customer_name, amount, paid_amount, remaining_amount, description, source_type, transaction_date)
          VALUES ($1, $2, $3, $4, $5, $6, $7, 'invoice', $8)
          `,
          [
            branchId,
            invoiceId,
            customerName || "عميل نقدي",
            total,
            paidAmount,
            remainingAmount,
            `فاتورة جملة رقم #${invoiceId}`,
            invoiceDate || getCairoDate(),
          ],
        );
        journalPosted = true;
      }

      await enqueueInvoiceAggregateSync(client, invoiceId, "upsert");
      await client.query("COMMIT");

      const io = req.app.get("io");
      if (io) {
        io.emit("data:invoices", {
          action: "create",
          invoice_id: invoiceId,
          source,
        });
      }

      res.status(201).json({
        success: true,
        invoice_id: invoiceId,
        external_order_id: externalOrderId,
        invoice_type: invoiceType,
        total,
        paid_amount: paidAmount,
        remaining_amount: remainingAmount,
        journal_posted: journalPosted,
      });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("ONLINE INVOICE INTEGRATION ERROR:", err);
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  },
);

app.post("/invoices", authMiddleware, async (req, res) => {
  console.log("USER FROM TOKEN:", req.user);
  console.log(
    "📝 INVOICE CREATE - Full body:",
    JSON.stringify(req.body, null, 2),
  );
  console.log("📝 INVOICE CREATE - notes value:", req.body.notes);

  const userBranchId = req.user.branch_id;
  req.body.branch_id = 2; // Wholesale invoices always belong to the Wholesale branch (branch 2)
  const client = await pool.connect();

  try {
    if (req.body.id || req.body.invoice_id) {
      return res.status(400).json({
        error: "لا يمكن إنشاء فاتورة جديدة أثناء التعديل",
      });
    }
    const {
      branch_id,
      invoice_type, // retail | wholesale
      movement_type, // sale | purchase
      invoice_date, // 👈 لازم
      customer_name,
      customer_phone,
      previous_balance = 0,
      additional_amount = 0,
      paid_amount = 0,
      created_by,
      notes,
      items,
      apply_items_discount = false,
      manual_discount = 0,
      is_return = false,
      created_by_name,
      supplier_name,
      supplier_phone,
      force_journal_post_when_unpaid = false,
    } = req.body;
    if (invoice_type !== "wholesale") {
      return res.status(400).json({
        error: "هذا المسار مخصص لفواتير الجملة فقط",
      });
    }
    if (
      !branch_id ||
      !invoice_type ||
      !movement_type ||
      !items ||
      items.length === 0
    ) {
      return res.status(400).json({ error: "بيانات ناقصة" });
    }

    await client.query("BEGIN");

    /* ================== الحسابات ================== */
    let subtotal = 0;
    let items_discount = 0;

    for (const item of items) {
      const sign = item.is_return ? -1 : 1;
      subtotal += sign * item.price * item.quantity;
      items_discount += sign * (item.discount || 0) * item.quantity;
    }

    const extra_discount = Number(manual_discount || 0);

    const discount_total = apply_items_discount
      ? items_discount + extra_discount
      : extra_discount;

    const total = subtotal - discount_total;

    const totalWithPrevious =
      total + Number(previous_balance || 0) + Number(additional_amount || 0);

    const remaining_amount = totalWithPrevious - paid_amount;

    const payment_status =
      remaining_amount <= 0 ? "paid" : paid_amount > 0 ? "partial" : "unpaid";

    const checkExisting = await client.query(
      "SELECT id FROM invoices WHERE customer_name = $1 AND total = $2 AND paid_amount = $3 AND created_at >= NOW() - INTERVAL '5 seconds'",
      [customer_name, total, paid_amount],
    );

    if (checkExisting.rows.length) {
      throw new Error("تم منع إنشاء فاتورة مكررة");
    }

    let customerId = null;

    if (customer_name) {
      // 1️⃣ هل العميل موجود بالاسم؟
      const existingCustomer = await client.query(
        `SELECT id FROM customers WHERE name = $1 LIMIT 1`,
        [customer_name],
      );

      if (existingCustomer.rows.length > 0) {
        customerId = existingCustomer.rows[0].id;
      } else {
        // 2️⃣ إنشاء عميل جديد بدون رقم
        const newCustomer = await client.query(
          `INSERT INTO customers (name, customer_type)
       VALUES ($1, $2)
       RETURNING id`,
          [customer_name, invoice_type],
        );
        customerId = newCustomer.rows[0].id;
      }

      // 3️⃣ إضافة الرقم في جدول customer_phones لو مش موجود
      if (customer_phone) {
        await client.query(
          `
      INSERT INTO customer_phones (customer_id, phone)
      VALUES ($1, $2)
      ON CONFLICT (phone) DO NOTHING
      `,
          [customerId, customer_phone],
        );
      }

      // Update customer discount preference
      await client.query(
        `UPDATE customers SET apply_items_discount = $1 WHERE id = $2`,
        [apply_items_discount, customerId],
      );
    }

    // ===== حل المورد لفواتير الشراء =====
    let supplierId = null;
    if (movement_type === "purchase" && supplier_name) {
      const existingSupplier = await client.query(
        `SELECT id FROM suppliers WHERE name = $1 LIMIT 1`,
        [supplier_name],
      );
      if (existingSupplier.rows.length > 0) {
        supplierId = existingSupplier.rows[0].id;
      } else {
        const newSupplier = await client.query(
          `INSERT INTO suppliers (name) VALUES ($1) RETURNING id`,
          [supplier_name],
        );
        supplierId = newSupplier.rows[0].id;
      }
      if (supplier_phone) {
        await client.query(
          `INSERT INTO supplier_phones (supplier_id, phone) VALUES ($1, $2) ON CONFLICT (phone) DO NOTHING`,
          [supplierId, supplier_phone],
        );
      }
    }

    /* ================== إنشاء الفاتورة ================== */
    const invoiceRes = await client.query(
      `
     INSERT INTO invoices (
  branch_id,
  invoice_type,
  movement_type,
  invoice_date,
  customer_id,
  customer_name,
  customer_phone,
  previous_balance,
  additional_amount,
  subtotal,
  manual_discount,
  discount_total,
  total,
  paid_amount,
  remaining_amount,
  payment_status,
  apply_items_discount,
  is_return,
  created_by,
  created_by_name,
  supplier_id,
  supplier_name,
  supplier_phone,
  notes
)
VALUES
($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
      RETURNING id
      `,
      [
        branch_id,
        invoice_type,
        movement_type,
        invoice_date || getCairoDate(),
        customerId,
        customer_name,
        customer_phone,
        Number(previous_balance) || 0,
        Number(additional_amount) || 0,
        subtotal,
        extra_discount,
        discount_total,
        total,
        paid_amount,
        remaining_amount,
        payment_status,
        apply_items_discount,
        is_return,
        created_by || null,
        created_by_name || null,
        supplierId,
        supplier_name || null,
        supplier_phone || null,
        notes || null,
      ],
    );

    const invoiceId = invoiceRes.rows[0].id;
    // ✅ تسجيل العميل تلقائي لو فيه رقم

    /* ================== المخزن ================== */
    const warehouseId = getWarehouseIdByInvoiceType(invoice_type);
    const normalizedItems = await normalizeInvoiceItemsForStorage(
      items,
      invoice_type,
      client,
    );

    // 🚀 Batch INSERT for invoice_items
    if (normalizedItems.length > 0) {
      const itemValues = [];
      const itemParams = [];
      let paramIdx = 1;

      for (const item of normalizedItems) {
        const packageText = item.package || "";
        const variantId = item.variant_id || 0;

        itemValues.push(
          `($${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++})`,
        );
        itemParams.push(
          invoiceId,
          item.product_id,
          item.product_name,
          packageText,
          item.price,
          item.quantity,
          item.discount,
          item.itemTotal,
          variantId,
          item.itemIsReturn,
          item.costPrice,
        );
      }

      await client.query(
        `INSERT INTO invoice_items
          (invoice_id, product_id, product_name, package, price, quantity, discount, total, variant_id, is_return, cost_price)
         VALUES ${itemValues.join(",")}`,
        itemParams,
      );
    }

    // Stock updates per item (need conditional logic)
    for (const item of normalizedItems) {
      const variantId = item.variant_id || 0;
      const itemIsReturn = item.itemIsReturn;

      /* ===== تحديث المخزن ===== */
      if (movement_type === "purchase") {
        if (itemIsReturn) {
          // 🔴 مرتجع شراء → خصم من المخزون (إرجاع للمورد)
          await decrementStockOrThrow(client, {
            warehouseId,
            productId: item.product_id,
            variantId,
            quantity: item.quantity,
            reason: `لا يمكن تسجيل مرتجع الشراء بدون رصيد كافٍ: ${item.product_name}`,
          });
          await client.query(
            `INSERT INTO stock_movements
             (invoice_id, warehouse_id, product_id, variant_id, quantity, movement_type)
             VALUES ($1,$2,$3,$4,$5,'return_purchase')`,
            [invoiceId, warehouseId, item.product_id, variantId, item.quantity],
          );
        } else {
          // 🟢 شراء → زيادة المخزون
          await client.query(
            `
            INSERT INTO stock (warehouse_id, product_id, variant_id, quantity)
            VALUES ($1,$2,$3,$4)
            ON CONFLICT (warehouse_id, product_id, variant_id)
            DO UPDATE SET quantity = stock.quantity + $4
            `,
            [warehouseId, item.product_id, variantId, item.quantity],
          );
          await client.query(
            `INSERT INTO stock_movements
             (invoice_id, warehouse_id, product_id, variant_id, quantity, movement_type)
             VALUES ($1,$2,$3,$4,$5,'purchase')`,
            [invoiceId, warehouseId, item.product_id, variantId, item.quantity],
          );
        }
      }

      if (movement_type === "sale") {
        if (itemIsReturn) {
          // 🟢 مرتجع بيع → إضافة للمخزون (إرجاع من العميل)
          await client.query(
            `
            INSERT INTO stock (warehouse_id, product_id, variant_id, quantity)
            VALUES ($1,$2,$3,$4)
            ON CONFLICT (warehouse_id, product_id, variant_id)
            DO UPDATE SET quantity = stock.quantity + $4
            `,
            [warehouseId, item.product_id, variantId, item.quantity],
          );
          await client.query(
            `INSERT INTO stock_movements
             (invoice_id, warehouse_id, product_id, variant_id, quantity, movement_type)
             VALUES ($1,$2,$3,$4,$5,'return_sale')`,
            [invoiceId, warehouseId, item.product_id, variantId, item.quantity],
          );
        } else {
          // 🔴 بيع → خصم من المخزون
          await decrementStockOrThrow(client, {
            warehouseId,
            productId: item.product_id,
            variantId,
            quantity: item.quantity,
            reason: `رصيد غير كافٍ للبيع: ${item.product_name}`,
          });
          await client.query(
            `INSERT INTO stock_movements
             (invoice_id, warehouse_id, product_id, variant_id, quantity, movement_type)
             VALUES ($1,$2,$3,$4,$5,'sale')`,
            [invoiceId, warehouseId, item.product_id, variantId, item.quantity],
          );
        }
      }
    }

    // 🔔 إشعار للمخزن لو المعرض عمل فاتورة جملة
    const MAIN_WAREHOUSE_ID = 2;
    const SHOWROOM_BRANCH_ID = 1;

    if (invoice_type === "wholesale" && userBranchId === SHOWROOM_BRANCH_ID) {
      const title = "فاتورة جملة جديدة";

      const message = `تم إنشاء فاتورة جملة رقم #${invoiceId} للعميل ${customer_name || "عميل نقدي"}`;

      // 🗃️ تخزين في الداتابيز
      await client.query(
        `INSERT INTO notifications 
     (title, message, from_user_id, to_branch_id, type, reference_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          title,
          message,
          req.user.id,
          MAIN_WAREHOUSE_ID,
          "invoice_wholesale", // نوع الإشعار
          invoiceId, // رقم الفاتورة
        ],
      );

      // 🚀 إرسال لحظي
      const io = req.app.get("io");
      io.to(`branch_${MAIN_WAREHOUSE_ID}`).emit("new_notification", {
        title,
        message,
        type: "invoice_wholesale",
        reference_id: invoiceId,
      });

      // 📲 Push notification حتى لو الويب مقفول
      sendPushToBranch(MAIN_WAREHOUSE_ID, title, message, {
        type: "invoice_wholesale",
        invoice_id: invoiceId,
      });
    }

    // 💰 ترحيل المبالغ لليومية (cash_in) لفواتير البيع - فقط لفرع الجملة
    let journal_posted = false;
    const shouldForceJournalPostWhenUnpaid =
      movement_type === "sale" &&
      !is_return &&
      Number(branch_id) === 2 &&
      Number(paid_amount) <= 0 &&
      Boolean(force_journal_post_when_unpaid);
    if (
      movement_type === "sale" &&
      !is_return &&
      (paid_amount > 0 || shouldForceJournalPostWhenUnpaid) &&
      Number(branch_id) === 2
    ) {
      const journalDescription = shouldForceJournalPostWhenUnpaid
        ? `فاتورة جملة رقم #${invoiceId} - المتبقي ${remaining_amount}`
        : `فاتورة جملة رقم #${invoiceId}`;
      await client.query(
        `INSERT INTO cash_in 
         (branch_id, invoice_id, customer_name, amount, paid_amount, remaining_amount, description, source_type, transaction_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'invoice', $8)`,
        [
          branch_id,
          invoiceId,
          customer_name || "عميل نقدي",
          total,
          paid_amount,
          remaining_amount,
          journalDescription,
          invoice_date || getCairoDate(),
        ],
      );
      journal_posted = true;
    }

    await enqueueInvoiceAggregateSync(client, invoiceId, "upsert");

    await client.query("COMMIT");

    res.json({
      success: true,
      invoice_id: invoiceId,
      total,
      paid_amount,
      remaining_amount,
      journal_posted,
    });
  } catch (err) {
    console.error("INVOICE SAVE ERROR:", err); // 👈 مهم
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post("/invoices/retail", async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      branch_id,
      movement_type,
      invoice_date,
      customer_name,
      customer_phone,

      total_before_discount,
      items_discount = 0,
      extra_discount = 0,
      final_total,

      items,
      paid_amount = 0,
      previous_balance = 0,
      apply_items_discount = false,
      is_return = false,
    } = req.body;

    const {
      created_by,
      created_by_name,
      supplier_name,
      supplier_phone,
      notes,
      force_journal_post_when_unpaid = false,
    } = req.body;

    if (
      !branch_id ||
      !movement_type ||
      !items ||
      !items.length ||
      final_total === undefined
    ) {
      return res.status(400).json({ error: "بيانات ناقصة" });
    }

    await client.query("BEGIN");

    const totalWithPrevious =
      Math.round((Number(final_total) + Number(previous_balance || 0)) * 100) /
      100;

    const remaining_amount =
      Math.round((totalWithPrevious - Number(paid_amount || 0)) * 100) / 100;

    const payment_status =
      remaining_amount <= 0 ? "paid" : paid_amount > 0 ? "partial" : "unpaid";

    let customerId = null;

    if (customer_name) {
      const existingCustomer = await client.query(
        `SELECT id FROM customers WHERE name = $1 LIMIT 1`,
        [customer_name],
      );

      if (existingCustomer.rows.length > 0) {
        customerId = existingCustomer.rows[0].id;
      } else {
        const newCustomer = await client.query(
          `INSERT INTO customers (name, customer_type)
       VALUES ($1, 'retail')
       RETURNING id`,
          [customer_name],
        );
        customerId = newCustomer.rows[0].id;
      }

      if (customer_phone) {
        await client.query(
          `INSERT INTO customer_phones (customer_id, phone)
       VALUES ($1, $2)
       ON CONFLICT (phone) DO NOTHING`,
          [customerId, customer_phone],
        );
      }

      // Update customer discount preference
      await client.query(
        `UPDATE customers SET apply_items_discount = $1 WHERE id = $2`,
        [apply_items_discount, customerId],
      );
    }

    // ===== حل المورد لفواتير الشراء =====
    let supplierId = null;
    if (movement_type === "purchase" && supplier_name) {
      const existingSupplier = await client.query(
        `SELECT id FROM suppliers WHERE name = $1 LIMIT 1`,
        [supplier_name],
      );
      if (existingSupplier.rows.length > 0) {
        supplierId = existingSupplier.rows[0].id;
      } else {
        const newSupplier = await client.query(
          `INSERT INTO suppliers (name) VALUES ($1) RETURNING id`,
          [supplier_name],
        );
        supplierId = newSupplier.rows[0].id;
      }
      if (supplier_phone) {
        await client.query(
          `INSERT INTO supplier_phones (supplier_id, phone) VALUES ($1, $2) ON CONFLICT (phone) DO NOTHING`,
          [supplierId, supplier_phone],
        );
      }
    }

    /* ================== إنشاء الفاتورة ================== */
    const invoiceRes = await client.query(
      `
      INSERT INTO invoices (
        branch_id,
        invoice_type,
        movement_type,
        invoice_date,
        customer_id,
        customer_name,
        customer_phone,
        previous_balance,
        subtotal,
        manual_discount,  
        discount_total,
        total,
        paid_amount,
        remaining_amount,
        payment_status,
        apply_items_discount,
        is_return,
        created_by,
        created_by_name,
        supplier_id,
        supplier_name,
        supplier_phone,
        notes
      )
      VALUES
      ($1,'retail',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
      RETURNING id
      `,
      [
        branch_id,
        movement_type,
        invoice_date || getCairoDate(),
        customerId,
        customer_name,
        customer_phone,
        Number(previous_balance) || 0,
        Number(total_before_discount),
        Number(extra_discount || 0),
        Number(items_discount) + Number(extra_discount),
        Number(final_total),
        Number(paid_amount),
        remaining_amount,
        payment_status,
        apply_items_discount,
        is_return,
        created_by || null,
        created_by_name || null,
        supplierId,
        supplier_name || null,
        supplier_phone || null,
        notes || null,
      ],
    );

    const invoiceId = invoiceRes.rows[0].id;
    // ✅ تسجيل العميل تلقائي لو فيه رقم

    const warehouseId = getWarehouseIdByInvoiceType("retail");
    const normalizedItems = await normalizeInvoiceItemsForStorage(
      items,
      "retail",
      client,
    );

    /* ================== الأصناف + المخزن ================== */
    // 🚀 Batch INSERT for invoice_items
    if (normalizedItems.length > 0) {
      const itemValues = [];
      const itemParams = [];
      let paramIdx = 1;

      for (const item of normalizedItems) {
        const variantId = item.variant_id || 0;

        itemValues.push(
          `($${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++})`,
        );
        itemParams.push(
          invoiceId,
          item.product_id,
          item.product_name,
          item.package || "",
          item.price,
          item.quantity,
          item.discount,
          item.itemTotal,
          variantId,
          item.itemIsReturn,
          item.costPrice,
        );
      }

      await client.query(
        `INSERT INTO invoice_items
          (invoice_id, product_id, product_name, package, price, quantity, discount, total, variant_id, is_return, cost_price)
         VALUES ${itemValues.join(",")}`,
        itemParams,
      );
    }

    // Stock updates per item
    for (const item of normalizedItems) {
      const variantId = item.variant_id || 0;
      const itemIsReturn = item.itemIsReturn;

      if (movement_type === "sale") {
        if (itemIsReturn) {
          // 🟢 مرتجع بيع → إضافة للمخزون
          await client.query(
            `INSERT INTO stock (warehouse_id, product_id, variant_id, quantity)
             VALUES ($1,$2,$3,$4)
             ON CONFLICT (warehouse_id, product_id, variant_id)
             DO UPDATE SET quantity = stock.quantity + $4`,
            [warehouseId, item.product_id, variantId, item.quantity],
          );
        } else {
          // 🔴 بيع → خصم من المخزون
          await decrementStockOrThrow(client, {
            warehouseId,
            productId: item.product_id,
            variantId,
            quantity: item.quantity,
            reason: `رصيد غير كافٍ للبيع: ${item.product_name}`,
          });
        }
      } else {
        if (itemIsReturn) {
          // 🔴 مرتجع شراء → خصم من المخزون
          await decrementStockOrThrow(client, {
            warehouseId,
            productId: item.product_id,
            variantId,
            quantity: item.quantity,
            reason: `لا يمكن تسجيل مرتجع الشراء بدون رصيد كافٍ: ${item.product_name}`,
          });
        } else {
          // 🟢 شراء → زيادة المخزون
          await client.query(
            `INSERT INTO stock (warehouse_id, product_id, variant_id, quantity)
             VALUES ($1,$2,$3,$4)
             ON CONFLICT (warehouse_id, product_id, variant_id)
             DO UPDATE SET quantity = stock.quantity + $4`,
            [warehouseId, item.product_id, variantId, item.quantity],
          );
        }
      }

      await client.query(
        `INSERT INTO stock_movements
         (invoice_id, warehouse_id, product_id, variant_id, quantity, movement_type)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          invoiceId,
          warehouseId,
          item.product_id,
          variantId,
          item.quantity,
          itemIsReturn ? `return_${movement_type}` : movement_type,
        ],
      );
    }

    // 💰 ترحيل المبالغ لليومية (cash_in) لفواتير البيع القطاعي
    let journal_posted = false;
    const shouldForceJournalPostWhenUnpaid =
      movement_type === "sale" &&
      Number(paid_amount) <= 0 &&
      Boolean(force_journal_post_when_unpaid);
    if (
      movement_type === "sale" &&
      (Number(paid_amount) > 0 || shouldForceJournalPostWhenUnpaid)
    ) {
      const journalDescription = shouldForceJournalPostWhenUnpaid
        ? `فاتورة قطاعي رقم #${invoiceId} - المتبقي ${remaining_amount}`
        : `فاتورة قطاعي رقم #${invoiceId}`;
      await client.query(
        `INSERT INTO cash_in 
         (branch_id, invoice_id, customer_name, amount, paid_amount, remaining_amount, description, source_type, transaction_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'invoice', $8)`,
        [
          branch_id,
          invoiceId,
          customer_name || "عميل نقدي",
          Number(final_total),
          Number(paid_amount),
          remaining_amount,
          journalDescription,
          invoice_date || getCairoDate(),
        ],
      );
      journal_posted = true;
    }

    await enqueueInvoiceAggregateSync(client, invoiceId, "upsert");

    await client.query("COMMIT");

    res.json({
      success: true,
      invoice_id: invoiceId,
      total: final_total,
      remaining_amount,
      journal_posted,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.put("/invoices/retail/:id", authMiddleware, async (req, res) => {
  const client = await pool.connect();
  const invoiceId = Number(req.params.id);

  try {
    const currentUser = await requirePermission(req, res, "invoice_edit");
    if (!currentUser) return;

    await client.query("BEGIN");

    /* ================================
       0️⃣ هات بيانات الفاتورة القديمة
    ================================= */
    const invoiceRes = await client.query(
      `
      SELECT movement_type, previous_balance, COALESCE(invoice_revision, 0) AS invoice_revision
      FROM invoices
      WHERE id = $1 AND invoice_type = 'retail'
      FOR UPDATE
      `,
      [invoiceId],
    );

    if (!invoiceRes.rows.length) {
      throw new Error("فاتورة قطاعي غير موجودة");
    }

    const { movement_type, previous_balance } = invoiceRes.rows[0];
    const warehouseId = getWarehouseIdByInvoiceType("retail");

    /* ================================
       3️⃣ الداتا الجديدة
    ================================= */
    const {
      customer_name,
      customer_phone,

      total_before_discount,
      extra_discount = 0,
      final_total,

      items,
      paid_amount = 0,
      previous_balance: bodyPrevBalance,
      apply_items_discount = false,
      invoice_revision,
    } = req.body;

    const {
      updated_by,
      updated_by_name,
      supplier_name,
      supplier_phone,
      invoice_date,
      notes,
    } = req.body;

    if (!items || !items.length || final_total === undefined) {
      throw new Error("بيانات غير مكتملة");
    }

    const currentRevision = assertInvoiceRevisionMatches(
      invoiceRes.rows[0].invoice_revision,
      invoice_revision,
    );

    const normalizedItems = await normalizeInvoiceItemsForStorage(
      items,
      "retail",
      client,
    );
    const itemsChanged = await invoiceItemsHaveStructuralChanges(
      invoiceId,
      normalizedItems,
      client,
    );
    const stockDeltas = itemsChanged
      ? await computeInvoiceStockDeltas(
          invoiceId,
          normalizedItems,
          movement_type,
          client,
        )
      : [];

    const prevBalance =
      bodyPrevBalance !== undefined
        ? Number(bodyPrevBalance)
        : Number(previous_balance || 0);

    if (itemsChanged) {
      for (const entry of stockDeltas) {
        if (entry.delta > 0) {
          await client.query(
            `
            INSERT INTO stock (warehouse_id, product_id, variant_id, quantity)
            VALUES ($1,$2,$3,$4)
            ON CONFLICT (warehouse_id, product_id, variant_id)
            DO UPDATE SET quantity = stock.quantity + $4
            `,
            [warehouseId, entry.productId, entry.variantId, entry.delta],
          );
        } else {
          await decrementStockOrThrow(client, {
            warehouseId,
            productId: entry.productId,
            variantId: entry.variantId,
            quantity: Math.abs(entry.delta),
            reason: `تعذر تعديل حركة مخزون الفاتورة: ${entry.productId}`,
          });
        }
      }

      /* ================================
         2️⃣ نظافة القديم
      ================================= */
      await client.query(`DELETE FROM stock_movements WHERE invoice_id = $1`, [
        invoiceId,
      ]);

      await client.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [
        invoiceId,
      ]);

      /* ================================
         4️⃣ إضافة الأصناف الجديدة
      ================================= */
      for (const item of normalizedItems) {
        const variantId = item.variant_id || 0;
        const itemIsReturn = item.itemIsReturn;

        await client.query(
          `
          INSERT INTO invoice_items
          (
            invoice_id,
            product_id,
            product_name,
            package,
            price,
            quantity,
            discount,
            total,
            variant_id,
            is_return,
            cost_price
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
          `,
          [
            invoiceId,
            item.product_id,
            item.product_name,
            item.package,
            item.price,
            item.quantity,
            item.discount,
            item.itemTotal,
            variantId,
            itemIsReturn,
            item.costPrice,
          ],
        );

        await client.query(
          `INSERT INTO stock_movements
           (invoice_id, warehouse_id, product_id, variant_id, quantity, movement_type)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            invoiceId,
            warehouseId,
            item.product_id,
            variantId,
            item.quantity,
            itemIsReturn ? `return_${movement_type}` : movement_type,
          ],
        );
      }
    }

    /* ================================
   5️⃣ حسابات الفاتورة (موحّد مع الجملة)
================================ */
    const subtotal = Number(total_before_discount);
    const manualDiscount = Number(extra_discount || 0);
    const discountTotal = manualDiscount;
    const total = Math.round(Number(final_total) * 100) / 100;

    const totalWithPrevious =
      Math.round((total + Number(prevBalance || 0)) * 100) / 100;
    const remaining_amount =
      Math.round((totalWithPrevious - Number(paid_amount || 0)) * 100) / 100;

    const payment_status =
      remaining_amount <= 0 ? "paid" : paid_amount > 0 ? "partial" : "unpaid";

    let customerId = null;
    if (customer_name?.trim()) {
      const existingCustomer = await client.query(
        `SELECT id FROM customers WHERE name = $1 LIMIT 1`,
        [customer_name.trim()],
      );
      if (existingCustomer.rows.length > 0) {
        customerId = existingCustomer.rows[0].id;
      } else {
        const newCustomer = await client.query(
          `INSERT INTO customers (name, customer_type)
           VALUES ($1, 'retail')
           RETURNING id`,
          [customer_name.trim()],
        );
        customerId = newCustomer.rows[0].id;
      }

      if (customer_phone) {
        await client.query(
          `INSERT INTO customer_phones (customer_id, phone)
           VALUES ($1, $2)
           ON CONFLICT (phone) DO NOTHING`,
          [customerId, customer_phone],
        );
      }

      await client.query(
        `UPDATE customers SET apply_items_discount = $1 WHERE id = $2`,
        [apply_items_discount, customerId],
      );
    }

    // ===== حل المورد لفواتير الشراء =====
    let supplierId = null;
    if (movement_type === "purchase" && supplier_name) {
      const existingSupplier = await client.query(
        `SELECT id FROM suppliers WHERE name = $1 LIMIT 1`,
        [supplier_name],
      );
      if (existingSupplier.rows.length > 0) {
        supplierId = existingSupplier.rows[0].id;
      } else {
        const newSupplier = await client.query(
          `INSERT INTO suppliers (name) VALUES ($1) RETURNING id`,
          [supplier_name],
        );
        supplierId = newSupplier.rows[0].id;
      }
      if (supplier_phone) {
        await client.query(
          `INSERT INTO supplier_phones (supplier_id, phone) VALUES ($1, $2) ON CONFLICT (phone) DO NOTHING`,
          [supplierId, supplier_phone],
        );
      }
    }

    await client.query(
      `
    UPDATE invoices
SET
  customer_id = $20,
  customer_name = $1,
  customer_phone = $2,
  previous_balance = $3,
  subtotal = $4,
  manual_discount = $5,
  discount_total = $6,
  total = $7,
  paid_amount = $8,
  remaining_amount = $9,
  payment_status = $10,
  apply_items_discount = $11,
  updated_by = $12,
  updated_by_name = $13,
  supplier_id = $15,
  supplier_name = $16,
  supplier_phone = $17,
  invoice_date = COALESCE($18::date, invoice_date),
  notes = $19,
  invoice_revision = $21
WHERE id = $14
RETURNING invoice_revision
      `,
      [
        customer_name,
        customer_phone || null,
        prevBalance,
        subtotal,
        manualDiscount,
        discountTotal,
        total,
        Number(paid_amount),
        remaining_amount,
        payment_status,
        apply_items_discount,
        updated_by || null,
        updated_by_name || null,
        invoiceId,
        supplierId,
        supplier_name || null,
        supplier_phone || null,
        invoice_date || null,
        notes || null,
        customerId,
        currentRevision + 1,
      ],
    );

    /* ================================
   6️⃣ تحديث / إنشاء قيد اليومية (قطاعي)
================================ */

    if (movement_type === "sale") {
      await syncInvoiceCashEntry(client, {
        invoiceId,
        branchId: 1,
        invoiceType: "retail",
        customerId,
        customerName: customer_name,
        totalAmount: totalWithPrevious,
        paidAmount: Number(paid_amount || 0),
        remainingAmount: remaining_amount,
        transactionDate: invoice_date || null,
      });
    }

    await enqueueInvoiceAggregateSync(client, invoiceId, "upsert");

    await client.query("COMMIT");

    res.json({ success: true, invoice_revision: currentRevision + 1 });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    if (err instanceof InvoiceRevisionConflictError) {
      return res.status(409).json({
        error: err.message,
        current_revision: err.currentRevision,
      });
    }
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 📦 فواتير جملة
app.get("/invoices/wholesale", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM invoices
      WHERE invoice_type = 'wholesale'
      ORDER BY created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// 🛒 فواتير قطاعي
app.get("/invoices/retail", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM invoices
      WHERE invoice_type = 'retail'
      ORDER BY created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/invoices/:id/edit", async (req, res) => {
  const { id } = req.params;

  try {
    const invoiceRes = await pool.query(
      `SELECT * FROM invoices WHERE id = $1`,
      [id],
    );

    if (!invoiceRes.rows.length) {
      return res.status(404).json({ error: "Invoice not found" });
    }

    const invoice = invoiceRes.rows[0];

    const itemsRes = await pool.query(
      `
      SELECT
        ii.product_id,
        ii.product_name,
        ii.package,
        ii.price,
        ii.quantity,
        ii.discount,
        ii.total,
        COALESCE(ii.variant_id, 0) AS variant_id,
        ii.is_return,
        p.manufacturer
      FROM invoice_items ii
      JOIN products p ON p.id = ii.product_id
      WHERE ii.invoice_id = $1
      ORDER BY ii.id
      `,
      [id],
    );

    /* ================================
       حساب تفصيل الخصم
    ================================= */
    let items_discount = 0;
    let extra_discount = 0;

    if (invoice.invoice_type === "wholesale") {
      items_discount = itemsRes.rows.reduce(
        (sum, it) => sum + (it.discount || 0) * it.quantity,
        0,
      );

      extra_discount = Number(invoice.manual_discount || 0);
    } else {
      // القطاعي → الأرقام جاهزة
      // لو مخزّنتهم لاحقًا في أعمدة يبقوا direct
      items_discount = itemsRes.rows.reduce(
        (sum, it) => sum + (it.discount || 0) * it.quantity,
        0,
      );

      extra_discount = Number(invoice.manual_discount || 0);
    }

    res.json({
      id: invoice.id,
      invoice_type: invoice.invoice_type,
      movement_type: invoice.movement_type,
      invoice_date: invoice.invoice_date,

      customer_name: invoice.customer_name,
      customer_phone: invoice.customer_phone,

      subtotal: invoice.subtotal,

      items_discount,

      extra_discount: Number(invoice.manual_discount || 0), // ✅ السطر المهم
      manual_discount: Number(invoice.manual_discount || 0), // (اختياري لو محتاجه)

      discount_total: invoice.discount_total,
      total: invoice.total,

      paid_amount: invoice.paid_amount,
      previous_balance: invoice.previous_balance,
      additional_amount: invoice.additional_amount,
      remaining_amount: invoice.remaining_amount,
      payment_status: invoice.payment_status,
      apply_items_discount: invoice.apply_items_discount,
      is_return: invoice.is_return || false,
      invoice_revision: Number(invoice.invoice_revision || 0),
      hidden_from_list: Boolean(invoice.hidden_from_list),
      hidden_from_list_at: invoice.hidden_from_list_at || null,
      hidden_from_list_by: invoice.hidden_from_list_by || null,
      invoice_source: invoice.invoice_source || null,
      external_order_id: invoice.external_order_id || null,

      supplier_id: invoice.supplier_id,
      supplier_name: invoice.supplier_name,
      supplier_phone: invoice.supplier_phone,

      notes: invoice.notes,

      created_by: invoice.created_by,
      created_by_name: invoice.created_by_name,
      updated_by: invoice.updated_by,
      updated_by_name: invoice.updated_by_name,

      items: itemsRes.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/invoices/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const invoiceRes = await pool.query(
      "SELECT * FROM invoices WHERE id = $1",
      [id],
    );

    if (invoiceRes.rows.length === 0) {
      return res.status(404).json({ error: "Invoice not found" });
    }

    const invoice = invoiceRes.rows[0];

    // ✅ هنا
    if (invoice.invoice_type !== "wholesale") {
      return res
        .status(400)
        .json({ error: "هذا المسار مخصص لفواتير الجملة فقط" });
    }

    const itemsRes = await pool.query(
      `
  SELECT
    ii.product_id,
    ii.product_name,
    ii.package,
    ii.price,
    ii.quantity,
    ii.discount,
    ii.total,
    COALESCE(ii.variant_id, 0) AS variant_id,
    p.manufacturer
  FROM invoice_items ii
  JOIN products p ON p.id = ii.product_id
  WHERE ii.invoice_id = $1
  `,
      [id],
    );

    const total_due =
      Number(invoice.total || 0) +
      Number(invoice.previous_balance || 0) +
      Number(invoice.additional_amount || 0);

    res.json({
      ...invoice,
      manual_discount: Number(invoice.manual_discount || 0),
      total_due,
      items: itemsRes.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error" });
  }
});

app.patch("/invoices/:id/list-visibility", authMiddleware, async (req, res) => {
  const client = await pool.connect();

  try {
    const currentUser = await loadCurrentUserAccess(req);
    if (!isSuperAdmin(currentUser)) {
      return res.status(403).json({ error: "غير مصرح" });
    }

    const invoiceId = Number(req.params.id);
    if (!Number.isInteger(invoiceId) || invoiceId <= 0) {
      return res.status(400).json({ error: "رقم الفاتورة غير صحيح" });
    }

    const hideFromList = Boolean(req.body?.hidden_from_list);
    const hiddenByName =
      currentUser.full_name || currentUser.username || "Admin";

    const result = await client.query(
      `
      UPDATE invoices
      SET
        hidden_from_list = $2,
        hidden_from_list_at = CASE WHEN $2 THEN NOW() ELSE NULL END,
        hidden_from_list_by = CASE WHEN $2 THEN $3 ELSE NULL END
      WHERE id = $1
      RETURNING id, hidden_from_list, hidden_from_list_at, hidden_from_list_by
      `,
      [invoiceId, hideFromList, hiddenByName],
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "الفاتورة غير موجودة" });
    }

    const io = req.app.get("io");
    if (io) {
      io.emit("data:invoices", {
        action: "update",
        invoice_id: invoiceId,
      });
    }

    res.json({ success: true, invoice: result.rows[0] });
  } catch (err) {
    console.error("TOGGLE INVOICE LIST VISIBILITY ERROR:", err);
    res.status(500).json({ error: "فشل تحديث ظهور الفاتورة" });
  } finally {
    client.release();
  }
});

/* ================================
   تغيير اسم العميل في كل الفواتير
================================= */
app.put("/invoices/rename-customer", authMiddleware, async (req, res) => {
  const { old_name, new_name, customer_id } = req.body;
  if (!new_name?.trim()) {
    return res.status(400).json({ error: "يجب تحديد الاسم الجديد" });
  }
  if (!customer_id && !old_name?.trim()) {
    return res
      .status(400)
      .json({ error: "يجب تحديد الاسم القديم أو رقم العميل" });
  }
  try {
    let result;
    if (customer_id) {
      result = await pool.query(
        `UPDATE invoices SET customer_name = $1 WHERE customer_id = $2`,
        [new_name.trim(), Number(customer_id)],
      );
    } else {
      result = await pool.query(
        `UPDATE invoices SET customer_name = $1 WHERE customer_name = $2`,
        [new_name.trim(), old_name.trim()],
      );
    }
    res.json({
      updated: result.rowCount,
      message: `تم تحديث الاسم في ${result.rowCount} فاتورة`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "فشل تحديث الاسم في الفواتير" });
  }
});

app.put("/invoices/:id", authMiddleware, async (req, res) => {
  const client = await pool.connect();
  const invoiceId = Number(req.params.id);

  try {
    const currentUser = await requirePermission(req, res, "invoice_edit");
    if (!currentUser) return;

    await client.query("BEGIN");

    /* ================================
       0️⃣ هات بيانات الفاتورة
    ================================= */
    const invoiceRes = await client.query(
      `
      SELECT invoice_type, movement_type, COALESCE(invoice_revision, 0) AS invoice_revision
      FROM invoices
      WHERE id = $1
      FOR UPDATE
      `,
      [invoiceId],
    );

    if (!invoiceRes.rows.length) {
      throw new Error("فاتورة غير موجودة");
    }

    const invoice = invoiceRes.rows[0];

    // ✅ هنا
    if (invoice.invoice_type !== "wholesale") {
      throw new Error("هذا المسار مخصص لتعديل فواتير الجملة فقط");
    }

    const { invoice_type, movement_type } = invoiceRes.rows[0];
    const warehouseId = getWarehouseIdByInvoiceType(invoice_type);

    /* ================================
       فك بيانات البودي (بدون حذف أي حاجة)
    ================================= */
    const {
      items,
      customer_name,
      customer_phone,
      previous_balance = 0,
      additional_amount = 0,
      paid_amount = 0,
      apply_items_discount = false,
      manual_discount = 0,
      invoice_revision,
    } = req.body;

    const {
      updated_by,
      updated_by_name,
      supplier_name,
      supplier_phone,
      invoice_date,
      notes,
    } = req.body;
    if (!items || !items.length) {
      throw new Error("لا يوجد أصناف في الفاتورة");
    }

    const currentRevision = assertInvoiceRevisionMatches(
      invoice.invoice_revision,
      invoice_revision,
    );

    const normalizedItems = await normalizeInvoiceItemsForStorage(
      items,
      invoice_type,
      client,
    );
    const itemsChanged = await invoiceItemsHaveStructuralChanges(
      invoiceId,
      normalizedItems,
      client,
    );
    const stockDeltas = itemsChanged
      ? await computeInvoiceStockDeltas(
          invoiceId,
          normalizedItems,
          movement_type,
          client,
        )
      : [];

    if (itemsChanged) {
      for (const entry of stockDeltas) {
        if (entry.delta > 0) {
          await client.query(
            `
            INSERT INTO stock (warehouse_id, product_id, variant_id, quantity)
            VALUES ($1,$2,$3,$4)
            ON CONFLICT (warehouse_id, product_id, variant_id)
            DO UPDATE SET quantity = stock.quantity + $4
            `,
            [warehouseId, entry.productId, entry.variantId, entry.delta],
          );
        } else {
          await decrementStockOrThrow(client, {
            warehouseId,
            productId: entry.productId,
            variantId: entry.variantId,
            quantity: Math.abs(entry.delta),
            reason: `تعذر تعديل حركة مخزون الفاتورة: ${entry.productId}`,
          });
        }
      }

      /* ================================
         2️⃣ امسح الحركات القديمة
      ================================= */
      await client.query(`DELETE FROM stock_movements WHERE invoice_id = $1`, [
        invoiceId,
      ]);

      await client.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [
        invoiceId,
      ]);

      for (const item of normalizedItems) {
        const variantId = item.variant_id || 0;
        const itemIsReturn = item.itemIsReturn;

        await client.query(
          `
          INSERT INTO invoice_items
          (
            invoice_id,
            product_id,
            product_name,
            package,
            price,
            quantity,
            discount,
            total,
            variant_id,
            is_return,
            cost_price
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
          `,
          [
            invoiceId,
            item.product_id,
            item.product_name,
            item.package,
            item.price,
            item.quantity,
            item.discount,
            item.itemTotal,
            variantId,
            itemIsReturn,
            item.costPrice,
          ],
        );

        await client.query(
          `INSERT INTO stock_movements
           (invoice_id, warehouse_id, product_id, variant_id, quantity, movement_type)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            invoiceId,
            warehouseId,
            item.product_id,
            variantId,
            item.quantity,
            itemIsReturn ? `return_${movement_type}` : movement_type,
          ],
        );
      }
    }

    /* ================================
       5️⃣ حسابات الفاتورة
    ================================= */
    let subtotal = 0;
    let itemsDiscount = 0;

    for (const item of items) {
      const sign = item.is_return ? -1 : 1;
      subtotal += sign * item.price * item.quantity;
      itemsDiscount += sign * (item.discount || 0) * item.quantity;
    }

    const extraDiscount = Number(manual_discount || 0);

    const discountTotal = apply_items_discount
      ? itemsDiscount + extraDiscount
      : extraDiscount;

    const total = subtotal - discountTotal;
    const totalWithPrevious =
      total + Number(previous_balance || 0) + Number(additional_amount || 0);
    const remaining = totalWithPrevious - Number(paid_amount || 0);

    const payment_status =
      remaining <= 0 ? "paid" : paid_amount > 0 ? "partial" : "unpaid";

    let customerId = null;
    if (customer_name?.trim()) {
      const existingCustomer = await client.query(
        `SELECT id FROM customers WHERE name = $1 LIMIT 1`,
        [customer_name.trim()],
      );
      if (existingCustomer.rows.length > 0) {
        customerId = existingCustomer.rows[0].id;
      } else {
        const newCustomer = await client.query(
          `INSERT INTO customers (name, customer_type)
           VALUES ($1, $2)
           RETURNING id`,
          [customer_name.trim(), invoice_type],
        );
        customerId = newCustomer.rows[0].id;
      }

      if (customer_phone) {
        await client.query(
          `INSERT INTO customer_phones (customer_id, phone)
           VALUES ($1, $2)
           ON CONFLICT (phone) DO NOTHING`,
          [customerId, customer_phone],
        );
      }

      await client.query(
        `UPDATE customers SET apply_items_discount = $1 WHERE id = $2`,
        [apply_items_discount, customerId],
      );
    }

    /* ================================
       6️⃣ حل المورد لفواتير الشراء
    ================================= */
    let supplierId = null;
    if (movement_type === "purchase" && supplier_name) {
      const existingSupplier = await client.query(
        `SELECT id FROM suppliers WHERE name = $1 LIMIT 1`,
        [supplier_name],
      );
      if (existingSupplier.rows.length > 0) {
        supplierId = existingSupplier.rows[0].id;
      } else {
        const newSupplier = await client.query(
          `INSERT INTO suppliers (name) VALUES ($1) RETURNING id`,
          [supplier_name],
        );
        supplierId = newSupplier.rows[0].id;
      }
      if (supplier_phone) {
        await client.query(
          `INSERT INTO supplier_phones (supplier_id, phone) VALUES ($1, $2) ON CONFLICT (phone) DO NOTHING`,
          [supplierId, supplier_phone],
        );
      }
    }

    /* ================================
       7️⃣ تحديث الفاتورة
    ================================= */
    const updatedInvoiceRes = await client.query(
      `
 UPDATE invoices
SET
  customer_id = $21,
  customer_name = $1,
  customer_phone = $2,
  previous_balance = $3,
    additional_amount = $4,
    subtotal = $5,
    manual_discount = $6,
    discount_total = $7,
    total = $8,
    paid_amount = $9,
    remaining_amount = $10,
    payment_status = $11,
    apply_items_discount = $12,
    updated_by = $13,
    updated_by_name = $14,
    supplier_id = $16,
    supplier_name = $17,
    supplier_phone = $18,
    invoice_date = COALESCE($19::date, invoice_date),
      notes = $20,
      invoice_revision = $22
  WHERE id = $15
      RETURNING invoice_revision
  `,
      [
        customer_name,
        customer_phone || null,
        Number(previous_balance || 0),
        Number(additional_amount || 0),
        subtotal,
        extraDiscount,
        discountTotal,
        total,
        Number(paid_amount || 0),
        remaining,
        payment_status,
        apply_items_discount,
        updated_by || null,
        updated_by_name || null,
        invoiceId,
        supplierId,
        supplier_name || null,
        supplier_phone || null,
        invoice_date || null,
        notes || null,
        customerId,
        currentRevision + 1,
      ],
    );

    /* ================================
   7️⃣ تحديث / إنشاء قيد اليومية
================================ */

    if (movement_type === "sale") {
      await syncInvoiceCashEntry(client, {
        invoiceId,
        branchId: 2,
        invoiceType: invoice_type,
        customerId,
        customerName: customer_name,
        totalAmount: totalWithPrevious,
        paidAmount: Number(paid_amount || 0),
        remainingAmount: remaining,
        transactionDate: invoice_date || null,
      });
    }

    await enqueueInvoiceAggregateSync(client, invoiceId, "upsert");

    await client.query("COMMIT");
    res.json({
      success: true,
      invoice_id: invoiceId,
      invoice_revision: Number(
        updatedInvoiceRes.rows[0]?.invoice_revision || 0,
      ),
      remaining,
      payment_status,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("UPDATE INVOICE ERROR:", err);
    if (err instanceof InvoiceRevisionConflictError) {
      return res.status(409).json({
        error: err.message,
        current_revision: err.currentRevision,
      });
    }
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get("/invoices/:id/pdf", async (req, res) => {
  const invoiceId = req.params.id;

  try {
    /* =========================
       1) جلب البيانات (زي ما هي)
    ========================= */
    const invoiceRes = await pool.query(
      `SELECT * FROM invoices WHERE id = $1`,
      [invoiceId],
    );

    if (!invoiceRes.rows.length) {
      return res.status(404).send("Invoice not found");
    }

    const itemsRes = await pool.query(
      `
      SELECT
        ii.*,
        p.manufacturer
      FROM invoice_items ii
      LEFT JOIN products p ON p.id = ii.product_id
      WHERE ii.invoice_id = $1
      ORDER BY ii.id
      `,
      [invoiceId],
    );

    const invoice = invoiceRes.rows[0];
    const items = itemsRes.rows;

    /* =========================
       2) الحسابات (من غير أي تغيير)
    ========================= */
    const calcUnitPrice = (it) =>
      invoice.apply_items_discount
        ? Number(it.price) - Number(it.discount || 0)
        : Number(it.price);

    const calcItemTotal = (it) => calcUnitPrice(it) * Number(it.quantity || 0);

    const itemsSubtotal = items.reduce((sum, it) => sum + calcItemTotal(it), 0);

    const totalQty = items.reduce(
      (sum, it) => sum + Number(it.quantity || 0),
      0,
    );

    const previousBalance = Number(invoice.previous_balance) || 0;
    const additionalAmount = Number(invoice.additional_amount) || 0;
    const paidAmount = Number(invoice.paid_amount) || 0;
    const extraDiscount = Number(invoice.manual_discount) || 0;

    const totalWithPrevious =
      itemsSubtotal + previousBalance + additionalAmount;
    const netTotal = totalWithPrevious - extraDiscount;
    const remaining = netTotal - paidAmount;

    /* =========================
       3) HTML (RTL حقيقي)
    ========================= */
    const html = `
<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8" />
<style>
  body {
    font-family: 'Cairo', sans-serif;
    font-size: 14px;
    direction: rtl;
  }
  h2 {
    text-align: center;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 10px;
  }
  th, td {
    border-bottom: 1px solid #000;
    padding: 4px;
    text-align: center;
    white-space: nowrap;
  }
  th.name, td.name {
    text-align: right;
  }
  .summary {
    margin-top: 15px;
    text-align: left;
  }
</style>
</head>
<body>

<h2>فاتورة</h2>

<div>
  <div>رقم الفاتورة: ${invoice.id}</div>
  <div>التاريخ: ${new Date(invoice.created_at).toLocaleDateString("ar-EG")}</div>
  <div>العميل: ${invoice.customer_name || ""}</div>
  ${invoice.customer_phone ? `<div>تليفون: ${invoice.customer_phone}</div>` : ""}
</div>

<table>
<thead>
<tr>
  <th>م</th>
  <th class="name">الصنف</th>
  <th>العبوة</th>
  <th>الكمية</th>
  <th>السعر</th>
  <th>الإجمالي</th>
</tr>
</thead>
<tbody>
${items
  .map((it, i) => {
    const productName = [it.product_name, it.manufacturer]
      .filter(Boolean)
      .join(" ");
    const packText = it.package
      ? it.package.replace(/كرتونة\s*/g, "").trim()
      : "-";

    return `
<tr>
  <td>${i + 1}</td>
  <td class="name">${productName}</td>
  <td>${packText}</td>
  <td>${it.quantity}</td>
  <td>${calcUnitPrice(it).toFixed(2)}</td>
  <td>${calcItemTotal(it).toFixed(2)}</td>
</tr>
`;
  })
  .join("")}
</tbody>
</table>

<div class="summary">
  <div>إجمالي الكمية: ${totalQty}</div>
  <div>الإجمالي: ${itemsSubtotal.toFixed(2)}</div>
  ${previousBalance ? `<div>حساب سابق: ${previousBalance.toFixed(2)}</div>` : ""}
  ${additionalAmount ? `<div>إضافة: ${additionalAmount.toFixed(2)}</div>` : ""}
  ${extraDiscount ? `<div>خصم: ${extraDiscount.toFixed(2)}</div>` : ""}
  <div><strong>الصافي: ${netTotal.toFixed(2)}</strong></div>
  ${paidAmount ? `<div>المدفوع: ${paidAmount.toFixed(2)}</div>` : ""}
  ${remaining ? `<div><strong>المتبقي: ${remaining.toFixed(2)}</strong></div>` : ""}
</div>

</body>
</html>
`;

    /* =========================
       4) Puppeteer → PDF
    ========================= */
    const browser = await launchPuppeteer();

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });

    const pdfBuffer = await page.pdf({
      format: "A5",
      printBackground: true,
    });

    await browser.close();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename=invoice-${invoiceId}.pdf`,
    );

    res.send(pdfBuffer);
  } catch (err) {
    console.error("PUPPETEER ERROR >>>", err);
    res.status(500).send(err.message);
  }
});

// Universal PDF Export Proxy
app.post("/api/pdf-export", async (req, res) => {
  const { url, token, userStr } = req.body;
  if (!url) return res.status(400).send("URL is required");

  let browser;
  try {
    browser = await launchPuppeteer();

    const page = await browser.newPage();
    
    // Set localStorage data on localhost:3000 domain before navigating to the actual print page
    await page.goto("http://localhost:3000/offline"); 
    await page.evaluate((t, u) => {
      if (t) localStorage.setItem("token", t);
      if (u) localStorage.setItem("user", u);
    }, token, userStr);

    const fullUrl = `http://localhost:3000${url}`;
    await page.goto(fullUrl, { waitUntil: "networkidle0", timeout: 30000 });
    
    // Wait for the #print-ready element to ensure the data is loaded
    await page.waitForSelector("#print-ready", { timeout: 15000 });

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: '0', bottom: '0', left: '0', right: '0' },
    });

    await browser.close();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=report.pdf`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error("PDF EXPORT ERROR >>>", err);
    if (browser) await browser.close();
    res.status(500).send(err.message);
  }
});

// Endpoint لطباعة الفاتورة كصفحة HTML (المتصفح هو اللي بيطبع / يحفظ PDF)
app.get("/invoices/:id/print", async (req, res) => {
  const invoiceId = req.params.id;

  try {
    const invoiceRes = await pool.query(
      `SELECT * FROM invoices WHERE id = $1`,
      [invoiceId],
    );

    if (!invoiceRes.rows.length) {
      return res.status(404).send("Invoice not found");
    }

    const itemsRes = await pool.query(
      `
      SELECT ii.*, p.manufacturer
      FROM invoice_items ii
      LEFT JOIN products p ON p.id = ii.product_id
      WHERE ii.invoice_id = $1
      ORDER BY ii.id
      `,
      [invoiceId],
    );

    const invoice = invoiceRes.rows[0];
    const items = itemsRes.rows;

    const unitPrice = (it) =>
      invoice.apply_items_discount
        ? Number(it.price) - Number(it.discount || 0)
        : Number(it.price);

    const itemTotal = (it) => unitPrice(it) * Number(it.quantity || 0);

    const subtotal = items.reduce((s, it) => s + itemTotal(it), 0);
    const totalQty = items.reduce((s, it) => s + Number(it.quantity || 0), 0);

    const previousBalance = Number(invoice.previous_balance) || 0;
    const additionalAmount = Number(invoice.additional_amount) || 0;
    const discount = Number(invoice.manual_discount) || 0;
    const paid = Number(invoice.paid_amount) || 0;

    const netTotal = subtotal + previousBalance + additionalAmount - discount;
    const remaining = netTotal - paid;

    const rowsHtml = items
      .map((it, i) => {
        const pack = it.package
          ? it.package.replace(/كرتونة\s*/g, "").trim()
          : "";

        const name = `
          ${it.product_name}
          ${it.manufacturer ? " - " + it.manufacturer : ""}
          ${pack ? " (" + pack + ")" : ""}
          ${it.is_return ? ' <span style="color:red;font-weight:bold">(مرتجع)</span>' : ""}
        `;

        return `
<tr>
  <td>${i + 1}</td>
  <td class="name">${name}</td>
  <td>${it.quantity}</td>
  <td>${unitPrice(it).toFixed(2)}</td>
  <td>${itemTotal(it).toFixed(2)}</td>
</tr>`;
      })
      .join("");

    res.send(`
<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">

<style>
@page {
 size: A5 portrait; 
 margin: 10mm; 
 
 }
 html, body { 
 width: 125mm;
  height: 190mm;
   }

body {
  font-family: Cairo, Arial, sans-serif;
  font-size: 14px;
  margin: 0;
  color: #000;
}

.header {
  display: flex;
  justify-content: space-between;
}

.logo img { width: 75px; }

.hr-bold {
  border-top: 2px solid #000;
  margin: 6px 0;
}

table {
  width: 100%;
  border-collapse: collapse;
}

th, td {
  padding: 6px;
  text-align: center;
}

th {
  border-bottom: 2px solid #000;
}

tbody tr:not(.total-row):not(.summary-row) td {
  border-bottom: 1px solid #000;
}

.total-row td {
  font-weight: bold;
}

/* ===== NEW SUMMARY BOX STYLE (الجديد الحقيقي) ===== */

.summary-row td {
  padding: 6px 6px;
  vertical-align: middle;
}

.summary-box-start td {
  border-top: 2px solid #000;
  padding-top: 10px;
}

/* اسم البند */
.summary-label {
  text-align: right;
  font-weight: 600;
  padding-right: 8px;
}

/* الرقم */
.summary-value {
  text-align: left;          /* كل الأرقام شمال */
  font-weight: 600;
  width: 80px;               /* عمود ثابت */
}

/* الصافي */
.total-net .summary-label,
.total-net .summary-value {
  font-size: 15px;
  font-weight: 700;
}

/* الباقي */
.remaining .summary-label,
.remaining .summary-value {
  font-size: 16px;
  font-weight: 800;
}

/* خلفية خفيفة */
.summary-row {
  background: #f7f7f7;
}

@media print {
  body { margin: 0; }
}
</style>
</head>

<body>

<div class="header">
  <div>
    <div><strong>رقم الفاتورة:</strong> ${invoice.id}</div>
    <div><strong>التاريخ:</strong> ${new Date(invoice.created_at).toLocaleDateString("ar-EG")}</div>
    <div><strong>العميل:</strong> ${invoice.customer_name || "نقدي"}</div>
    ${
      invoice.customer_phone
        ? `<div><strong>تليفون:</strong> ${invoice.customer_phone}</div>`
        : ""
    }

  </div>
  <div class="logo"><img src="/assets/logo.png"></div>
</div>

<div class="hr-bold"></div>

<table>
<thead>
<tr>
<th>م</th><th>الصنف</th><th>الكمية</th><th>السعر</th><th>الإجمالي</th>
</tr>
</thead>

<tbody>
${rowsHtml}

<tr class="total-row">
<td></td><td></td><td>${totalQty}</td><td></td><td>${subtotal.toFixed(2)}</td>
</tr>

${
  previousBalance
    ? `
<tr class="summary-row summary-box-start">
<td colspan="3"></td>
<td class="summary-label">حساب سابق</td>
<td class="summary-value">${previousBalance.toFixed(2)}</td>
</tr>`
    : ""
}

<tr class="summary-row total-net">
<td colspan="3"></td>
<td class="summary-label">الصافي</td>
<td class="summary-value">${netTotal.toFixed(2)}</td>
</tr>

${
  paid
    ? `
<tr class="summary-row">
<td colspan="3"></td>
<td class="summary-label">المدفوع</td>
<td class="summary-value">${paid.toFixed(2)}</td>
</tr>`
    : ""
}

${
  remaining && remaining !== netTotal
    ? `
<tr class="summary-row remaining">
<td colspan="3"></td>
<td class="summary-label">الباقي</td>
<td class="summary-value">${remaining.toFixed(2)}</td>
</tr>`
    : ""
}


</tbody>
</table>

<script>
window.onload = () => window.print();
</script>

</body>
</html>
`);
  } catch (err) {
    console.error(err);
    res.status(500).send("Print failed");
  }
});

app.get("/customers/:id/last-balance", async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `
      SELECT remaining_amount
      FROM invoices
      WHERE customer_id = $1
        AND is_void = false
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [id],
    );

    const lastRemaining = result.rows.length
      ? Number(result.rows[0].remaining_amount)
      : 0;

    // طرح سندات الدفع بعد آخر فاتورة
    const customerRes = await pool.query(
      `SELECT name FROM customers WHERE id = $1`,
      [id],
    );
    const customerName = customerRes.rows[0]?.name;

    let totalPayments = 0;
    if (customerName) {
      const paymentsRes = await pool.query(
        `
        SELECT COALESCE(SUM(amount), 0) AS total_payments
        FROM cash_in
        WHERE source_type = 'customer_payment'
          AND customer_name = $1
          AND created_at > (
            SELECT COALESCE(MAX(created_at), '1970-01-01')
            FROM invoices
            WHERE customer_id = $2
              AND is_void = false
          )
        `,
        [customerName, id],
      );
      totalPayments = Number(paymentsRes.rows[0].total_payments);
    }

    res.json({
      previous_balance: Math.max(0, lastRemaining - totalPayments),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error" });
  }
});

app.get("/customers/:id/balance", authMiddleware, async (req, res) => {
  try {
    const customerId = req.params.id;
    const { invoice_type } = req.query;
    const branch_id = req.user.branch_id;

    if (!invoice_type) {
      return res.status(400).json({ error: "invoice_type مطلوب" });
    }

    // remaining_amount من آخر فاتورة
    const result = await pool.query(
      `
      SELECT remaining_amount
      FROM invoices
      WHERE customer_id = $1
        AND branch_id = $2
        AND invoice_type = $3
        AND is_void = false
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [customerId, branch_id, invoice_type],
    );

    const lastRemaining = result.rows.length
      ? Number(result.rows[0].remaining_amount)
      : 0;

    // طرح سندات الدفع بعد آخر فاتورة
    const customerRes = await pool.query(
      `SELECT name FROM customers WHERE id = $1`,
      [customerId],
    );
    const customerName = customerRes.rows[0]?.name;

    let totalPayments = 0;
    if (customerName) {
      const paymentsRes = await pool.query(
        `
        SELECT COALESCE(SUM(amount), 0) AS total_payments
        FROM cash_in
        WHERE source_type = 'customer_payment'
          AND customer_name = $1
          AND branch_id = $2
          AND created_at > (
            SELECT COALESCE(MAX(created_at), '1970-01-01')
            FROM invoices
            WHERE customer_id = $3
              AND branch_id = $2
              AND invoice_type = $4
              AND is_void = false
          )
        `,
        [customerName, branch_id, customerId, invoice_type],
      );
      totalPayments = Number(paymentsRes.rows[0].total_payments);
    }

    res.json({
      balance: Math.max(0, lastRemaining - totalPayments),
    });
  } catch (err) {
    console.error("GET CUSTOMER BALANCE ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/invoices", async (req, res) => {
  try {
    const {
      branch_id,
      invoice_type,
      movement_type,
      customer_name,
      customer_phone,
      customer_id,
      is_return,
      invoice_id,
      invoice_source,
      external_order_id,
      online_only,
      list_visibility,
      date_from,
      date_to,
      limit = 50,
      offset = 0,
    } = req.query;

    let conditions = [];
    let values = [];
    let idx = 1;

    const normalizedListVisibility = String(list_visibility || "visible")
      .trim()
      .toLowerCase();

    if (normalizedListVisibility === "hidden") {
      const currentUser = await loadCurrentUserAccess(req);
      if (!isSuperAdmin(currentUser)) {
        return res.status(403).json({ error: "غير مصرح" });
      }
      conditions.push(`COALESCE(hidden_from_list, false) = true`);
    } else if (normalizedListVisibility === "all") {
      const currentUser = await loadCurrentUserAccess(req);
      if (!isSuperAdmin(currentUser)) {
        return res.status(403).json({ error: "غير مصرح" });
      }
    } else {
      conditions.push(`COALESCE(hidden_from_list, false) = false`);
    }

    if (invoice_id) {
      conditions.push(`id = $${idx++}`);
      values.push(Number(invoice_id));
    }

    if (online_only === "true") {
      conditions.push(`invoice_source IS NOT NULL`);
    }

    if (branch_id) {
      conditions.push(`branch_id = $${idx++}`);
      values.push(branch_id);
    }

    if (invoice_type) {
      conditions.push(`invoice_type = $${idx++}`);
      values.push(invoice_type);
    }

    if (movement_type) {
      conditions.push(`movement_type = $${idx++}`);
      values.push(movement_type);
    }

    if (is_return !== undefined) {
      conditions.push(`is_return = $${idx++}`);
      values.push(is_return === "true");
    }

    if (customer_name) {
      conditions.push(
        `(customer_name ILIKE $${idx} OR supplier_name ILIKE $${idx} OR customer_phone ILIKE $${idx} OR supplier_phone ILIKE $${idx})`,
      );
      values.push(`%${customer_name}%`);
      idx++;
    }

    if (customer_phone) {
      conditions.push(
        `(customer_phone ILIKE $${idx} OR supplier_phone ILIKE $${idx})`,
      );
      values.push(`%${customer_phone}%`);
      idx++;
    }

    if (customer_id) {
      conditions.push(`customer_id = $${idx++}`);
      values.push(Number(customer_id));
    }

    if (invoice_source) {
      conditions.push(`invoice_source = $${idx++}`);
      values.push(String(invoice_source).trim().toLowerCase());
    }

    if (external_order_id) {
      conditions.push(`external_order_id ILIKE $${idx++}`);
      values.push(`%${external_order_id}%`);
    }

    if (date_from) {
      conditions.push(`COALESCE(invoice_date, created_at) >= $${idx++}`);
      values.push(date_from);
    }

    if (date_to) {
      conditions.push(
        `COALESCE(invoice_date, created_at) < ($${idx++}::date + INTERVAL '1 day')`,
      );
      values.push(date_to);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const result = await pool.query(
      `
      SELECT
        id,
        invoice_type,
        movement_type,
        is_return,
        customer_name,
        customer_phone,
        supplier_name,
        supplier_phone,
        subtotal,
        discount_total,
        total,
        previous_balance,
        additional_amount,
        paid_amount,
        remaining_amount,
        payment_status,
        invoice_date,
        created_at,
        created_by,
        created_by_name,
        updated_by,
        updated_by_name,
        hidden_from_list,
        hidden_from_list_at,
        hidden_from_list_by,
        invoice_source,
        external_order_id,
        notes
      FROM invoices
      ${whereClause}
      ORDER BY id DESC
      LIMIT $${idx++} OFFSET $${idx++}
      `,
      [...values, limit, offset],
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error" });
  }
});

/* ================================
   تصفير الأصناف السالبة - Zero out negative stock
================================ */
app.post("/invoices/zero-negative-stock", authMiddleware, async (req, res) => {
  const client = await pool.connect();
  const userBranchId = req.user.branch_id;
  const userId = req.user.id;
  const userName = req.user.full_name || req.user.username || "System";
  const BATCH_SIZE = 50;

  try {
    const { warehouse_id } = req.body;
    if (!warehouse_id) {
      return res.status(400).json({ error: "warehouse_id مطلوب" });
    }

    // 1. Get all negative stock items for this warehouse
    const negResult = await client.query(
      `SELECT
        sm.product_id,
        sm.variant_id,
        COALESCE(SUM(sm.quantity), 0) AS current_stock,
        p.name AS product_name,
        p.barcode
      FROM stock_movements sm
      JOIN products p ON p.id = sm.product_id
      WHERE sm.warehouse_id = $1 AND p.is_active = true
      GROUP BY sm.product_id, sm.variant_id, p.name, p.barcode
      HAVING COALESCE(SUM(sm.quantity), 0) < 0
      ORDER BY COALESCE(SUM(sm.quantity), 0) ASC`,
      [warehouse_id],
    );

    if (negResult.rows.length === 0) {
      return res.json({
        success: true,
        message: "لا توجد أصناف سالبة",
        invoices_created: 0,
        items_count: 0,
      });
    }

    const negItems = negResult.rows;
    const invoiceType = warehouse_id == 1 ? "retail" : "wholesale";
    const today = new Date().toISOString().split("T")[0];

    // Split into batches of BATCH_SIZE
    const batches = [];
    for (let i = 0; i < negItems.length; i += BATCH_SIZE) {
      batches.push(negItems.slice(i, i + BATCH_SIZE));
    }

    const invoiceIds = [];

    await client.query("BEGIN");

    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b];

      // Create invoice for this batch
      const invResult = await client.query(
        `INSERT INTO invoices
          (branch_id, invoice_type, movement_type, invoice_date,
           customer_name, subtotal, manual_discount, discount_total, total,
           paid_amount, remaining_amount, payment_status,
           created_by, created_by_name, is_return, apply_items_discount)
         VALUES ($1, $2, 'purchase', $3,
           'تصفير الاصناف السالبة', 0, 0, 0, 0,
           0, 0, 'paid',
           $4, $5, false, false)
         RETURNING id`,
        [userBranchId, invoiceType, today, userId, userName],
      );

      const invoiceId = invResult.rows[0].id;
      invoiceIds.push(invoiceId);

      // Insert items for this batch
      for (const item of batch) {
        const adjustQty = Math.abs(Number(item.current_stock));
        const variantId = Number(item.variant_id) || 0;

        await client.query(
          `INSERT INTO invoice_items
            (invoice_id, product_id, product_name, variant_id, quantity, price, discount, total)
           VALUES ($1, $2, $3, $4, $5, 0, 0, 0)`,
          [invoiceId, item.product_id, item.product_name, variantId, adjustQty],
        );

        await client.query(
          `INSERT INTO stock (warehouse_id, product_id, variant_id, quantity)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (warehouse_id, product_id, variant_id)
           DO UPDATE SET quantity = stock.quantity + $4`,
          [warehouse_id, item.product_id, variantId, adjustQty],
        );

        await client.query(
          `INSERT INTO stock_movements
            (invoice_id, warehouse_id, product_id, variant_id, quantity, movement_type)
           VALUES ($1, $2, $3, $4, $5, 'purchase')`,
          [invoiceId, warehouse_id, item.product_id, variantId, adjustQty],
        );
      }
    }

    await client.query("COMMIT");

    // Broadcast stock change
    const io = req.app.get("io");
    if (io) {
      io.to(`branch_${userBranchId}`).emit("data_changed", {
        type: "data:stock",
      });
      io.to(`branch_${userBranchId}`).emit("data_changed", {
        type: "data:invoices",
      });
    }

    res.json({
      success: true,
      message: `تم تصفير ${negItems.length} صنف سالب في ${batches.length} فاتورة`,
      invoice_ids: invoiceIds,
      invoices_created: batches.length,
      items_count: negItems.length,
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("ZERO NEGATIVE STOCK ERROR:", err);
    res.status(500).json({ error: err.message || "فشل تصفير الأصناف السالبة" });
  } finally {
    client.release();
  }
});

// ========== Reconcile Stock ==========
app.post("/stock/reconcile", authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Recalculate stock from stock_movements
    const result = await client.query(`
      UPDATE stock s
      SET quantity = COALESCE(sm_sum.total, 0)
      FROM (
        SELECT warehouse_id, product_id, variant_id, SUM(quantity) AS total
        FROM stock_movements
        GROUP BY warehouse_id, product_id, variant_id
      ) sm_sum
      WHERE s.warehouse_id = sm_sum.warehouse_id
        AND s.product_id = sm_sum.product_id
        AND COALESCE(s.variant_id, 0) = COALESCE(sm_sum.variant_id, 0)
        AND s.quantity != COALESCE(sm_sum.total, 0)
    `);

    await client.query("COMMIT");

    const io = req.app.get("io");
    const userBranchId = req.user.branch_id;
    if (io) {
      io.to(`branch_${userBranchId}`).emit("data_changed", {
        type: "data:stock",
      });
    }

    res.json({
      success: true,
      fixed_count: result.rowCount,
      message: `تم تصحيح ${result.rowCount} صنف`,
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("RECONCILE ERROR:", err);
    res.status(500).json({ error: err.message || "فشل تصحيح الأرصدة" });
  } finally {
    client.release();
  }
});

// ========== Dashboard Stats ==========
app.get("/dashboard/stats", async (req, res) => {
  try {
    const { invoice_type } = req.query;
    if (!invoice_type)
      return res.status(400).json({ error: "invoice_type مطلوب" });

    const cacheKey = `dashboard_stats_${invoice_type}`;
    const cached = _cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < 30000) return res.json(cached.data);

    const warehouseId = invoice_type === "retail" ? 1 : 2;

    // Run queries in parallel
    const [
      salesToday,
      cashToday,
      lowStockCount,
      negativeStockCount,
      todayProfitSummary,
      interBranchProfitSummary,
    ] = await Promise.all([
      // Today's sales total
      pool.query(
        `SELECT COALESCE(SUM(total), 0) AS total_sales, COUNT(*) AS count
         FROM invoices
         WHERE invoice_type = $1
           AND movement_type = 'sale'
           AND is_return = false
           AND created_at >= CURRENT_DATE
           AND created_at < CURRENT_DATE + INTERVAL '1 day'`,
        [invoice_type],
      ),
      // Today's cash collected
      pool.query(
        `SELECT COALESCE(SUM(paid_amount), 0) AS total_cash
         FROM invoices
         WHERE invoice_type = $1
           AND created_at >= CURRENT_DATE
           AND created_at < CURRENT_DATE + INTERVAL '1 day'`,
        [invoice_type],
      ),
      // Low stock count (quantity <= 5)
      pool.query(
        `SELECT COUNT(DISTINCT product_id) AS count
         FROM stock
         WHERE warehouse_id = $1 AND quantity <= 5 AND quantity > 0`,
        [warehouseId],
      ),
      // Negative stock count — calculated from stock_movements
      pool.query(
        `SELECT COUNT(*) AS count FROM (
            SELECT sm.product_id
            FROM stock_movements sm
            JOIN products p ON p.id = sm.product_id
            WHERE sm.warehouse_id = $1 AND p.is_active = true
            GROUP BY sm.product_id, sm.variant_id
            HAVING SUM(sm.quantity) < 0
          ) neg`,
        [warehouseId],
      ),
      // Today's profit percentage using the same logic as the invoice profit report (Proportional Distribution)
      pool.query(
        `WITH invoice_scope AS (
           SELECT 
             i.id AS invoice_id, 
             i.branch_id, 
             i.invoice_type, 
             COALESCE(i.invoice_date::date, i.created_at::date) AS invoice_date, 
             COALESCE(i.total, 0) AS invoice_total,
             COALESCE(i.apply_items_discount, true) AS apply_items_discount
           FROM invoices i
           WHERE i.invoice_type = $1
             AND i.movement_type = 'sale'
             AND i.is_void IS NOT TRUE
             AND COALESCE(i.invoice_date::date, i.created_at::date) = CURRENT_DATE
         ),
         invoice_items_scoped AS (
           SELECT
             ii.invoice_id,
             ii.quantity, ii.price, ii.discount, ii.total, ii.is_return, ii.cost_price,
             inv.branch_id, inv.invoice_type, inv.invoice_date, inv.invoice_total, inv.apply_items_discount,
             p.purchase_price, p.retail_purchase_price,
             CASE
               WHEN COALESCE(inv.apply_items_discount, true) = false THEN
                 CASE WHEN COALESCE(ii.is_return, false) THEN -(COALESCE(ii.quantity, 0) * COALESCE(ii.price, 0))
                 ELSE (COALESCE(ii.quantity, 0) * COALESCE(ii.price, 0)) END
               ELSE
                 CASE WHEN COALESCE(ii.is_return, false)
                   THEN -COALESCE(ii.total, COALESCE(ii.quantity, 0) * (COALESCE(ii.price, 0) - COALESCE(ii.discount, 0)))
                 ELSE COALESCE(ii.total, COALESCE(ii.quantity, 0) * (COALESCE(ii.price, 0) - COALESCE(ii.discount, 0))) END
             END AS signed_item_total,
             SUM(
               CASE
                 WHEN COALESCE(inv.apply_items_discount, true) = false THEN
                   CASE WHEN COALESCE(ii.is_return, false) THEN -(COALESCE(ii.quantity, 0) * COALESCE(ii.price, 0))
                   ELSE (COALESCE(ii.quantity, 0) * COALESCE(ii.price, 0)) END
                 ELSE
                   CASE WHEN COALESCE(ii.is_return, false)
                     THEN -COALESCE(ii.total, COALESCE(ii.quantity, 0) * (COALESCE(ii.price, 0) - COALESCE(ii.discount, 0)))
                   ELSE COALESCE(ii.total, COALESCE(ii.quantity, 0) * (COALESCE(ii.price, 0) - COALESCE(ii.discount, 0))) END
               END
             ) OVER (PARTITION BY ii.invoice_id) AS invoice_items_total
           FROM invoice_scope inv
           JOIN invoice_items ii ON ii.invoice_id = inv.invoice_id
           JOIN products p ON p.id = ii.product_id
         )
         SELECT
           COALESCE(SUM(
             CASE
               WHEN iis.invoice_items_total = 0 THEN iis.signed_item_total
               ELSE iis.signed_item_total - ((iis.invoice_items_total - iis.invoice_total) * (iis.signed_item_total / iis.invoice_items_total))
             END
           ), 0) AS sales_total,
           COALESCE(SUM(
             CASE WHEN COALESCE(iis.is_return, false) THEN 0
             ELSE COALESCE(iis.quantity, 0) * COALESCE(iis.cost_price, CASE WHEN iis.invoice_type = 'retail' THEN COALESCE(iis.retail_purchase_price, iis.purchase_price, 0) ELSE COALESCE(iis.purchase_price, 0) END) END
           ), 0) AS total_cost
         FROM invoice_items_scoped iis`,
        [invoice_type],
      ),
      // Today's inter-branch outbound profit
      pool.query(
        `SELECT COALESCE(SUM(total_value), 0) AS total_sales,
                COALESCE(SUM(total_cost), 0) AS total_cost
         FROM inter_branch_transfers
         WHERE direction = 'outbound'
           AND status IN ('in_transit', 'received')
           AND created_at >= CURRENT_DATE
           AND created_at < CURRENT_DATE + INTERVAL '1 day'`
      ).catch(() => ({ rows: [{ total_sales: 0, total_cost: 0 }] })),
    ]);

    const todaySalesTotal = Number(todayProfitSummary.rows[0].sales_total || 0) + Number(interBranchProfitSummary.rows[0].total_sales || 0);
    const todayTotalCost = Number(todayProfitSummary.rows[0].total_cost || 0) + Number(interBranchProfitSummary.rows[0].total_cost || 0);
    const todayNetProfit = todaySalesTotal - todayTotalCost;
    const todayProfitPercentage =
      todaySalesTotal > 0 ? (todayNetProfit / todaySalesTotal) * 100 : 0;

    const statsResult = {
      today_sales: Number(salesToday.rows[0].total_sales),
      today_invoices_count: Number(salesToday.rows[0].count),
      today_cash: Number(cashToday.rows[0].total_cash),
      low_stock_count: Number(lowStockCount.rows[0].count),
      negative_stock_count: Number(negativeStockCount.rows[0].count),
      today_profit_percentage: todayProfitPercentage,
    };
    _cache.set(cacheKey, { data: statsResult, ts: Date.now() });
    res.json(statsResult);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error" });
  }
});

app.delete("/invoices/:id", authMiddleware, async (req, res) => {
  const client = await pool.connect();
  const invoiceId = Number(req.params.id);

  try {
    const currentUser = await requirePermission(req, res, "invoice_delete");
    if (!currentUser) return;

    await client.query("BEGIN");

    // 0️⃣ مسح قيد اليومية المرتبط بالفاتورة (لو موجود)
    const cashDeleted = await client.query(
      `DELETE FROM cash_in WHERE invoice_id = $1 RETURNING id`,
      [invoiceId],
    );
    if (cashDeleted.rowCount > 0) {
      console.log(
        `🗑️ تم مسح قيد يومية مرتبط بالفاتورة ${invoiceId} (cash_in id: ${cashDeleted.rows.map((r) => r.id).join(", ")})`,
      );
    }

    // 1️⃣ هات الحركات
    const movementsRes = await client.query(
      `
      SELECT warehouse_id, product_id, quantity, movement_type, COALESCE(variant_id, 0) AS variant_id
      FROM stock_movements
      WHERE invoice_id = $1
      FOR UPDATE
    `,
      [invoiceId],
    );

    // 2️⃣ عكس الحركة (مرة واحدة فقط ✅)
    for (const m of movementsRes.rows) {
      if (m.movement_type === "purchase" || m.movement_type === "return_sale") {
        // كان فيه زيادة → نعكسها بخصم
        await decrementStockOrThrow(client, {
          warehouseId: m.warehouse_id,
          productId: m.product_id,
          variantId: m.variant_id,
          quantity: m.quantity,
          reason: `تعذر حذف الفاتورة بسبب عدم تطابق رصيد المخزون: ${m.product_id}`,
        });
      } else if (
        m.movement_type === "sale" ||
        m.movement_type === "return_purchase"
      ) {
        // كان فيه خصم → نعكسه بإضافة
        await client.query(
          `
          UPDATE stock
          SET quantity = quantity + $1
          WHERE warehouse_id = $2 AND product_id = $3 AND variant_id = $4
        `,
          [m.quantity, m.warehouse_id, m.product_id, m.variant_id],
        );
      }
    }

    // 3️⃣ مسح الحركات
    await client.query(`DELETE FROM stock_movements WHERE invoice_id = $1`, [
      invoiceId,
    ]);

    // 4️⃣ مسح الأصناف
    await client.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [
      invoiceId,
    ]);

    // 5️⃣ مسح الفاتورة
    await client.query(`DELETE FROM invoices WHERE id = $1`, [invoiceId]);

    await enqueueInvoiceAggregateSync(client, invoiceId, "delete");

    await client.query("COMMIT");
    res.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ===== إدارة الأصناف =====

// جلب كل الأصناف (للإدارة)
app.get("/admin/products", async (req, res) => {
  try {
    const { search, manufacturer, limit = 0, offset = 0, active } = req.query;

    let conditions = [];
    let values = [];
    let idx = 1;

    // active filter: "true" = active only, "false" = inactive only, "all" = everything
    // When searching, search ALL products regardless of active filter
    if (!search) {
      if (active === "false") {
        conditions.push(`p.is_active = false`);
      } else if (active !== "all") {
        // Default: active only (when not searching)
        conditions.push(`p.is_active = true`);
      }
    }

    if (search) {
      conditions.push(
        `(p.name ILIKE $${idx} OR p.barcode ILIKE $${idx} OR p.description ILIKE $${idx})`,
      );
      values.push(`%${search}%`);
      idx++;
    }

    if (manufacturer && manufacturer !== "الكل") {
      conditions.push(`p.manufacturer = $${idx++}`);
      values.push(manufacturer);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limitClause =
      Number(limit) > 0 ? `LIMIT $${idx++} OFFSET $${idx++}` : "";
    if (Number(limit) > 0) {
      values.push(Number(limit), Number(offset));
    }

    const result = await pool.query(
      `SELECT 
  p.id,
  p.name,
  p.wholesale_package,
  p.retail_package,
  p.manufacturer,
  p.purchase_price,
  p.purchase_price_adjustment,
  p.purchase_price_adjustment_is_percentage,
  p.retail_purchase_price,
  p.wholesale_price,
  p.retail_price,
  p.barcode,
  p.discount_amount,
  p.description,
  p.is_active,
  p.has_wholesale,
  COALESCE(v.variant_count, 0) AS variant_count
FROM products p
LEFT JOIN (
  SELECT product_id, COUNT(*) AS variant_count
  FROM product_variants
  GROUP BY product_id
) v ON v.product_id = p.id
${whereClause}
ORDER BY p.name
${limitClause}`,
      values,
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

console.log("TRANSFER ROUTE LOADED");

// ==================== رصيد أول المدة ====================

// التحقق من أكواد الأصناف قبل الاستيراد
app.post("/admin/opening-stock/validate", async (req, res) => {
  try {
    const { codes } = req.body;
    if (!codes || !codes.length) {
      return res.status(400).json({ error: "لا توجد أكواد" });
    }

    const allProducts = await pool.query(
      `SELECT id, name, barcode FROM products WHERE is_active = true`,
    );
    const barcodeMap = new Map();
    allProducts.rows.forEach((p) => {
      if (p.barcode) barcodeMap.set(p.barcode.trim(), p);
    });

    const matched = [];
    const unmatched = [];

    for (const code of codes) {
      const trimmed = String(code).trim();
      if (!trimmed) continue;
      const product = barcodeMap.get(trimmed);
      if (product) {
        matched.push({
          code: trimmed,
          product_id: product.id,
          product_name: product.name,
        });
      } else {
        unmatched.push(trimmed);
      }
    }

    res.json({ matched, unmatched, total: codes.length });
  } catch (err) {
    console.error("Validate codes error:", err);
    res.status(500).json({ error: "فشل التحقق: " + err.message });
  }
});

app.post("/admin/opening-stock", async (req, res) => {
  const client = await pool.connect();
  try {
    const { items, branch_id = 1, invoice_date } = req.body;

    if (!items || !items.length) {
      return res.status(400).json({ error: "لا توجد أصناف" });
    }

    await client.query("BEGIN");

    // 1. جلب كل الأصناف من قاعدة البيانات بالباركود
    const allProducts = await client.query(
      `SELECT id, name, barcode, retail_package, wholesale_package, retail_purchase_price FROM products WHERE is_active = true`,
    );
    const barcodeMap = new Map();
    allProducts.rows.forEach((p) => {
      if (p.barcode) barcodeMap.set(p.barcode.trim(), p);
    });

    // 1.5 جلب كل العبوات الفرعية (variants) لربط الـ package بـ variant_id
    const allVariants = await client.query(
      `SELECT id, product_id, wholesale_package, retail_package FROM product_variants`,
    );
    // بناء خريطة: product_id + package_name -> variant_id
    const variantMap = new Map();
    allVariants.rows.forEach((v) => {
      if (v.wholesale_package) {
        variantMap.set(`${v.product_id}_${v.wholesale_package.trim()}`, v.id);
      }
      if (v.retail_package) {
        variantMap.set(`${v.product_id}_${v.retail_package.trim()}`, v.id);
      }
    });

    // 2. مطابقة الأصناف
    const matchedItems = [];
    const unmatchedItems = [];

    for (const item of items) {
      const code = String(item.product_code).trim();
      const product = barcodeMap.get(code);
      if (product) {
        const pkg = item.unit || product.retail_package || "";

        // 🔥 دمج كود القطاعي: رصيد أول مدة قطاعي يُحفظ إجبارياً على الكود الأساسي (0)
        const variantId = 0;

        matchedItems.push({
          product_id: product.id,
          product_name: product.name,
          package: pkg,
          price: Number(item.price) || 0,
          quantity: Number(item.quantity) || 0,
          barcode: code,
          variant_id: variantId,
        });
      } else {
        unmatchedItems.push({
          product_code: code,
          product_name: item.product_name,
        });
      }
    }

    if (matchedItems.length === 0) {
      await client.query("ROLLBACK");
      return res
        .status(400)
        .json({ error: "لم يتم مطابقة أي صنف", unmatched: unmatchedItems });
    }

    // 3. حساب الإجمالي
    let subtotal = 0;
    for (const item of matchedItems) {
      subtotal += item.price * item.quantity;
    }

    // 4. إنشاء فاتورة شراء
    const invoiceRes = await client.query(
      `INSERT INTO invoices (
        branch_id, invoice_type, movement_type, invoice_date,
        customer_name, subtotal, manual_discount, discount_total,
        total, paid_amount, remaining_amount, payment_status,
        apply_items_discount, is_return
      ) VALUES ($1, 'retail', 'purchase', $2,
        'رصيد أول المدة', $3, 0, 0,
        $3, $3, 0, 'paid',
        false, false)
      RETURNING id`,
      [branch_id, invoice_date || getCairoDate(), subtotal],
    );

    const invoiceId = invoiceRes.rows[0].id;
    const warehouseId = 1; // مخزن المعرض (retail)

    // 5. إضافة الأصناف + تحديث المخزون
    for (const item of matchedItems) {
      const itemTotal = item.price * item.quantity;
      const variantId = item.variant_id || 0;

      // إضافة للفاتورة
      await client.query(
        `INSERT INTO invoice_items
         (invoice_id, product_id, product_name, package, price, quantity, discount, total, variant_id, is_return)
         VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8, false)`,
        [
          invoiceId,
          item.product_id,
          item.product_name,
          item.package,
          item.price,
          item.quantity,
          itemTotal,
          variantId,
        ],
      );

      // تحديث المخزون (شراء = زيادة)
      await client.query(
        `INSERT INTO stock (warehouse_id, product_id, variant_id, quantity)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (warehouse_id, product_id, variant_id)
         DO UPDATE SET quantity = stock.quantity + $4`,
        [warehouseId, item.product_id, variantId, item.quantity],
      );

      // تسجيل حركة المخزون
      await client.query(
        `INSERT INTO stock_movements
         (invoice_id, warehouse_id, product_id, variant_id, quantity, movement_type)
         VALUES ($1, $2, $3, $4, $5, 'purchase')`,
        [invoiceId, warehouseId, item.product_id, variantId, item.quantity],
      );
    }

    await client.query("COMMIT");

    res.json({
      success: true,
      invoice_id: invoiceId,
      matched: matchedItems.length,
      unmatched: unmatchedItems.length,
      unmatched_items: unmatchedItems,
      total: subtotal,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Opening stock error:", err);
    res.status(500).json({ error: "فشل إنشاء رصيد أول المدة: " + err.message });
  } finally {
    client.release();
  }
});

// مسح جميع الأصناف
app.delete("/admin/products/all", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM product_variants");
    await client.query(
      "DELETE FROM stock_movements WHERE product_id IN (SELECT id FROM products)",
    );
    await client.query(
      "DELETE FROM invoice_items WHERE product_id IN (SELECT id FROM products)",
    );
    await client.query(
      "DELETE FROM stock WHERE product_id IN (SELECT id FROM products)",
    );
    await client.query("DELETE FROM products");
    await client.query("COMMIT");
    res.json({ message: "تم مسح جميع الأصناف بنجاح" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "فشل مسح الأصناف", message: err.message });
  } finally {
    client.release();
  }
});

// جلب صنف واحد بالتفصيل
app.get("/admin/products/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query("SELECT * FROM products WHERE id = $1", [
      id,
    ]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "الصنف غير موجود" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "خطأ في السيرفر" });
  }
});

// مسح صنف واحد
app.delete("/admin/products/:id", async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM product_variants WHERE product_id = $1", [
      id,
    ]);
    await client.query("DELETE FROM stock_movements WHERE product_id = $1", [
      id,
    ]);
    await client.query("DELETE FROM invoice_items WHERE product_id = $1", [id]);
    await client.query("DELETE FROM stock WHERE product_id = $1", [id]);
    const result = await client.query(
      "DELETE FROM products WHERE id = $1 RETURNING id",
      [id],
    );
    if (result.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "الصنف غير موجود" });
    }
    await client.query("COMMIT");
    res.json({ message: "تم مسح الصنف بنجاح" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "فشل مسح الصنف", message: err.message });
  } finally {
    client.release();
  }
});

// إضافة صنف جديد
app.post("/admin/products", async (req, res) => {
  try {
    const {
      name,
      wholesale_package,
      retail_package,
      manufacturer,
      purchase_price,
      purchase_price_adjustment = 0,
      purchase_price_adjustment_is_percentage = false,
      retail_purchase_price,
      wholesale_price,
      retail_price,
      barcode,
      discount_amount = 0,
      description = "",
      has_wholesale = true,
    } = req.body;
    const nameNormalized = normalizeNumbers(name);
    const wholesalePackageNormalized = normalizeNumbers(
      wholesale_package || "",
    );
    const retailPackageNormalized = normalizeNumbers(retail_package);

    if (
      !name ||
      !retail_package ||
      retail_purchase_price === undefined ||
      retail_price === undefined
    ) {
      return res.status(400).json({ error: "بيانات ناقصة" });
    }

    const insertRes = await pool.query(
      `
      INSERT INTO products
(
  name,
  wholesale_package,
  retail_package,
  manufacturer,
  retail_purchase_price,
  barcode,
  purchase_price,
  purchase_price_adjustment,
  purchase_price_adjustment_is_percentage,
  wholesale_price,
  retail_price,
  discount_amount,
  description,
  has_wholesale
)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
RETURNING *

      `,
      [
        nameNormalized,
        wholesalePackageNormalized,
        retailPackageNormalized,
        manufacturer,
        retail_purchase_price,
        barcode || null,
        purchase_price || 0,
        purchase_price_adjustment || 0,
        Boolean(purchase_price_adjustment_is_percentage),
        wholesale_price || 0,
        retail_price,
        discount_amount,
        description || "",
        has_wholesale,
      ],
    );

    let product = insertRes.rows[0];

    // 2️⃣ لو مفيش باركود → ولّد
    if (!product.barcode) {
      const generatedBarcode = `900000${product.id}`;

      const updateRes = await pool.query(
        `
        UPDATE products
        SET barcode = $1
        WHERE id = $2
        RETURNING *
        `,
        [generatedBarcode, product.id],
      );

      product = updateRes.rows[0];
    }

    res.json(product);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// تعديل صنف
app.put("/admin/products/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name,
      wholesale_package,
      retail_package,
      manufacturer,
      barcode,
      purchase_price,
      purchase_price_adjustment = 0,
      purchase_price_adjustment_is_percentage = false,
      retail_purchase_price,
      wholesale_price,
      retail_price,
      discount_amount = 0,
      description = "",
      has_wholesale = true,
    } = req.body;
    const nameNormalized = normalizeNumbers(name);
    const wholesalePackageNormalized = normalizeNumbers(
      wholesale_package || "",
    );
    const retailPackageNormalized = normalizeNumbers(retail_package);

    if (
      !name ||
      !retail_package ||
      retail_purchase_price === undefined ||
      retail_price === undefined
    ) {
      return res.status(400).json({ error: "بيانات ناقصة" });
    }

    const result = await pool.query(
      `
      UPDATE products
SET
  name = $1,
  wholesale_package = $2,
  retail_package = $3,
  manufacturer = $4,
  barcode = $5,
  purchase_price = $6,
  purchase_price_adjustment = $7,
  purchase_price_adjustment_is_percentage = $8,
  retail_purchase_price = $9,
  wholesale_price = $10,
  retail_price = $11,
  discount_amount = $12,
  description = $13,
  has_wholesale = $14
WHERE id = $15
RETURNING *
      `,
      [
        nameNormalized,
        wholesalePackageNormalized,
        retailPackageNormalized,
        manufacturer,
        barcode || null,
        purchase_price || 0,
        purchase_price_adjustment || 0,
        Boolean(purchase_price_adjustment_is_percentage),
        retail_purchase_price,
        wholesale_price || 0,
        retail_price,
        discount_amount,
        description || "",
        has_wholesale,
        id,
      ],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "الصنف غير موجود" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// تفعيل / إيقاف الصنف
app.put("/admin/products/:id/toggle", async (req, res) => {
  try {
    const { id } = req.params;
    const { is_active } = req.body;

    if (typeof is_active !== "boolean") {
      return res.status(400).json({ error: "قيمة is_active غير صحيحة" });
    }

    const result = await pool.query(
      `
      UPDATE products
      SET is_active = $1
      WHERE id = $2
      RETURNING id, name, is_active
      `,
      [is_active, id],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "الصنف غير موجود" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ==================== تعطيل أصناف بالجملة ====================

// التحقق من أكواد الأصناف للتعطيل
app.post(
  "/admin/products/bulk-deactivate/validate",
  authMiddleware,
  async (req, res) => {
    try {
      const { codes } = req.body;
      if (!codes || !codes.length) {
        return res.status(400).json({ error: "لا توجد أكواد" });
      }

      const allProducts = await pool.query(
        `SELECT id, name, barcode, is_active FROM products`,
      );
      const barcodeMap = new Map();
      allProducts.rows.forEach((p) => {
        if (p.barcode) barcodeMap.set(p.barcode.trim(), p);
      });

      const matched = [];
      const unmatched = [];
      const alreadyInactive = [];

      for (const code of codes) {
        const trimmed = String(code).trim();
        if (!trimmed) continue;
        const product = barcodeMap.get(trimmed);
        if (product) {
          if (!product.is_active) {
            alreadyInactive.push({
              code: trimmed,
              product_id: product.id,
              product_name: product.name,
            });
          } else {
            matched.push({
              code: trimmed,
              product_id: product.id,
              product_name: product.name,
            });
          }
        } else {
          unmatched.push(trimmed);
        }
      }

      res.json({ matched, unmatched, alreadyInactive, total: codes.length });
    } catch (err) {
      console.error("Bulk deactivate validate error:", err);
      res.status(500).json({ error: "فشل التحقق: " + err.message });
    }
  },
);

// تنفيذ التعطيل بالجملة
app.post(
  "/admin/products/bulk-deactivate/execute",
  authMiddleware,
  async (req, res) => {
    const client = await pool.connect();
    try {
      const { product_ids } = req.body;
      if (!product_ids || !product_ids.length) {
        return res.status(400).json({ error: "لا توجد أصناف للتعطيل" });
      }

      await client.query("BEGIN");

      const result = await client.query(
        `UPDATE products SET is_active = false WHERE id = ANY($1::int[]) AND is_active = true RETURNING id, name, barcode`,
        [product_ids],
      );

      await client.query("COMMIT");

      res.json({
        success: true,
        deactivated: result.rows.length,
        items: result.rows,
      });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("Bulk deactivate execute error:", err);
      res.status(500).json({ error: "فشل التعطيل: " + err.message });
    } finally {
      client.release();
    }
  },
);

// بحث باركود صنف
app.get("/products/by-barcode/:barcode", async (req, res) => {
  try {
    const { barcode } = req.params;
    const { invoice_type, movement_type } = req.query;

    if (!barcode || !invoice_type || !movement_type) {
      return res.status(400).json({
        error: "barcode و invoice_type و movement_type مطلوبين",
      });
    }
    if (invoice_type !== "retail") {
      return res.status(400).json({
        error: "البحث بالباركود متاح للقطاعي فقط",
      });
    }
    // نفس منطق المخزن
    const warehouseId = 1;

    let result;

    if (movement_type === "sale") {
      // 🔴 بيع → لازم رصيد
      result = await pool.query(
        `
        SELECT
          p.id,
          p.name,
          p.wholesale_package,
          p.retail_package,
          p.manufacturer,
          p.barcode,
          CASE
            WHEN $1 = 'wholesale' THEN p.wholesale_price
            ELSE p.retail_price
          END AS price,
          p.discount_amount,
          COALESCE(SUM(s.quantity), 0) AS available_quantity
        FROM products p
        JOIN stock s
          ON s.product_id = p.id
          AND s.warehouse_id = $2
        WHERE p.barcode = $3
          AND p.is_active = true
        GROUP BY p.id, p.name, p.wholesale_package, p.retail_package,
                 p.manufacturer, p.barcode, p.wholesale_price, p.retail_price, p.discount_amount
        HAVING SUM(s.quantity) > 0
        LIMIT 1
        `,
        [invoice_type, warehouseId, barcode],
      );
    } else {
      // 🟢 شراء
      result = await pool.query(
        `
  SELECT
    p.id,
    p.name,
    p.wholesale_package,
    p.retail_package,
    p.manufacturer,
    p.barcode,
    p.retail_purchase_price AS price,
    p.discount_amount,
    COALESCE(SUM(s.quantity), 0) AS available_quantity
  FROM products p
  LEFT JOIN stock s
    ON s.product_id = p.id
    AND s.warehouse_id = $1
  WHERE p.barcode = $2
    AND p.is_active = true
  GROUP BY p.id, p.name, p.wholesale_package, p.retail_package,
           p.manufacturer, p.barcode, p.retail_purchase_price, p.discount_amount
  LIMIT 1
  `,
        [warehouseId, barcode],
      );
    }

    // لو لقينا في المنتج الأساسي
    if (result.rows.length > 0) {
      return res.json(result.rows[0]);
    }

    // 🔍 بحث في الأكواد الفرعية (product_variants)
    let variantQuery;
    if (movement_type === "sale") {
      variantQuery = await pool.query(
        `SELECT pv.*, p.name, p.manufacturer, p.discount_amount, p.is_active,
                COALESCE(SUM(s.quantity), 0) AS available_quantity
         FROM product_variants pv
         JOIN products p ON p.id = pv.product_id
         JOIN stock s ON s.product_id = p.id AND s.warehouse_id = $1
         WHERE pv.barcode = $2 AND p.is_active = true
         GROUP BY pv.id, p.name, p.manufacturer, p.discount_amount, p.is_active
         HAVING SUM(s.quantity) > 0
         LIMIT 1`,
        [warehouseId, barcode],
      );
    } else {
      variantQuery = await pool.query(
        `SELECT pv.*, p.name, p.manufacturer, p.discount_amount, p.is_active,
                COALESCE(SUM(s.quantity), 0) AS available_quantity
         FROM product_variants pv
         JOIN products p ON p.id = pv.product_id
         LEFT JOIN stock s ON s.product_id = p.id AND s.warehouse_id = $1
         WHERE pv.barcode = $2 AND p.is_active = true
         GROUP BY pv.id, p.name, p.manufacturer, p.discount_amount, p.is_active
         LIMIT 1`,
        [warehouseId, barcode],
      );
    }

    if (variantQuery.rows.length > 0) {
      const v = variantQuery.rows[0];
      // نرجع البيانات بنفس الشكل بس بسعر وعبوة الكود الفرعي
      return res.json({
        id: v.product_id,
        name: v.name,
        wholesale_package: v.wholesale_package,
        retail_package: v.retail_package,
        manufacturer: v.manufacturer,
        barcode: v.barcode,
        price:
          movement_type === "sale"
            ? Number(v.retail_price)
            : Number(v.retail_purchase_price),
        discount_amount: v.discount_amount,
        available_quantity: v.available_quantity,
        variant_id: v.id,
        is_variant: true,
      });
    }

    return res.status(404).json({ error: "الصنف غير موجود" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// 🔎 فحص وجود باركود
app.get("/admin/products/check-barcode/:barcode", async (req, res) => {
  try {
    const { barcode } = req.params;
    const { exclude_id } = req.query; // 👈 مهم وقت التعديل

    if (!barcode) {
      return res.json({ exists: false });
    }

    let query = `
      SELECT id
      FROM products
      WHERE barcode = $1
    `;

    const values = [barcode];

    if (exclude_id) {
      query += ` AND id <> $2`;
      values.push(exclude_id);
    }

    const result = await pool.query(query, values);

    // كمان نشيك في الأكواد الفرعية
    const variantResult = await pool.query(
      `SELECT id FROM product_variants WHERE barcode = $1`,
      [barcode],
    );

    res.json({
      exists: result.rows.length > 0 || variantResult.rows.length > 0,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// 📥 استيراد أصناف من Excel (bulk import)
app.post("/admin/products/import", async (req, res) => {
  const client = await pool.connect();
  try {
    const { products } = req.body;

    if (!Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ error: "لا توجد بيانات للاستيراد" });
    }

    await client.query("BEGIN");

    let imported = 0;
    let skipped = 0;
    const errors = [];

    for (let i = 0; i < products.length; i++) {
      const p = products[i];
      try {
        // التحقق من البيانات المطلوبة
        if (!p.name || !p.wholesale_package || !p.retail_package) {
          errors.push({ row: i + 1, error: "اسم الصنف أو العبوة ناقصة" });
          skipped++;
          continue;
        }

        // التحقق من الباركود المكرر
        const barcodeVal =
          p.barcode != null && String(p.barcode).trim() !== ""
            ? String(p.barcode).trim()
            : null;
        if (barcodeVal) {
          const existing = await client.query(
            "SELECT id FROM products WHERE barcode = $1",
            [barcodeVal],
          );
          if (existing.rows.length > 0) {
            errors.push({ row: i + 1, error: `باركود مكرر: ${p.barcode}` });
            skipped++;
            continue;
          }
        }

        const insertRes = await client.query(
          `INSERT INTO products
           (name, wholesale_package, retail_package, manufacturer, purchase_price, retail_purchase_price, wholesale_price, retail_price, barcode, discount_amount)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           RETURNING id, barcode`,
          [
            p.name,
            p.wholesale_package,
            p.retail_package,
            p.manufacturer || null,
            Number(p.purchase_price) || 0,
            Number(p.retail_purchase_price) || 0,
            Number(p.wholesale_price) || 0,
            Number(p.retail_price) || 0,
            barcodeVal,
            Number(p.discount_amount) || 0,
          ],
        );

        // لو مفيش باركود → ولّد تلقائي
        const product = insertRes.rows[0];
        if (!product.barcode) {
          await client.query("UPDATE products SET barcode = $1 WHERE id = $2", [
            `900000${product.id}`,
            product.id,
          ]);
        }

        imported++;
      } catch (rowErr) {
        errors.push({ row: i + 1, error: rowErr.message });
        skipped++;
      }
    }

    await client.query("COMMIT");

    res.json({ imported, skipped, errors });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("IMPORT ERROR:", err);
    res.status(500).json({ error: "حدث خطأ أثناء الاستيراد" });
  } finally {
    client.release();
  }
});

// ===== 📦 CRUD أكواد فرعية (عبوات بديلة) =====

// عرض الأكواد الفرعية لصنف معين
app.get("/admin/products/:id/variants", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT pv.*, 
              COALESCE(NULLIF(pv.retail_package, ''), p.retail_package) AS retail_package
       FROM product_variants pv
       JOIN products p ON p.id = pv.product_id
       WHERE pv.product_id = $1 ORDER BY pv.id`,
      [id],
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// إضافة كود فرعي
app.post("/admin/products/:id/variants", async (req, res) => {
  try {
    const { id } = req.params;
    const {
      label,
      barcode,
      wholesale_package,
      retail_package,
      purchase_price = 0,
      retail_purchase_price = 0,
      wholesale_price = 0,
      retail_price = 0,
      discount_amount = 0,
    } = req.body;

    if (!wholesale_package && !retail_package) {
      return res.status(400).json({ error: "العبوة مطلوبة" });
    }

    // لو القطاعي فاضي أو 0 → ياخد من الصنف الأساسي
    const parentProduct = await pool.query(
      `SELECT retail_package, retail_price, retail_purchase_price FROM products WHERE id = $1`,
      [id],
    );
    const parent = parentProduct.rows[0] || {};
    const finalRetailPackage =
      !retail_package || retail_package === "0"
        ? parent.retail_package
        : retail_package;
    const finalRetailPrice =
      Number(retail_price) === 0
        ? Number(parent.retail_price || 0)
        : retail_price;
    const finalRetailPurchasePrice =
      Number(retail_purchase_price) === 0
        ? Number(parent.retail_purchase_price || 0)
        : retail_purchase_price;

    // تحقق من الباركود لو موجود
    if (barcode) {
      const existsInProducts = await pool.query(
        `SELECT id FROM products WHERE barcode = $1`,
        [barcode],
      );
      const existsInVariants = await pool.query(
        `SELECT id FROM product_variants WHERE barcode = $1`,
        [barcode],
      );
      if (
        existsInProducts.rows.length > 0 ||
        existsInVariants.rows.length > 0
      ) {
        return res.status(400).json({ error: "الباركود مستخدم بالفعل" });
      }
    }

    const result = await pool.query(
      `INSERT INTO product_variants 
        (product_id, label, barcode, wholesale_package, retail_package,
         purchase_price, retail_purchase_price, wholesale_price, retail_price, discount_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        id,
        label || null,
        barcode || null,
        wholesale_package || null,
        finalRetailPackage || null,
        purchase_price,
        finalRetailPurchasePrice,
        wholesale_price,
        finalRetailPrice,
        discount_amount,
      ],
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// تعديل كود فرعي
app.put("/admin/products/variants/:variantId", async (req, res) => {
  try {
    const { variantId } = req.params;
    const {
      label,
      barcode,
      wholesale_package,
      retail_package,
      purchase_price = 0,
      retail_purchase_price = 0,
      wholesale_price = 0,
      retail_price = 0,
      discount_amount = 0,
    } = req.body;

    // لو القطاعي فاضي أو 0 → ياخد من الصنف الأساسي
    const variantRow = await pool.query(
      `SELECT pv.product_id, p.retail_package, p.retail_price, p.retail_purchase_price
       FROM product_variants pv
       JOIN products p ON p.id = pv.product_id
       WHERE pv.id = $1`,
      [variantId],
    );
    const parent = variantRow.rows[0] || {};
    const finalRetailPackage =
      !retail_package || retail_package === "0"
        ? parent.retail_package
        : retail_package;
    const finalRetailPrice =
      Number(retail_price) === 0
        ? Number(parent.retail_price || 0)
        : retail_price;
    const finalRetailPurchasePrice =
      Number(retail_purchase_price) === 0
        ? Number(parent.retail_purchase_price || 0)
        : retail_purchase_price;

    // تحقق من الباركود لو موجود
    if (barcode) {
      const existsInProducts = await pool.query(
        `SELECT id FROM products WHERE barcode = $1`,
        [barcode],
      );
      const existsInVariants = await pool.query(
        `SELECT id FROM product_variants WHERE barcode = $1 AND id <> $2`,
        [barcode, variantId],
      );
      if (
        existsInProducts.rows.length > 0 ||
        existsInVariants.rows.length > 0
      ) {
        return res.status(400).json({ error: "الباركود مستخدم بالفعل" });
      }
    }

    const result = await pool.query(
      `UPDATE product_variants
       SET label = $1, barcode = $2, wholesale_package = $3, retail_package = $4,
           purchase_price = $5, retail_purchase_price = $6, wholesale_price = $7, retail_price = $8,
           discount_amount = $9
       WHERE id = $10
       RETURNING *`,
      [
        label || null,
        barcode || null,
        wholesale_package || null,
        finalRetailPackage || null,
        purchase_price,
        finalRetailPurchasePrice,
        wholesale_price,
        finalRetailPrice,
        discount_amount,
        variantId,
      ],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "الكود الفرعي غير موجود" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// حذف كود فرعي
app.delete("/admin/products/variants/:variantId", async (req, res) => {
  try {
    const { variantId } = req.params;
    const result = await pool.query(
      `DELETE FROM product_variants WHERE id = $1 RETURNING id`,
      [variantId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "الكود الفرعي غير موجود" });
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ==================== Manufacturers CRUD ====================

// جلب كل المصانع
app.get("/admin/manufacturers", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM manufacturers ORDER BY name ASC",
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// إضافة مصنع جديد
app.post("/admin/manufacturers", async (req, res) => {
  try {
    const { name, percentage, discount_base } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: "اسم المصنع مطلوب" });
    }
    const base = discount_base === "sale" ? "sale" : "purchase";
    const result = await pool.query(
      "INSERT INTO manufacturers (name, percentage, discount_base) VALUES ($1, $2, $3) RETURNING *",
      [name.trim(), percentage || 0, base],
    );
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505") {
      return res.status(400).json({ error: "المصنع موجود بالفعل" });
    }
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// تعديل مصنع
app.put("/admin/manufacturers/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name, percentage, discount_base } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: "اسم المصنع مطلوب" });
    }
    const base = discount_base === "sale" ? "sale" : "purchase";
    const result = await pool.query(
      "UPDATE manufacturers SET name = $1, percentage = $2, discount_base = $3 WHERE id = $4 RETURNING *",
      [name.trim(), percentage || 0, base, id],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "المصنع غير موجود" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505") {
      return res.status(400).json({ error: "المصنع موجود بالفعل" });
    }
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// حذف مصنع
app.delete("/admin/manufacturers/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      "DELETE FROM manufacturers WHERE id = $1 RETURNING id",
      [id],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "المصنع غير موجود" });
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// تعبئة المصانع من جدول الأصناف
app.post("/admin/manufacturers/seed", async (req, res) => {
  try {
    const result = await pool.query(`
      INSERT INTO manufacturers (name)
      SELECT DISTINCT manufacturer
      FROM products
      WHERE manufacturer IS NOT NULL AND manufacturer <> ''
      ON CONFLICT (name) DO NOTHING
      RETURNING *
    `);
    res.json({ added: result.rows.length, manufacturers: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ==================== End Manufacturers ====================

app.post("/stock/transfer", authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    const { from_branch_id, to_branch_id, items } = req.body;

    if (!from_branch_id || !to_branch_id || !items || items.length === 0) {
      return res.status(400).json({ error: "Invalid request data" });
    }

    await client.query("BEGIN");

    // مخزن المصدر
    const fromWarehouseRes = await client.query(
      "SELECT id FROM warehouses WHERE branch_id = $1",
      [from_branch_id],
    );
    const fromWarehouseId = fromWarehouseRes.rows[0].id;

    // مخزن الوجهة
    const toWarehouseRes = await client.query(
      "SELECT id FROM warehouses WHERE branch_id = $1",
      [to_branch_id],
    );
    const toWarehouseId = toWarehouseRes.rows[0].id;

    for (const item of items) {
      const { product_id, quantity } = item;
      const variantId = item.variant_id || 0;

      // تحقق من رصيد المصدر
      const stockRes = await client.query(
        "SELECT quantity FROM stock WHERE warehouse_id = $1 AND product_id = $2 AND variant_id = $3",
        [fromWarehouseId, product_id, variantId],
      );

      const available = stockRes.rows.length ? stockRes.rows[0].quantity : 0;
      if (available < quantity) {
        throw new Error(`Insufficient stock for product ${product_id}`);
      }

      // خصم من المصدر
      await client.query(
        `
        UPDATE stock
        SET quantity = quantity - $1
        WHERE warehouse_id = $2 AND product_id = $3 AND variant_id = $4
        `,
        [quantity, fromWarehouseId, product_id, variantId],
      );

      // إضافة للوجهة (لو مش موجود ينشئه)
      // 🔥 دمج كود القطاعي: أي بضاعة داخلة للقطاعي تتحفظ إجبارياً على الكود الأساسي (0)
      const targetVariantId = toWarehouseId === 1 ? 0 : variantId;

      await client.query(
        `
        INSERT INTO stock (warehouse_id, product_id, variant_id, quantity)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (warehouse_id, product_id, variant_id)
        DO UPDATE SET quantity = stock.quantity + $4
        `,
        [toWarehouseId, product_id, targetVariantId, quantity],
      );

      // حركة خروج
      await client.query(
        `
        INSERT INTO stock_movements
        (warehouse_id, product_id, variant_id, quantity, movement_type)
        VALUES ($1, $2, $3, $4, 'transfer_out')
        `,
        [fromWarehouseId, product_id, variantId, quantity],
      );

      // حركة دخول
      await client.query(
        `
        INSERT INTO stock_movements
        (warehouse_id, product_id, variant_id, quantity, movement_type)
        VALUES ($1, $2, $3, $4, 'transfer_in')
        `,
        [toWarehouseId, product_id, targetVariantId, quantity],
      );
    }

    await client.query("COMMIT");

    // 🔔 Notification to destination branch
    try {
      const senderRes = await pool.query(
        "SELECT full_name FROM users WHERE id = $1",
        [req.user.id],
      );
      const senderName = senderRes.rows[0]?.full_name || "مستخدم";
      const title = "تحويل مخزون جديد";
      const message = `قام ${senderName} بتحويل ${items.length} صنف إلى فرعكم`;

      await pool.query(
        `INSERT INTO notifications (title, message, from_user_id, to_branch_id, type, reference_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [title, message, req.user.id, to_branch_id, "stock_transfer", null],
      );

      const io = req.app.get("io");
      io.to(`branch_${to_branch_id}`).emit("new_notification", {
        title,
        message,
        type: "stock_transfer",
        reference_id: null,
      });

      sendPushToBranch(to_branch_id, title, message, {
        type: "stock_transfer",
      });
    } catch (notifErr) {
      console.error("TRANSFER NOTIFICATION ERROR:", notifErr);
    }

    res.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get("/stock/quantity", async (req, res) => {
  const { product_id, branch_id, variant_id } = req.query;

  if (!product_id || !branch_id) {
    return res.status(400).json({ error: "بيانات ناقصة" });
  }

  try {
    const warehouse_id = await getWholesaleWarehouseByBranch(branch_id);
    const vid = variant_id !== undefined ? Number(variant_id) : 0;

    const result = await pool.query(
      `
      SELECT quantity
      FROM stock
      WHERE product_id = $1 AND warehouse_id = $2 AND variant_id = $3
      `,
      [product_id, warehouse_id, vid],
    );

    const quantity = result.rows.length ? result.rows[0].quantity : 0;

    res.json({ quantity });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 📦 رصيد كل العبوات لمنتج معين
app.get("/stock/quantity-all", async (req, res) => {
  const { product_id, branch_id } = req.query;

  if (!product_id || !branch_id) {
    return res.status(400).json({ error: "بيانات ناقصة" });
  }

  try {
    const warehouse_id = await getWholesaleWarehouseByBranch(branch_id);

    const result = await pool.query(
      `
      SELECT variant_id, quantity
      FROM stock
      WHERE product_id = $1 AND warehouse_id = $2
      ORDER BY variant_id
      `,
      [product_id, warehouse_id],
    );

    // Return as map: { 0: 50, 3: 20, 5: 10 }
    const stockMap = {};
    for (const row of result.rows) {
      stockMap[row.variant_id] = Number(row.quantity);
    }

    res.json(stockMap);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/products/for-replace", async (req, res) => {
  try {
    const { branch_id } = req.query;

    if (!branch_id) {
      return res.status(400).json({ error: "branch_id مطلوب" });
    }

    // 👇 مخزن الجملة للفرع
    const warehouse_id = await getWholesaleWarehouseByBranch(branch_id);

    const result = await pool.query(
      `
      SELECT
        p.id,
        p.name,
        p.barcode,
        p.wholesale_package,
        p.retail_package,
        p.manufacturer,
        p.purchase_price,
        p.wholesale_price,
        'purchase' AS discount_base,
        COALESCE(SUM(s.quantity), 0) AS available_quantity
      FROM products p
      LEFT JOIN stock s
        ON s.product_id = p.id
        AND s.warehouse_id = $1
      LEFT JOIN manufacturers m
        ON m.name = p.manufacturer
      WHERE p.is_active = true
      GROUP BY p.id, p.name, p.barcode, p.wholesale_package, p.retail_package, p.manufacturer, p.purchase_price, p.wholesale_price
      ORDER BY p.name
      `,
      [warehouse_id],
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/stock/replace", async (req, res) => {
  const {
    branch_id,
    out_product_id,
    out_quantity,
    in_product_id,
    in_quantity,
    note,
  } = req.body;

  if (
    !branch_id ||
    !out_product_id ||
    !out_quantity ||
    !in_product_id ||
    !in_quantity
  ) {
    return res.status(400).json({ error: "بيانات ناقصة" });
  }

  const client = await pool.connect();

  try {
    const warehouse_id = await getWholesaleWarehouseByBranch(branch_id);
    await client.query("BEGIN");

    const result = await client.query(
      `SELECT quantity
     FROM stock
     WHERE product_id = $1 AND warehouse_id = $2 AND variant_id = 0
     FOR UPDATE`,
      [out_product_id, warehouse_id],
    );

    if (result.rows.length === 0) {
      throw new Error("الصنف غير موجود في المخزن");
    }

    const currentQuantity = result.rows[0].quantity;

    if (currentQuantity < out_quantity) {
      throw new Error("رصيد غير كافي");
    }

    // 1️⃣ خصم الصنف المكسور
    await client.query(
      `
  UPDATE stock
  SET quantity = quantity - $1
  WHERE product_id = $2 AND warehouse_id = $3 AND variant_id = 0
  `,
      [out_quantity, out_product_id, warehouse_id],
    );

    // 2️⃣ حركة خروج (كسر)
    await client.query(
      `
  INSERT INTO stock_movements
  (warehouse_id, product_id, quantity, movement_type, note)
  VALUES ($1, $2, $3, 'replace_out', $4)
  `,
      [warehouse_id, out_product_id, out_quantity, note],
    );

    // 3️⃣ إضافة الصنف البديل
    await client.query(
      `
  INSERT INTO stock (warehouse_id, product_id, variant_id, quantity)
  VALUES ($1, $2, 0, $3)
  ON CONFLICT (warehouse_id, product_id, variant_id)
  DO UPDATE SET quantity = stock.quantity + $3
  `,
      [warehouse_id, in_product_id, in_quantity],
    );

    // 4️⃣ حركة دخول (بدل)
    await client.query(
      `
  INSERT INTO stock_movements
  (warehouse_id, product_id, quantity, movement_type, note)
  VALUES ($1, $2, $3, 'replace_in', $4)
  `,
      [warehouse_id, in_product_id, in_quantity, note],
    );

    await client.query("COMMIT");

    res.json({
      message: "تم استبدال المصنع بنجاح",
    });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

const ACCESS_PERMISSION_KEYS = [
  "cash_in_edit",
  "cash_in_delete",
  "cash_out_edit",
  "cash_out_delete",
  "invoice_edit",
  "invoice_delete",
];

function normalizeUserPermissions(rawPermissions) {
  let parsedPermissions = rawPermissions;

  if (typeof parsedPermissions === "string") {
    try {
      parsedPermissions = JSON.parse(parsedPermissions);
    } catch {
      parsedPermissions = {};
    }
  }

  if (
    !parsedPermissions ||
    typeof parsedPermissions !== "object" ||
    Array.isArray(parsedPermissions)
  ) {
    parsedPermissions = {};
  }

  return ACCESS_PERMISSION_KEYS.reduce((acc, key) => {
    acc[key] = Boolean(parsedPermissions[key]);
    return acc;
  }, {});
}

let ensureUsersAccessControlColumnsPromise = null;

async function ensureUsersAccessControlColumns() {
  if (!ensureUsersAccessControlColumnsPromise) {
    ensureUsersAccessControlColumnsPromise = (async () => {
      const candidatePools = [pool.localPool, pool.cloudPool].filter(
        Boolean,
      );

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

      for (const poolRef of candidatePools) {
        try {
          await poolRef.query(
            `ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'user'`,
          );
          await poolRef.query(
            `ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions JSONB DEFAULT '{}'`,
          );
          await poolRef.query(ensureUsersRoleConstraintSql);
        } catch (err) {
          console.error("⚠️ ensureUsersAccessControlColumns failed for a pool:", err.message);
        }
      }
    })().catch((error) => {
      ensureUsersAccessControlColumnsPromise = null;
      throw error;
    });
  }

  return ensureUsersAccessControlColumnsPromise;
}

function createAccessError(message, statusCode = 500) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function isSuperAdmin(user) {
  return Number(user?.id) === 7;
}

function isAdminUser(user) {
  return isSuperAdmin(user) || user?.role === "admin";
}

function canManageBranch(user, branchId) {
  return isAdminUser(user);
}

async function loadCurrentUserAccess(req) {
  

  const result = await pool.query(
    `
    SELECT id, username, branch_id, full_name, role, permissions, theme
    FROM users
    WHERE id = $1
    `,
    [req.user.id],
  );

  if (!result.rows.length) {
    throw createAccessError("المستخدم غير موجود", 401);
  }

  const currentUser = result.rows[0];
  req.user = {
    ...req.user,
    id: currentUser.id,
    username: currentUser.username,
    branch_id: currentUser.branch_id,
    full_name: currentUser.full_name || "",
    role: currentUser.role === "admin" ? "admin" : "user",
    permissions: normalizeUserPermissions(currentUser.permissions),
    theme: currentUser.theme || "system",
  };

  return req.user;
}

function sendAccessError(res, err, fallbackMessage) {
  const statusCode = err?.statusCode || 500;
  return res.status(statusCode).json({
    error: statusCode === 401 ? err.message : fallbackMessage,
  });
}

async function requireAdminUser(req, res) {
  try {
    const currentUser = await loadCurrentUserAccess(req);

    if (!isAdminUser(currentUser)) {
      res.status(403).json({ error: "غير مصرح" });
      return null;
    }

    return currentUser;
  } catch (err) {
    console.error("ADMIN ACCESS ERROR:", err);
    sendAccessError(res, err, "خطأ في التحقق من صلاحيات المستخدم");
    return null;
  }
}

async function requirePermission(req, res, permissionKey) {
  try {
    const currentUser = await loadCurrentUserAccess(req);

    if (
      isAdminUser(currentUser) ||
      currentUser.permissions?.[permissionKey] === true
    ) {
      return currentUser;
    }

    res.status(403).json({ error: "ليس لديك صلاحية تنفيذ هذا الإجراء" });
    return null;
  } catch (err) {
    console.error("PERMISSION CHECK ERROR:", err);
    sendAccessError(res, err, "خطأ في التحقق من الصلاحيات");
    return null;
  }
}

/* ===============================
   💸 CASH OUT - إضافة إذن صرف
================================ */
app.post("/cash/out", authMiddleware, async (req, res) => {
  try {
    const branch_id = req.user.branch_id; // ✅ من التوكن
    const { name, amount, notes, date, entry_type, supplier_id } = req.body;
    const safeEntryType =
      entry_type === "purchase" ||
      entry_type === "expense" ||
      entry_type === "supplier_payment" ||
      entry_type === "warehouse_settlement"
        ? entry_type
        : "expense";

    if (!name || !amount || !date) {
      return res.status(400).json({ error: "بيانات ناقصة" });
    }

    if (safeEntryType === "supplier_payment" && !supplier_id) {
      return res.status(400).json({ error: "يجب اختيار المورد" });
    }

    // توليد رقم إذن (نفس منطق الفرونت)
    const datePart = date.replace(/-/g, "").slice(2);
    const randomPart = Math.floor(1000 + Math.random() * 9000);
    const permissionNumber = `${datePart}-${randomPart}`;

    const result = await pool.query(
      `
      INSERT INTO cash_out
      (
        branch_id,
        name,
        amount,
        notes,
        transaction_date,
        permission_number,
        entry_type,
        supplier_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, permission_number
      `,
      [
        branch_id,
        name,
        Number(amount),
        notes || null,
        date,
        permissionNumber,
        safeEntryType,
        safeEntryType === "supplier_payment" ? supplier_id : null,
      ],
    );

    res.json({
      success: true,
      id: result.rows[0].id,
      permission_number: result.rows[0].permission_number,
    });
  } catch (err) {
    console.error("CASH OUT ERROR:", err);
    res.status(500).json({ error: "خطأ في السيرفر" });
  }
});

/* ===============================
   ✏️ CASH OUT - تعديل إذن صرف
================================ */
app.put("/cash/out/:id", authMiddleware, async (req, res) => {
  try {
    const currentUser = await requirePermission(req, res, "cash_out_edit");
    if (!currentUser) return;

    const branch_id = currentUser.branch_id;
    const { id } = req.params;
    const { name, amount, notes, date, entry_type, supplier_id } = req.body;
    const safeEntryType =
      entry_type === "purchase" ||
      entry_type === "expense" ||
      entry_type === "supplier_payment" ||
      entry_type === "warehouse_settlement"
        ? entry_type
        : "expense";

    const result = await pool.query(
      `
      UPDATE cash_out
      SET name=$1, amount=$2, notes=$3, transaction_date=$4, entry_type=$5, supplier_id=$6
      WHERE id=$7 AND branch_id=$8
      RETURNING *
      `,
      [
        name,
        Number(amount),
        notes || null,
        date,
        safeEntryType,
        safeEntryType === "supplier_payment" ? supplier_id : null,
        id,
        branch_id,
      ],
    );

    if (!result.rows.length) {
      return res.status(403).json({ error: "غير مسموح بالتعديل" });
    }

    res.json({
      success: true,
      message: "تم تعديل إذن الصرف بنجاح",
      data: result.rows[0],
    });
  } catch (err) {
    console.error("UPDATE CASH OUT ERROR:", err);
    res.status(500).json({
      error: "خطأ في السيرفر",
    });
  }
});

/* ===============================
   📄 CASH OUT - عرض المنصرف
================================ */
app.get("/cash/out", authMiddleware, async (req, res) => {
  try {
    const {
      from_date,
      to_date,
      search_name,
      limit = 50,
      offset = 0,
    } = req.query;
    const branch_id = req.user.branch_id; // ✅ الفرع من التوكن

    let conditions = [`co.branch_id = $1`];
    let values = [branch_id];
    let idx = 2;

    //if (branch_id) {
    //conditions.push(`branch_id = $${idx++}`);
    //values.push(branch_id);
    // }

    if (from_date) {
      conditions.push(`co.transaction_date >= $${idx++}`);
      values.push(from_date);
    }

    if (to_date) {
      conditions.push(`co.transaction_date <= $${idx++}`);
      values.push(to_date);
    }

    if (search_name) {
      conditions.push(
        `REPLACE(COALESCE(co.name, ''), ' ', '') ILIKE $${idx++}`,
      );
      values.push(`%${String(search_name).replace(/\s+/g, "")}%`);
    }

    //const whereClause =
    //conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const result = await pool.query(
      `
      SELECT
        co.id,
        co.permission_number,
        co.name,
        co.amount,
        co.notes,
        to_char(co.transaction_date, 'YYYY-MM-DD') AS transaction_date,
        co.created_at,
        co.entry_type,
        co.supplier_id,
        s.name AS supplier_name
      FROM cash_out co
      LEFT JOIN suppliers s ON s.id = co.supplier_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY co.transaction_date DESC, co.created_at DESC, co.id DESC
      LIMIT $${idx++} OFFSET $${idx++}
      `,
      [...values, limit, offset],
    );

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (err) {
    console.error("GET CASH OUT ERROR:", err);
    res.status(500).json({ error: "خطأ في السيرفر" });
  }
});

/* ===============================
   🔎 CASH OUT - جلب منصرف واحد
================================ */
app.get("/cash/out/:id", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const branch_id = req.user.branch_id;

    const result = await pool.query(
      `
      SELECT
        co.id,
        co.permission_number,
        co.name,
        co.amount,
        co.notes,
        to_char(co.transaction_date, 'YYYY-MM-DD') AS transaction_date,
        co.entry_type,
        co.supplier_id,
        s.name AS supplier_name
      FROM cash_out co
      LEFT JOIN suppliers s ON s.id = co.supplier_id
      WHERE co.id = $1 AND co.branch_id = $2
      `,
      [id, branch_id],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "غير موجود أو غير مصرح" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("GET CASH OUT BY ID ERROR:", err);
    res.status(500).json({ error: "خطأ في السيرفر" });
  }
});

app.delete("/cash/out/:id", authMiddleware, async (req, res) => {
  try {
    const currentUser = await requirePermission(req, res, "cash_out_delete");
    if (!currentUser) return;

    const branch_id = currentUser.branch_id;
    const { id } = req.params;

    const result = await pool.query(
      `DELETE FROM cash_out WHERE id=$1 AND branch_id=$2 RETURNING id`,
      [id, branch_id],
    );

    if (!result.rowCount) {
      return res.status(403).json({ error: "غير مسموح بالحذف" });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("DELETE CASH OUT ERROR:", err);
    res.status(500).json({ error: "خطأ أثناء الحذف" });
  }
});

app.post("/cash/in/from-invoice", authMiddleware, async (req, res) => {
  const client = await pool.connect();

  try {
    const { invoice_id } = req.body;
    const userBranchId = req.user.branch_id; // ✅ لازم السطر ده

    if (!invoice_id) {
      return res.status(400).json({ error: "invoice_id مطلوب" });
    }

    await client.query("BEGIN");

    // 1️⃣ جلب بيانات الفاتورة
    const invoiceRes = await client.query(
      `
     SELECT
  id,
  branch_id,
  customer_id,
  customer_name,
  paid_amount,
  total,
  previous_balance,
  additional_amount,
  movement_type,
  invoice_type,
  invoice_date
FROM invoices
WHERE id = $1
      `,
      [invoice_id],
    );

    if (!invoiceRes.rows.length) {
      throw new Error("الفاتورة غير موجودة");
    }

    const invoice = invoiceRes.rows[0];
    // 🔐 منع ترحيل فاتورة من فرع آخر
    if (invoice.branch_id !== userBranchId) {
      throw new Error("غير مسموح بترحيل فاتورة من فرع آخر");
    }

    if (invoice.movement_type !== "sale") {
      await client.query("COMMIT");
      return res.json({
        success: true,
        message: "فاتورة شراء - لا يتم ترحيلها إلى اليومية",
      });
    }

    const totalWithPrevious =
      Number(invoice.total || 0) +
      Number(invoice.previous_balance || 0) +
      Number(invoice.additional_amount || 0);

    const remainingCash = totalWithPrevious - Number(invoice.paid_amount || 0);

    const syncResult = await syncInvoiceCashEntry(client, {
      invoiceId: invoice.id,
      branchId: userBranchId,
      invoiceType:
        invoice.invoice_type ||
        (Number(userBranchId) === 1 ? "retail" : "wholesale"),
      customerId: invoice.customer_id || null,
      customerName: invoice.customer_name,
      totalAmount: totalWithPrevious,
      paidAmount: Number(invoice.paid_amount || 0),
      remainingAmount: remainingCash,
      transactionDate: invoice.invoice_date || null,
    });

    let message = "تم تحديث اليومية بنجاح";
    if (syncResult.action === "inserted") {
      message = "تم ترحيل الفاتورة إلى اليومية";
    } else if (syncResult.action === "skipped") {
      message = "لا يوجد مبلغ مدفوع لهذه الفاتورة";
    } else if (Number(invoice.paid_amount || 0) <= 0) {
      message = "تم تحديث اليومية (لا يوجد مبلغ مدفوع)";
    }

    await client.query("COMMIT");

    res.json({
      success: true,
      message,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("CASH IN FROM INVOICE ERROR:", err);
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post("/cash/in", authMiddleware, async (req, res) => {
  const client = await pool.connect();

  try {
    console.log("CASH IN BODY:", req.body);
    const branch_id = req.user.branch_id; // 🔐
    const {
      transaction_date,
      customer_name,
      description,
      amount,
      notes,
      source_type,
      remaining_amount,
    } = req.body;

    if (!branch_id || !amount || Number(amount) <= 0) {
      return res
        .status(400)
        .json({ error: "بيانات غير مكتملة", body: req.body });
    }

    await client.query("BEGIN");

    const result = await client.query(
      `
  INSERT INTO cash_in
  (
    branch_id,
    transaction_date,
    source_type,
    customer_name,
    description,
    amount,
    paid_amount,
    remaining_amount,
    notes
  )
  VALUES
  (
    $1::integer,
    $2::date,
    $3::varchar,
    $4::varchar,
    $5::text,
    $6::numeric,
    $7::numeric,
    $8::numeric,
    $9::text
  )
  RETURNING id
  `,
      [
        Number(branch_id), // 1
        transaction_date || getCairoDate(), // 2
        source_type || "manual", // 3
        customer_name || (source_type === "warehouse_settlement" ? "سداد للمعرض" : "وارد يدوي"), // 4
        description || "", // 5
        Number(amount), // 6
        Number(amount), // 7
        Number(branch_id) === 1 && remaining_amount !== undefined ? Number(remaining_amount) : 0, // 8
        notes || null, // 9
      ],
    );

    // سندات الدفع تُسجَّل في cash_in فقط
    // وتظهر كأسطر منفصلة في كشف حساب العميل
    // بدون تعديل الفاتورة (لتجنب الحساب المزدوج)

    await client.query("COMMIT");

    res.json({
      success: true,
      cash_in_id: result.rows[0].id,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("CASH IN ERROR:", err);
    res.status(500).json({ error: "فشل إضافة الوارد" });
  } finally {
    client.release();
  }
});

app.get("/cash-in", authMiddleware, async (req, res) => {
  const client = await pool.connect();

  try {
    const branch_id = req.user.branch_id;
    const { from_date, to_date } = req.query;

    let query = `
      SELECT
        ci.id,
        ci.branch_id,
        ci.customer_name,
        ci.amount,
        ci.paid_amount,
        ci.remaining_amount,
        COALESCE(ci.notes, ci.description) AS notes,
        to_char(ci.transaction_date, 'YYYY-MM-DD') AS transaction_date,
        ci.source_type,
        ci.invoice_id,
        ci.created_at,
        inv.invoice_source,
        inv.external_order_id
      FROM cash_in ci
      LEFT JOIN invoices inv ON inv.id = ci.invoice_id
      WHERE ci.branch_id = $1
    `;
    const values = [branch_id];

    if (from_date) {
      values.push(from_date);
      query += ` AND ci.transaction_date >= $${values.length}::date`;
    }
    if (to_date) {
      values.push(to_date);
      query += ` AND ci.transaction_date <= $${values.length}::date`;
    }

    query += ` ORDER BY ci.transaction_date DESC, ci.id DESC`;

    const result = await client.query(query, values);

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "فشل تحميل وارد الخزنة",
    });
  } finally {
    client.release();
  }
});
app.delete("/cash-in/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;
  const currentUser = await requirePermission(req, res, "cash_in_delete");
  if (!currentUser) return;

  const branch_id = currentUser.branch_id;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const checkRes = await client.query(
      `SELECT id FROM cash_in WHERE id = $1 AND branch_id = $2`,
      [id, branch_id],
    );

    if (!checkRes.rows.length) {
      return res.status(404).json({ error: "القيد غير موجود" });
    }

    await client.query(`DELETE FROM cash_in WHERE id = $1 AND branch_id = $2`, [
      id,
      branch_id,
    ]);

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "تم حذف القيد بنجاح",
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("DELETE CASH IN ERROR:", err);
    res.status(500).json({ error: "فشل حذف القيد" });
  } finally {
    client.release();
  }
});

app.put("/cash-in/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { customer_name, description, amount, transaction_date } = req.body;
  const currentUser = await requirePermission(req, res, "cash_in_edit");
  if (!currentUser) return;

  const branch_id = currentUser.branch_id;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const checkRes = await client.query(
      `
      SELECT id, source_type
      FROM cash_in
      WHERE id = $1 AND branch_id = $2
      `,
      [id, branch_id],
    );

    if (!checkRes.rows.length) {
      return res.status(403).json({ error: "غير مسموح بالتعديل" });
    }

    const sourceType = checkRes.rows[0].source_type;

    if (sourceType === "invoice") {
      // For invoice entries, only allow updating the date
      await client.query(
        `
        UPDATE cash_in
        SET transaction_date = $1::date
        WHERE id = $2 AND branch_id = $3
        `,
        [transaction_date, id, branch_id],
      );
    } else {
      await client.query(
        `
        UPDATE cash_in
        SET
          customer_name = $1,
          description = $2,
          amount = $3,
          paid_amount = $3,
          transaction_date = $4::date
        WHERE id = $5 AND branch_id = $6
        `,
        [
          customer_name,
          description,
          Number(amount),
          transaction_date,
          id,
          branch_id,
        ],
      );
    }

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "تم تعديل القيد بنجاح",
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("UPDATE CASH IN ERROR:", err);
    res.status(500).json({ error: "فشل تعديل القيد" });
  } finally {
    client.release();
  }
});

app.get("/cash-in/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;
  const branch_id = req.user.branch_id;
  const client = await pool.connect();

  try {
    const result = await client.query(
      `
      SELECT
        ci.id,
        ci.branch_id,
        ci.customer_name,
        ci.amount,
        ci.paid_amount,
        ci.remaining_amount,
        ci.description,
        to_char(ci.transaction_date, 'YYYY-MM-DD') AS transaction_date,
        ci.source_type,
        ci.invoice_id,
        ci.created_at,
        inv.invoice_source,
        inv.external_order_id
      FROM cash_in ci
      LEFT JOIN invoices inv ON inv.id = ci.invoice_id
      WHERE ci.id = $1 AND ci.branch_id = $2
      `,
      [id, branch_id],
    );

    if (!result.rows.length) {
      return res.status(404).json({
        error: "القيد غير موجود",
      });
    }

    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (err) {
    console.error("GET CASH IN BY ID ERROR:", err);
    res.status(500).json({
      error: "فشل تحميل القيد",
    });
  } finally {
    client.release();
  }
});

app.post("/stock/wholesale-to-retail/preview", async (req, res) => {
  try {
    const { from_branch_id, to_branch_id, items } = req.body;

    if (
      !from_branch_id ||
      !to_branch_id ||
      !items ||
      !Array.isArray(items) ||
      items.length === 0
    ) {
      return res.status(400).json({ error: "بيانات ناقصة" });
    }

    // ✅ مخزن الجملة (المصدر)
    const wholesaleWarehouseId = getWarehouseIdByInvoiceType("wholesale");

    const previewResults = [];

    for (const item of items) {
      const { product_id, quantity, variant_id: rawVariantId } = item;
      const variantId = rawVariantId || 0;

      if (!product_id || !quantity || quantity <= 0) {
        previewResults.push({
          product_id,
          variant_id: variantId,
          status: "rejected",
          reason: "INVALID_ITEM_DATA",
        });
        continue;
      }

      // 1️⃣ بيانات الصنف
      const productRes = await pool.query(
        `
       SELECT
  id,
  name,
  manufacturer,
  wholesale_package,
  retail_package
FROM products

        WHERE id = $1 AND is_active = true
        `,
        [product_id],
      );

      if (!productRes.rows.length) {
        previewResults.push({
          product_id,
          variant_id: variantId,
          status: "rejected",
          reason: "PRODUCT_NOT_FOUND",
        });
        continue;
      }

      const product = productRes.rows[0];

      // بيانات العبوة (من الأصناف الفرعية لو variant_id مش 0)
      let wholesalePkg = product.wholesale_package;
      let retailPkg = product.retail_package;
      let packageName = wholesalePkg;

      if (variantId !== 0) {
        const vRes = await pool.query(
          `SELECT wholesale_package, retail_package FROM product_variants WHERE id = $1`,
          [variantId],
        );
        if (vRes.rows.length) {
          wholesalePkg = vRes.rows[0].wholesale_package || wholesalePkg;
          retailPkg = vRes.rows[0].retail_package || retailPkg;
          packageName = wholesalePkg;
        }
      }

      // 2️⃣ رصيد مخزن الجملة للعبوة المحددة
      const stockRes = await pool.query(
        `
        SELECT quantity
        FROM stock
        WHERE product_id = $1 AND warehouse_id = $2 AND variant_id = $3
        `,
        [product_id, wholesaleWarehouseId, variantId],
      );

      const availableQuantity = stockRes.rows.length
        ? Number(stockRes.rows[0].quantity)
        : 0;

      if (availableQuantity < quantity) {
        previewResults.push({
          product_id,
          variant_id: variantId,
          product_name: product.name,
          package_name: packageName,
          status: "rejected",
          reason: "INSUFFICIENT_STOCK",
        });
        continue;
      }

      // 3️⃣ التحويل
      try {
        const result = convertWholesaleToRetail({
          wholesale_package: wholesalePkg,
          retail_package: retailPkg,
          wholesale_quantity: quantity,
        });

        previewResults.push({
          product_id,
          variant_id: variantId,
          product_name: product.name,
          manufacturer: product.manufacturer,
          package_name: packageName,
          from_quantity: quantity,
          to_quantity: result.retail_quantity,
          status: "ok",
        });
      } catch (err) {
        previewResults.push({
          product_id,
          variant_id: variantId,
          product_name: product.name,
          package_name: packageName,
          status: "rejected",
          reason: err.message || "INVALID_PACKAGE",
        });
      }
    }

    res.json(previewResults);
  } catch (err) {
    console.error("PREVIEW ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post(
  "/stock/wholesale-to-retail/execute",
  authMiddleware,
  async (req, res) => {
    const client = await pool.connect();

    try {
      const { from_branch_id, to_branch_id, items, note, created_by } =
        req.body;

      if (
        !from_branch_id ||
        !to_branch_id ||
        !Array.isArray(items) ||
        items.length === 0
      ) {
        return res.status(400).json({ error: "بيانات ناقصة" });
      }

      await client.query("BEGIN");

      // ✅ مخزن الجملة (المصدر) + ✅ مخزن القطاعي (الوجهة)
      const wholesaleWarehouseId = getWarehouseIdByInvoiceType("wholesale");
      const retailWarehouseId = getWarehouseIdByInvoiceType("retail");

      // 1️⃣ إنشاء رأس التحويل
      const transferRes = await client.query(
        `
      INSERT INTO stock_transfers (branch_id, created_by, note)
      VALUES ($1, $2, $3)
      RETURNING id
      `,
        [from_branch_id, created_by || null, note || null],
      );

      const transferId = transferRes.rows[0].id;

      const resultItems = [];

      // 2️⃣ تنفيذ العناصر
      for (const item of items) {
        const product_id = Number(item.product_id);
        const quantity = Number(item.quantity);
        const variantId = Number(item.variant_id) || 0;

        if (!product_id || quantity <= 0) {
          throw new Error("INVALID_ITEM_DATA");
        }

        // 🔹 بيانات الصنف
        const productRes = await client.query(
          `
        SELECT id, name, wholesale_package, retail_package
        FROM products
        WHERE id = $1 AND is_active = true
        `,
          [product_id],
        );

        if (!productRes.rows.length) {
          throw new Error(`PRODUCT_NOT_FOUND:${product_id}`);
        }

        const product = productRes.rows[0];

        // بيانات العبوة (من الأصناف الفرعية لو variant_id مش 0)
        let wholesalePkg = product.wholesale_package;
        let retailPkg = product.retail_package;

        if (variantId !== 0) {
          const vRes = await client.query(
            `SELECT wholesale_package, retail_package FROM product_variants WHERE id = $1`,
            [variantId],
          );
          if (vRes.rows.length) {
            wholesalePkg = vRes.rows[0].wholesale_package || wholesalePkg;
            retailPkg = vRes.rows[0].retail_package || retailPkg;
          }
        }

        // 🔹 رصيد الجملة (قفل الصف)
        const stockRes = await client.query(
          `
        SELECT quantity
        FROM stock
        WHERE warehouse_id = $1 AND product_id = $2 AND variant_id = $3
        FOR UPDATE
        `,
          [wholesaleWarehouseId, product_id, variantId],
        );

        const available = stockRes.rows.length
          ? Number(stockRes.rows[0].quantity)
          : 0;

        if (available < quantity) {
          throw new Error(`INSUFFICIENT_STOCK:${product.name}`);
        }

        // 🔹 التحويل
        const conversion = convertWholesaleToRetail({
          wholesale_package: wholesalePkg,
          retail_package: retailPkg,
          wholesale_quantity: quantity,
        });

        // 3️⃣ خصم من الجملة
        await client.query(
          `
        UPDATE stock
        SET quantity = quantity - $1
        WHERE warehouse_id = $2 AND product_id = $3 AND variant_id = $4
        `,
          [quantity, wholesaleWarehouseId, product_id, variantId],
        );

        // 4️⃣ إضافة للقطاعي
        // 🔥 دمج كود القطاعي: إجبار البضاعة المحولة للقطاعي أينما كانت على الكود الأساسي (0)
        const targetVariantId = retailWarehouseId === 1 ? 0 : variantId;

        await client.query(
          `
        INSERT INTO stock (warehouse_id, product_id, variant_id, quantity)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (warehouse_id, product_id, variant_id)
        DO UPDATE SET quantity = stock.quantity + $4
        `,
          [
            retailWarehouseId,
            product_id,
            targetVariantId,
            conversion.retail_quantity,
          ],
        );

        // 5️⃣ تفاصيل التحويل
        await client.query(
          `
        INSERT INTO stock_transfer_items
        (
          transfer_id,
          product_id,
          from_warehouse_id,
          to_warehouse_id,
          from_quantity,
          to_quantity,
          total_price
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        `,
          [
            transferId,
            product_id,
            wholesaleWarehouseId,
            retailWarehouseId,
            quantity,
            conversion.retail_quantity,
            item.final_price || 0,
          ],
        );

        // 6️⃣ حركة مخزون (خروج)
        await client.query(
          `
        INSERT INTO stock_movements
        (
          warehouse_id,
          product_id,
          variant_id,
          quantity,
          movement_type,
          reference_type,
          reference_id,
          note
        )
        VALUES ($1,$2,$3,$4,'transfer_out','transfer',$5,$6)
        `,
          [
            wholesaleWarehouseId,
            product_id,
            variantId,
            quantity,
            transferId,
            "تحويل من الجملة إلى القطاعي",
          ],
        );

        // 7️⃣ حركة مخزون (دخول)
        await client.query(
          `
        INSERT INTO stock_movements
        (
          warehouse_id,
          product_id,
          variant_id,
          quantity,
          movement_type,
          reference_type,
          reference_id,
          note
        )
        VALUES ($1,$2,$3,$4,'transfer_in','transfer',$5,$6)
        `,
          [
            retailWarehouseId,
            product_id,
            targetVariantId,
            conversion.retail_quantity,
            transferId,
            "تحويل من الجملة إلى القطاعي",
          ],
        );

        resultItems.push({
          product_id,
          product_name: product.name,
          from_quantity: quantity,
          to_quantity: conversion.retail_quantity,
        });
      }

      await client.query("COMMIT");

      // 🔔 Notification to destination branch
      try {
        const senderRes = await pool.query(
          "SELECT full_name FROM users WHERE id = $1",
          [req.user.id],
        );
        const senderName = senderRes.rows[0]?.full_name || "مستخدم";
        const title = "تحويل بضاعة من المعرض";
        const message = `قام ${senderName} بسحب ${items.length} صنف من المخزن — تحويل رقم #${transferId}`;

        await pool.query(
          `INSERT INTO notifications (title, message, from_user_id, to_branch_id, type, reference_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            title,
            message,
            req.user.id,
            from_branch_id,
            "stock_transfer",
            transferId,
          ],
        );

        const io = req.app.get("io");
        io.to(`branch_${from_branch_id}`).emit("new_notification", {
          title,
          message,
          type: "stock_transfer",
          reference_id: transferId,
        });

        sendPushToBranch(from_branch_id, title, message, {
          type: "stock_transfer",
          transfer_id: transferId,
        });
      } catch (notifErr) {
        console.error("TRANSFER NOTIFICATION ERROR:", notifErr);
      }

      res.json({
        success: true,
        transfer_id: transferId,
        items: resultItems,
      });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("EXECUTE TRANSFER ERROR:", err);

      res.status(400).json({
        success: false,
        error: err.message,
      });
    } finally {
      client.release();
    }
  },
);

app.get("/stock-transfers", async (req, res) => {
  try {
    const { branch_id, date_from, limit = 50, offset = 0 } = req.query;

    let conditions = [];
    let values = [];
    let idx = 1;

    if (branch_id) {
      conditions.push(`st.branch_id = ${idx++}`);
      values.push(branch_id);
    }

    if (date_from) {
      conditions.push(`st.created_at >= ${idx++}::date`);
      values.push(date_from);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const result = await pool.query(
      `
      SELECT
        st.id,
        st.branch_id,
        st.note,
        st.created_at,
        st.status, 
        COUNT(sti.id) AS items_count,
        COALESCE(SUM(sti.from_quantity), 0) AS total_from_quantity
      FROM stock_transfers st
      LEFT JOIN stock_transfer_items sti
        ON sti.transfer_id = st.id
      ${whereClause}
      GROUP BY
       st.id,
       st.branch_id,
       st.note,
       st.created_at,
       st.status
      ORDER BY st.created_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
      `,
      [...values, limit, offset],
    );

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (err) {
    console.error("GET STOCK TRANSFERS ERROR:", err);
    res.status(500).json({ error: "فشل تحميل التحويلات" });
  }
});

app.get("/stock-transfers/summary/by-date", async (req, res) => {
  const { date } = req.query;

  const { rows } = await pool.query(
    `
    SELECT
      COALESCE(SUM(sti.from_quantity), 0) AS total_quantity
    FROM stock_transfer_items sti
    JOIN stock_transfers st ON st.id = sti.transfer_id
    WHERE (st.created_at AT TIME ZONE 'Africa/Cairo')::date = $1::date
      AND sti.status = 'active'
      AND st.status = 'active'

    `,
    [date],
  );

  res.json({
    date,
    total_quantity: rows[0].total_quantity,
  });
});

app.get("/stock-transfers/by-date", async (req, res) => {
  const { date } = req.query;

  if (!date) {
    return res.status(400).json({
      error: "date is required (YYYY-MM-DD)",
    });
  }

  try {
    const { rows } = await pool.query(
      `
      SELECT
        sti.id,
        sti.transfer_id,
        sti.product_id,
        p.name            AS product_name,
        p.manufacturer       AS manufacturer,        -- 👈 أضف ده
        p.wholesale_package  AS wholesale_package,   -- 👈 وده
        sti.from_quantity,
        sti.to_quantity,
        sti.total_price,
        fw.name           AS from_warehouse,
        tw.name           AS to_warehouse,
        CASE
          WHEN st.status = 'cancelled' THEN 'cancelled'
          ELSE sti.status
        END              AS status,
        st.status         AS transfer_status,
        st.created_at,
        COALESCE(sti.received, false) AS received
        
      FROM stock_transfer_items sti
      JOIN stock_transfers st ON st.id = sti.transfer_id
      JOIN products p ON p.id = sti.product_id
      JOIN warehouses fw ON fw.id = sti.from_warehouse_id
      JOIN warehouses tw ON tw.id = sti.to_warehouse_id
      WHERE (st.created_at AT TIME ZONE 'Africa/Cairo')::date = $1::date
      ORDER BY st.created_at ASC, sti.id ASC
      `,
      [date],
    );

    res.json({
      date,
      items_count: rows.length,
      items: rows,
    });
  } catch (err) {
    console.error("GET TRANSFERS BY DATE ERROR:", err);
    res.status(500).json({
      error: "Failed to load transfers by date",
    });
  }
});

app.get("/stock-transfers/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // رأس التحويل
    const transferRes = await pool.query(
      `
      SELECT
        id,
        branch_id,
        note,
        status,
        created_at
      FROM stock_transfers
      WHERE id = $1
      `,
      [id],
    );

    if (!transferRes.rows.length) {
      return res.status(404).json({ error: "التحويل غير موجود" });
    }

    // الأصناف
    const itemsRes = await pool.query(
      `
      SELECT
        sti.id,
  sti.product_id,
  sti.status,
  p.name AS product_name,
  sti.from_quantity,
  sti.to_quantity,
  sti.total_price,
  w1.name AS from_warehouse,
  w2.name AS to_warehouse
FROM stock_transfer_items sti
JOIN products p ON p.id = sti.product_id
JOIN warehouses w1 ON w1.id = sti.from_warehouse_id
JOIN warehouses w2 ON w2.id = sti.to_warehouse_id
WHERE sti.transfer_id = $1
      `,
      [id],
    );

    res.json({
      success: true,
      transfer: transferRes.rows[0],
      items: itemsRes.rows,
    });
  } catch (err) {
    console.error("GET STOCK TRANSFER ERROR:", err);
    res.status(500).json({ error: "فشل تحميل تفاصيل التحويل" });
  }
});

app.post("/stock-transfers/:id/cancel", async (req, res) => {
  const client = await pool.connect();

  try {
    const transferId = Number(req.params.id);

    await client.query("BEGIN");

    // 1️⃣ هات التحويل
    const transferRes = await client.query(
      `
      SELECT id, status
      FROM stock_transfers
      WHERE id = $1
      FOR UPDATE
      `,
      [transferId],
    );

    if (!transferRes.rows.length) {
      throw new Error("التحويل غير موجود");
    }

    if (transferRes.rows[0].status === "cancelled") {
      throw new Error("التحويل ملغي بالفعل");
    }

    // 2️⃣ هات الأصناف
    const itemsRes = await client.query(
      `
      SELECT
        id,
        product_id,
        from_warehouse_id,
        to_warehouse_id,
        from_quantity,
        to_quantity,
        COALESCE(status, 'active') AS status
      FROM stock_transfer_items
      WHERE transfer_id = $1
        AND COALESCE(status, 'active') = 'active'
      FOR UPDATE
      `,
      [transferId],
    );

    if (!itemsRes.rows.length) {
      // Idempotent behavior: if all items were already cancelled earlier,
      // just close the transfer header without touching stock again.
      await client.query(
        `
        UPDATE stock_transfers
        SET status = 'cancelled'
        WHERE id = $1
        `,
        [transferId],
      );

      await client.query("COMMIT");

      return res.json({
        success: true,
        message: "التحويل ملغي بالفعل",
      });
    }

    // 3️⃣ عكس التأثير
    for (const item of itemsRes.rows) {
      // حاول تجيب الـ variant_id من حركات المخزن إذا كان 0 ومفيش عمود في الجدول
      const moveRes = await client.query(
        `SELECT variant_id FROM stock_movements WHERE reference_type = 'transfer' AND reference_id = $1 AND product_id = $2 AND movement_type = 'transfer_out' LIMIT 1`,
        [transferId, item.product_id],
      );
      const actualVariantId = moveRes.rows.length
        ? Number(moveRes.rows[0].variant_id)
        : 0;

      // ➕ رجوع للجملة
      await client.query(
        `
        UPDATE stock
        SET quantity = quantity + $1
        WHERE warehouse_id = $2 AND product_id = $3 AND variant_id = $4
        `,
        [
          item.from_quantity,
          item.from_warehouse_id,
          item.product_id,
          actualVariantId,
        ],
      );

      // ➖ خصم من القطاعي
      const retailStockRes = await client.query(
        `
        SELECT quantity
        FROM stock
        WHERE warehouse_id = $1 AND product_id = $2 AND variant_id = 0
        FOR UPDATE
        `,
        [item.to_warehouse_id, item.product_id],
      );

      const available = Number(retailStockRes.rows[0]?.quantity || 0);
      const required = Number(item.to_quantity || 0);

      if (available < required) {
        throw new Error(
          `لا يمكن إلغاء التحويل: رصيد القطاعي غير كافي للصنف ${item.product_id}`,
        );
      }

      await client.query(
        `
        UPDATE stock
        SET quantity = quantity - $1
        WHERE warehouse_id = $2 AND product_id = $3 AND variant_id = 0
        `,
        [item.to_quantity, item.to_warehouse_id, item.product_id],
      );

      // 🧾 حركة عكسية (دخول الجملة)
      await client.query(
        `
        INSERT INTO stock_movements
        (
          warehouse_id,
          product_id,
          variant_id,
          quantity,
          movement_type,
          reference_type,
          reference_id,
          note
        )
        VALUES ($1,$2,$3,$4,'transfer_in','transfer_cancel',$5,$6)
        `,
        [
          item.from_warehouse_id,
          item.product_id,
          actualVariantId,
          item.from_quantity,
          transferId,
          "إلغاء تحويل – رجوع للجملة",
        ],
      );

      // 🧾 حركة عكسية (خروج القطاعي)
      await client.query(
        `
        INSERT INTO stock_movements
        (
          warehouse_id,
          product_id,
          variant_id,
          quantity,
          movement_type,
          reference_type,
          reference_id,
          note
        )
        VALUES ($1,$2,0,$3,'transfer_out','transfer_cancel',$4,$5)
        `,
        [
          item.to_warehouse_id,
          item.product_id,
          item.to_quantity,
          transferId,
          "إلغاء تحويل – خصم من القطاعي",
        ],
      );
    }

    // 4️⃣ تحديث حالة التحويل
    await client.query(
      `
      UPDATE stock_transfers
      SET status = 'cancelled'
      WHERE id = $1
      `,
      [transferId],
    );

    await client.query(
      `
      UPDATE stock_transfer_items
      SET status = 'cancelled'
      WHERE transfer_id = $1
        AND COALESCE(status, 'active') = 'active'
      `,
      [transferId],
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "تم إلغاء التحويل بنجاح",
    });
  } catch (err) {
    await client.query("ROLLBACK");

    console.error("CANCEL TRANSFER ERROR:", err);

    res.status(400).json({
      success: false,
      error: err.message,
    });
  } finally {
    client.release();
  }
});

app.post("/stock-transfers/items/:itemId/cancel", async (req, res) => {
  const client = await pool.connect();

  try {
    const itemId = Number(req.params.itemId);

    if (!itemId) {
      return res.status(400).json({ error: "معرف الصنف غير صحيح" });
    }

    await client.query("BEGIN");

    // 1️⃣ هات الصنف من التحويل
    const itemRes = await client.query(
      `
      SELECT
        sti.id,
        sti.transfer_id,
        sti.product_id,
        sti.from_warehouse_id,
        sti.to_warehouse_id,
        sti.from_quantity,
        sti.to_quantity,
        sti.status
      FROM stock_transfer_items sti
      WHERE sti.id = $1
      FOR UPDATE
      `,
      [itemId],
    );

    if (!itemRes.rows.length) {
      throw new Error("الصنف غير موجود داخل التحويل");
    }

    const item = itemRes.rows[0];

    if (item.status === "cancelled") {
      throw new Error("تم إلغاء هذا الصنف مسبقًا");
    }

    // 1.5️⃣ اقفل رأس التحويل لتفادي سباق الإلغاء الكلي مع إلغاء الصنف
    const transferLockRes = await client.query(
      `
      SELECT id, status
      FROM stock_transfers
      WHERE id = $1
      FOR UPDATE
      `,
      [item.transfer_id],
    );

    if (!transferLockRes.rows.length) {
      throw new Error("التحويل غير موجود");
    }

    if (transferLockRes.rows[0].status === "cancelled") {
      throw new Error("التحويل ملغي بالفعل");
    }

    // 2️⃣ تأكد إن رصيد المخزن الهدف يسمح بالعكس
    const targetStockRes = await client.query(
      `
      SELECT SUM(quantity) AS quantity
      FROM stock
      WHERE warehouse_id = $1 AND product_id = $2
      `,
      [item.to_warehouse_id, item.product_id],
    );

    const availableTargetQty = Number(targetStockRes.rows[0]?.quantity || 0);
    const requiredTargetQty = Number(item.to_quantity || 0);

    if (availableTargetQty < requiredTargetQty) {
      throw new Error("لا يمكن إلغاء الصنف: رصيد المخزن المستلم غير كافي");
    }

    // 3️⃣ عكس الكميات

    const moveRes = await client.query(
      `SELECT variant_id FROM stock_movements WHERE reference_type = 'transfer' AND reference_id = $1 AND product_id = $2 AND movement_type = 'transfer_out' LIMIT 1`,
      [item.transfer_id, item.product_id],
    );
    const actualVariantId = moveRes.rows.length
      ? Number(moveRes.rows[0].variant_id)
      : 0;

    // ➕ رجوع للمخزن الأصلي
    await client.query(
      `
      UPDATE stock
      SET quantity = quantity + $1
      WHERE warehouse_id = $2 AND product_id = $3 AND variant_id = $4
      `,
      [
        item.from_quantity,
        item.from_warehouse_id,
        item.product_id,
        actualVariantId,
      ],
    );

    // ➖ خصم من المخزن الهدف
    await client.query(
      `
      UPDATE stock
      SET quantity = quantity - $1
      WHERE warehouse_id = $2 AND product_id = $3 AND variant_id = 0
      `,
      [item.to_quantity, item.to_warehouse_id, item.product_id],
    );

    // 4️⃣ تسجيل حركات المخزن (عكسية)

    // دخول للمخزن الأصلي
    await client.query(
      `
      INSERT INTO stock_movements
      (
        warehouse_id,
        product_id,
        variant_id,
        quantity,
        movement_type,
        reference_type,
        reference_id,
        note
      )
      VALUES ($1,$2,$3,$4,'transfer_in','transfer_item_cancel',$5,$6)
      `,
      [
        item.from_warehouse_id,
        item.product_id,
        actualVariantId,
        item.from_quantity,
        item.id,
        "إلغاء صنف من تحويل – رجوع للمخزن الأصلي",
      ],
    );

    // خروج من المخزن الهدف
    await client.query(
      `
      INSERT INTO stock_movements
      (
        warehouse_id,
        product_id,
        variant_id,
        quantity,
        movement_type,
        reference_type,
        reference_id,
        note
      )
      VALUES ($1,$2,0,$3,'transfer_out','transfer_item_cancel',$4,$5)
      `,
      [
        item.to_warehouse_id,
        item.product_id,
        item.to_quantity,
        item.id,
        "إلغاء صنف من تحويل – خصم من المخزن المستلم",
      ],
    );

    // 5️⃣ تحديث حالة الصنف
    await client.query(
      `
      UPDATE stock_transfer_items
      SET status = 'cancelled'
      WHERE id = $1
      `,
      [itemId],
    );

    // لو مفيش أي بنود نشطة بعد الإلغاء، اقفل رأس التحويل تلقائيًا
    const remainingActiveItemsRes = await client.query(
      `
      SELECT COUNT(*)::int AS cnt
      FROM stock_transfer_items
      WHERE transfer_id = $1
        AND COALESCE(status, 'active') = 'active'
      `,
      [item.transfer_id],
    );

    if ((remainingActiveItemsRes.rows[0]?.cnt || 0) === 0) {
      await client.query(
        `
        UPDATE stock_transfers
        SET status = 'cancelled'
        WHERE id = $1
        `,
        [item.transfer_id],
      );
    }

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "تم إلغاء الصنف بنجاح",
    });
  } catch (err) {
    await client.query("ROLLBACK");

    console.error("CANCEL TRANSFER ITEM ERROR:", err);

    res.status(400).json({
      success: false,
      error: err.message,
    });
  } finally {
    client.release();
  }
});

// ✅ تحديث حالة استلام صنف من التحويل
app.patch(
  "/stock-transfers/items/:itemId",
  authMiddleware,
  async (req, res) => {
    const itemId = Number(req.params.itemId);
    const { received } = req.body;

    if (typeof received !== "boolean") {
      return res.status(400).json({ error: "received must be a boolean" });
    }

    try {
      const { rowCount } = await pool.query(
        `UPDATE stock_transfer_items SET received = $1 WHERE id = $2`,
        [received, itemId],
      );

      if (!rowCount) {
        return res.status(404).json({ error: "Item not found" });
      }

      res.json({ success: true, received });
    } catch (err) {
      console.error("PATCH TRANSFER ITEM ERROR:", err);
      res.status(500).json({ error: "Failed to update item" });
    }
  },
);

app.get("/system/tables", authMiddleware, async (req, res) => {
  res.json([
    { key: "cash_in", label: "وارد" },
    { key: "cash_out", label: "منصرف" },
    { key: "invoice_items", label: "عناصر الفواتير" },
    { key: "invoices", label: "الفواتير" },
    { key: "stock", label: "المخزون" },
    { key: "stock_movements", label: "حركات المخزون" },
    { key: "stock_transfer_items", label: "عناصر التحويلات" },
    { key: "stock_transfers", label: "تحويلات المخزون" },
  ]);
});

app.post("/system/factory-reset", authMiddleware, async (req, res) => {
  const client = await pool.connect();
  const { tables } = req.body;

  if (!Array.isArray(tables) || tables.length === 0) {
    return res.status(400).json({ error: "لم يتم تحديد جداول" });
  }

  // ✅ الجداول المسموح بمسحها فقط
  const allowedTables = [
    "cash_in",
    "cash_out",
    "invoice_items",
    "invoices",
    "stock",
    "stock_movements",
    "stock_transfer_items",
    "stock_transfers",
    "product_variants",
    "products",
  ];

  // ✅ فلترة الجداول القادمة من الفرونت
  const safeTables = tables.filter((t) => allowedTables.includes(t));

  if (safeTables.length === 0) {
    return res.status(400).json({ error: "لا توجد جداول صالحة للمسح" });
  }

  try {
    await client.query("BEGIN");

    // 🧹 الخزنة أولاً (قد تشير لفواتير)
    if (safeTables.includes("cash_in")) {
      await client.query("DELETE FROM cash_in");
    }

    if (safeTables.includes("cash_out")) {
      await client.query("DELETE FROM cash_out");
    }

    // 🧹 الفواتير
    if (safeTables.includes("invoice_items")) {
      await client.query("DELETE FROM invoice_items");
    }

    if (safeTables.includes("invoices")) {
      await client.query("DELETE FROM invoices");
    }

    // 🧹 التحويلات
    if (safeTables.includes("stock_transfer_items")) {
      await client.query("DELETE FROM stock_transfer_items");
    }

    if (safeTables.includes("stock_transfers")) {
      await client.query("DELETE FROM stock_transfers");
    }

    // 🧹 المخزون
    if (safeTables.includes("stock_movements")) {
      await client.query("DELETE FROM stock_movements");
    }

    if (safeTables.includes("stock")) {
      // نصفر الكميات بدل ما نحذف السجلات
      await client.query("UPDATE stock SET quantity = 0");
    }

    // 🧹 الأصناف (الأكواد الفرعية أولاً ثم الأصناف)
    if (safeTables.includes("product_variants")) {
      await client.query("DELETE FROM product_variants");
    }

    if (safeTables.includes("products")) {
      await client.query("DELETE FROM products");
    }

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "تم مسح البيانات المحددة بنجاح",
      cleared_tables: safeTables, // 👈 مفيد للفرونت
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("FACTORY RESET ERROR:", err);
    res.status(500).json({ error: "فشل تنفيذ عملية المسح" });
  } finally {
    client.release();
  }
});

const bcrypt = require("bcrypt");

app.post("/users", authMiddleware, async (req, res) => {
  try {
    const currentUser = await requireAdminUser(req, res);
    if (!currentUser) return;

    const { username, password, branch_id, full_name, role, permissions } =
      req.body;

    if (!username || !password || !branch_id) {
      return res.status(400).json({ error: "بيانات ناقصة" });
    }

    const branchIdNum = Number(branch_id);
    if (isNaN(branchIdNum) || branchIdNum <= 0) {
      return res.status(400).json({ error: "branch_id غير صالح" });
    }

    if (!canManageBranch(currentUser, branchIdNum)) {
      return res.status(403).json({ error: "غير مصرح بإدارة هذا الفرع" });
    }

    const safeRole = role === "admin" ? "admin" : "user";
    const safePermissions = normalizeUserPermissions(permissions);

    const hashedPassword = await bcrypt.hash(password, 10);

    await pool.query(
      `
      INSERT INTO users (username, password, branch_id, full_name, role, permissions)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      `,
      [
        username,
        hashedPassword,
        branchIdNum,
        full_name || "",
        safeRole,
        JSON.stringify(safePermissions),
      ],
    );

    res.json({ success: true });
  } catch (err) {
    console.error("CREATE USER ERROR:", err);

    if (err.code === "23505") {
      return res.status(400).json({ error: "اسم المستخدم مستخدم بالفعل" });
    }

    res.status(500).json({ error: "User creation error" });
  }
});

app.put("/users/theme", authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const { theme } = req.body;

  if (!["light", "dark", "system"].includes(theme)) {
    return res.status(400).json({ error: "قيمة ثيم غير صالحة" });
  }

  try {
    await pool.query("UPDATE users SET theme = $1 WHERE id = $2", [
      theme,
      userId,
    ]);

    res.json({ success: true });
  } catch (err) {
    console.error("SAVE THEME ERROR:", err);
    res.status(500).json({ error: "فشل حفظ الثيم" });
  }
});

/* ─── User Preferences (dashboard config, widgets, quick links, etc.) ─── */
app.get("/user/preferences", authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT preferences FROM users WHERE id = $1",
      [req.user.id],
    );
    if (rows.length === 0) return res.json({});
    res.json(rows[0].preferences || {});
  } catch (err) {
    console.error("GET PREFERENCES ERROR:", err);
    res.status(500).json({ error: "فشل جلب التفضيلات" });
  }
});

app.put("/user/preferences", authMiddleware, async (req, res) => {
  try {
    const prefs = req.body;
    if (!prefs || typeof prefs !== "object") {
      return res.status(400).json({ error: "بيانات غير صالحة" });
    }
    await pool.query("UPDATE users SET preferences = $1 WHERE id = $2", [
      JSON.stringify(prefs),
      req.user.id,
    ]);
    res.json({ success: true });
  } catch (err) {
    console.error("SAVE PREFERENCES ERROR:", err);
    res.status(500).json({ error: "فشل حفظ التفضيلات" });
  }
});

app.get("/users", authMiddleware, async (req, res) => {
  try {
    const currentUser = await requireAdminUser(req, res);
    if (!currentUser) return;

    const result = isSuperAdmin(currentUser)
      ? await pool.query(
          `
          SELECT id, username, branch_id, full_name, role, permissions
          FROM users
          ORDER BY id DESC
          `,
        )
      : await pool.query(
          `
          SELECT id, username, branch_id, full_name, role, permissions
          FROM users
          WHERE branch_id = $1
          ORDER BY id DESC
          `,
          [currentUser.branch_id],
        );

    res.json(
      result.rows.map((row) => ({
        ...row,
        role: row.role === "admin" ? "admin" : "user",
        permissions: normalizeUserPermissions(row.permissions),
      })),
    );
  } catch (err) {
    console.error("GET USERS ERROR:", err);
    res.status(500).json({ error: "فشل تحميل المستخدمين" });
  }
});

/* =========================
   �️ DELETE USER
========================= */
app.delete("/users/:id", authMiddleware, async (req, res) => {
  try {
    const currentUser = await requireAdminUser(req, res);
    if (!currentUser) return;

    const userId = Number(req.params.id);

    // لا يمكن حذف نفسك
    if (userId === currentUser.id) {
      return res.status(400).json({ error: "لا يمكنك حذف حسابك الحالي" });
    }

    const targetUser = await pool.query(
      `SELECT id, branch_id FROM users WHERE id = $1`,
      [userId],
    );

    if (!targetUser.rows.length) {
      return res.status(404).json({ error: "المستخدم غير موجود" });
    }

    if (userId === 7 && !isSuperAdmin(currentUser)) {
      return res.status(403).json({ error: "غير مصرح بحذف هذا المستخدم" });
    }

    if (!canManageBranch(currentUser, targetUser.rows[0].branch_id)) {
      return res.status(403).json({ error: "غير مصرح بإدارة هذا المستخدم" });
    }

    const result = await pool.query(
      "DELETE FROM users WHERE id = $1 RETURNING id",
      [userId],
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "المستخدم غير موجود" });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("DELETE USER ERROR:", err);
    res.status(500).json({ error: "فشل حذف المستخدم" });
  }
});

/* =========================
   🔑 CHANGE PASSWORD
========================= */
app.put("/users/:id/password", authMiddleware, async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const { current_password, new_password } = req.body;

    if (!current_password || !new_password) {
      return res.status(400).json({ error: "بيانات ناقصة" });
    }

    // تأكد إن اليوزر بيغير باسورد نفسه
    if (userId !== req.user.id) {
      return res.status(403).json({ error: "غير مصرح" });
    }

    const userResult = await pool.query(
      "SELECT password FROM users WHERE id = $1",
      [userId],
    );
    if (!userResult.rows.length) {
      return res.status(404).json({ error: "المستخدم غير موجود" });
    }

    const isMatch = await bcrypt.compare(
      current_password,
      userResult.rows[0].password,
    );
    if (!isMatch) {
      return res.status(400).json({ error: "كلمة المرور الحالية غير صحيحة" });
    }

    const hashedPassword = await bcrypt.hash(new_password, 10);
    await pool.query("UPDATE users SET password = $1 WHERE id = $2", [
      hashedPassword,
      userId,
    ]);

    res.json({ success: true });
  } catch (err) {
    console.error("CHANGE PASSWORD ERROR:", err);
    res.status(500).json({ error: "فشل تغيير كلمة المرور" });
  }
});

/* ========================= reset another user password ========================= */
app.put("/users/:id/reset-password", authMiddleware, async (req, res) => {
  try {
    const currentUser = await requireAdminUser(req, res);
    if (!currentUser) return;

    const userId = Number(req.params.id);
    const { new_password } = req.body;

    if (!new_password) {
      return res.status(400).json({ error: "أدخل كلمة المرور الجديدة" });
    }

    if (new_password.length < 4) {
      return res
        .status(400)
        .json({ error: "كلمة المرور يجب أن تكون 4 أحرف على الأقل" });
    }

    const userResult = await pool.query(
      "SELECT id, branch_id FROM users WHERE id = $1",
      [userId],
    );
    if (!userResult.rows.length) {
      return res.status(404).json({ error: "المستخدم غير موجود" });
    }

    if (userId === 7 && !isSuperAdmin(currentUser)) {
      return res.status(403).json({ error: "غير مصرح بإدارة هذا المستخدم" });
    }

    if (!canManageBranch(currentUser, userResult.rows[0].branch_id)) {
      return res.status(403).json({ error: "غير مصرح بإدارة هذا المستخدم" });
    }

    const hashedPassword = await bcrypt.hash(new_password, 10);
    await pool.query("UPDATE users SET password = $1 WHERE id = $2", [
      hashedPassword,
      userId,
    ]);

    res.json({ success: true });
  } catch (err) {
    console.error("RESET PASSWORD ERROR:", err);
    res.status(500).json({ error: "فشل إعادة تعيين كلمة المرور" });
  }
});

app.put("/users/:id/access", authMiddleware, async (req, res) => {
  try {
    const currentUser = await requireAdminUser(req, res);
    if (!currentUser) return;

    const userId = Number(req.params.id);
    const { full_name, branch_id, role, permissions } = req.body;

    if (userId === currentUser.id) {
      return res
        .status(400)
        .json({ error: "لا يمكنك تعديل صلاحيات حسابك الحالي" });
    }

    const branchIdNum = Number(branch_id);
    if (isNaN(branchIdNum) || branchIdNum <= 0) {
      return res.status(400).json({ error: "branch_id غير صالح" });
    }

    const targetUser = await pool.query(
      `SELECT id, branch_id FROM users WHERE id = $1`,
      [userId],
    );

    if (!targetUser.rows.length) {
      return res.status(404).json({ error: "المستخدم غير موجود" });
    }

    if (userId === 7 && !isSuperAdmin(currentUser)) {
      return res.status(403).json({ error: "غير مصرح بإدارة هذا المستخدم" });
    }

    if (
      !canManageBranch(currentUser, targetUser.rows[0].branch_id) ||
      !canManageBranch(currentUser, branchIdNum)
    ) {
      return res.status(403).json({ error: "غير مصرح بإدارة هذا الفرع" });
    }

    const safeRole = role === "admin" ? "admin" : "user";
    const safePermissions = normalizeUserPermissions(permissions);

    const result = await pool.query(
      `
      UPDATE users
      SET full_name = $1,
          branch_id = $2,
          role = $3,
          permissions = $4::jsonb
      WHERE id = $5
      RETURNING id, username, branch_id, full_name, role, permissions
      `,
      [
        (full_name || "").trim(),
        branchIdNum,
        safeRole,
        JSON.stringify(safePermissions),
        userId,
      ],
    );

    res.json({
      success: true,
      user: {
        ...result.rows[0],
        role: result.rows[0].role === "admin" ? "admin" : "user",
        permissions: normalizeUserPermissions(result.rows[0].permissions),
      },
    });
  } catch (err) {
    console.error("UPDATE USER ACCESS ERROR:", err);
    res.status(500).json({ error: "فشل تحديث بيانات المستخدم" });
  }
});

/* ========================= update username ========================= */
app.put("/users/:id/username", authMiddleware, async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const { new_username } = req.body;

    if (!new_username || !new_username.trim()) {
      return res.status(400).json({ error: "أدخل اسم المستخدم الجديد" });
    }

    // يحق للمستخدم فقط تغيير اسمه
    if (userId !== req.user.id) {
      return res.status(403).json({ error: "غير مصرح" });
    }

    // تأكد مفيش يوزر تاني بنفس الاسم
    const existing = await pool.query(
      "SELECT id FROM users WHERE username = $1 AND id != $2",
      [new_username.trim(), userId],
    );
    if (existing.rows.length) {
      return res.status(400).json({ error: "اسم المستخدم موجود بالفعل" });
    }

    await pool.query("UPDATE users SET username = $1 WHERE id = $2", [
      new_username.trim(),
      userId,
    ]);

    res.json({ success: true, username: new_username.trim() });
  } catch (err) {
    console.error("UPDATE USERNAME ERROR:", err);
    res.status(500).json({ error: "فشل تحديث اسم المستخدم" });
  }
});

/* =========================
   ✏️ UPDATE FULL NAME
========================= */
app.put("/users/:id/full-name", authMiddleware, async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const { full_name } = req.body;

    // يحق للمستخدم فقط تغيير اسمه الكامل
    if (userId !== req.user.id) {
      return res.status(403).json({ error: "غير مصرح" });
    }

    await pool.query("UPDATE users SET full_name = $1 WHERE id = $2", [
      (full_name || "").trim(),
      userId,
    ]);

    res.json({ success: true, full_name: (full_name || "").trim() });
  } catch (err) {
    console.error("UPDATE FULL NAME ERROR:", err);
    res.status(500).json({ error: "فشل تحديث الاسم" });
  }
});

/* =========================
   �📦 CREATE BACKUP
========================= */
app.post("/system/backup", authMiddleware, async (req, res) => {
  try {
    const backupDir = path.join(__dirname, "backups");
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir);

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupFile = `backup-${timestamp}.sql`;
    const backupPath = path.join(backupDir, backupFile);

    const cmd = `pg_dump "${process.env.DATABASE_URL}?sslmode=require" -f "${backupPath}"`;

    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        console.error("BACKUP ERROR:", stderr);
        return res.status(500).json({ error: "فشل إنشاء النسخة الاحتياطية" });
      }

      res.json({ success: true, file: backupFile });
    });
  } catch (err) {
    console.error("BACKUP CATCH ERROR:", err);
    res.status(500).json({ error: "Backup failed" });
  }
});

/* =========================
   📂 LIST BACKUPS
========================= */
app.get("/system/backups", authMiddleware, (req, res) => {
  try {
    const backupDir = path.join(__dirname, "backups");

    if (!fs.existsSync(backupDir)) {
      return res.json([]);
    }

    const files = fs
      .readdirSync(backupDir)
      .filter((f) => f.endsWith(".sql"))
      .sort(
        (a, b) =>
          fs.statSync(path.join(backupDir, b)).mtimeMs -
          fs.statSync(path.join(backupDir, a)).mtimeMs,
      );

    res.json(files);
  } catch (err) {
    console.error("LIST BACKUPS ERROR:", err);
    res.status(500).json({ error: "فشل تحميل النسخ الاحتياطية" });
  }
});

/* =========================
   ♻️ RESTORE BACKUP
========================= */
app.post("/system/restore", authMiddleware, (req, res) => {
  const { file } = req.body;

  if (!file) return res.status(400).json({ error: "اسم الملف مطلوب" });

  const backupDir = path.join(__dirname, "backups");

  // حماية من path traversal
  const safeFile = path.basename(file);
  const backupPath = path.join(backupDir, safeFile);

  if (!fs.existsSync(backupPath)) {
    return res.status(404).json({ error: "الملف غير موجود" });
  }

  // يمسح الداتا القديمة ويرجع الاستعادة نظيفة
  const cmd = `
  psql -U ${process.env.DB_USER} -h ${process.env.DB_HOST} -p ${process.env.DB_PORT} -d ${process.env.DB_NAME} -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" &&
  psql -U ${process.env.DB_USER} -h ${process.env.DB_HOST} -p ${process.env.DB_PORT} ${process.env.DB_NAME} < "${backupPath}"
  `;

  exec(
    cmd,
    { env: { ...process.env, PGPASSWORD: process.env.DB_PASSWORD } },
    (error) => {
      if (error) {
        console.error("RESTORE ERROR:", error);
        return res.status(500).json({ error: "فشل استعادة النسخة" });
      }

      res.json({ success: true });
    },
  );
});

/* =========================
   ⬇️ DOWNLOAD BACKUP
========================= */
app.get("/system/backup/download/:file", authMiddleware, (req, res) => {
  const backupDir = path.join(__dirname, "backups");

  // حماية من path traversal
  const safeFile = path.basename(req.params.file);
  const filePath = path.join(backupDir, safeFile);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "الملف غير موجود" });
  }

  res.download(filePath);
});

const jwt = require("jsonwebtoken");

app.post("/login", async (req, res) => {
  try {
    

    const { username, password } = req.body;

    const result = await pool.query(`SELECT * FROM users WHERE username = $1`, [
      username,
    ]);

    if (!result.rows.length) {
      return res.status(400).json({ error: "بيانات الدخول غير صحيحة" });
    }

    const user = result.rows[0];
    const role = user.role === "admin" ? "admin" : "user";
    const permissions = normalizeUserPermissions(user.permissions);

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(400).json({ error: "بيانات الدخول غير صحيحة" });
    }

    const token = jwt.sign(
      {
        id: user.id,
        branch_id: user.branch_id,
        username: user.username,
        role,
        permissions,
      },
      process.env.JWT_SECRET,
      { expiresIn: "7d" },
    );

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        branch_id: user.branch_id,
        theme: user.theme,
        full_name: user.full_name || "",
        role,
        permissions,
      },
    });

    // 📝 تسجيل دخول اليوزر (بدون انتظار)
    pool
      .query(
        `INSERT INTO user_activity (user_id, username, action, ip_address)
       VALUES ($1, $2, 'login', $3)`,
        [user.id, user.username, req.headers["x-forwarded-for"] || req.ip],
      )
      .catch((e) => console.error("LOG LOGIN ERR:", e.message));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: `Login error: ${err.message}` });
  }
});

/* =========================
   📝 LOG LOGOUT
========================= */
app.post("/logout", authMiddleware, async (req, res) => {
  try {
    await pool.query(
      `INSERT INTO user_activity (user_id, username, action, ip_address)
       VALUES ($1, $2, 'logout', $3)`,
      [
        req.user.id,
        req.user.username,
        req.headers["x-forwarded-for"] || req.ip,
      ],
    );
    res.json({ success: true });
  } catch (err) {
    console.error("LOG LOGOUT ERR:", err);
    res.json({ success: true }); // مش نوقف اللوجاوت بسبب خطأ في التسجيل
  }
});

/* =========================
   📋 GET USER ACTIVITY LOG
========================= */
app.get("/user-activity", authMiddleware, async (req, res) => {
  try {
    const { limit = 50 } = req.query;
    const result = await pool.query(
      `SELECT id, user_id, username, action, ip_address, created_at
       FROM user_activity
       ORDER BY created_at DESC
       LIMIT $1`,
      [Number(limit)],
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET ACTIVITY ERR:", err);
    res.status(500).json({ error: "فشل تحميل سجل النشاط" });
  }
});

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader) return res.status(401).json({ error: "Unauthorized" });

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Token غير صالح" });
  }
}

app.get("/auth/me", authMiddleware, async (req, res) => {
  try {
    const currentUser = await loadCurrentUserAccess(req);

    res.json({
      user: {
        id: currentUser.id,
        username: currentUser.username,
        branch_id: currentUser.branch_id,
        full_name: currentUser.full_name || "",
        role: currentUser.role,
        permissions: currentUser.permissions,
        theme: currentUser.theme || "system",
      },
    });
  } catch (err) {
    console.error("AUTH ME ERROR:", err);
    res.status(500).json({ error: "فشل تحميل بيانات المستخدم" });
  }
});

/* ===============================
   🔀 SWITCH BRANCH (Admin Only)
================================ */
app.post("/auth/switch-branch", authMiddleware, async (req, res) => {
  try {
    if (req.user.username !== 'admin') {
      return res.status(403).json({ error: "غير مصرح لك بتبديل الفرع" });
    }
    
    const { target_branch_id } = req.body;
    if (!target_branch_id) {
      return res.status(400).json({ error: "يجب تحديد الفرع المطلوب" });
    }

    await pool.query('UPDATE users SET branch_id = $1 WHERE id = $2', [target_branch_id, req.user.id]);
    
    res.json({ success: true });
  } catch (err) {
    console.error("SWITCH BRANCH ERROR:", err);
    res.status(500).json({ error: "فشل في تبديل الفرع" });
  }
});

/* ===============================
   🔔 NOTIFICATIONS - جلب إشعارات الفرع
================================ */
app.get("/notifications", authMiddleware, async (req, res) => {
  try {
    const branch_id = req.user.branch_id;
    const { unread_only } = req.query;

    let query = `
      SELECT n.id, n.title, n.message, n.type, n.reference_id, n.is_read, n.created_at
      FROM notifications n
      JOIN users u ON u.id = n.from_user_id
      WHERE n.to_branch_id = $1
        AND (u.branch_id != $1 OR u.branch_id IS NULL)
    `;
    const values = [branch_id];

    if (unread_only === "true") {
      query += ` AND is_read = false`;
    }

    query += ` ORDER BY created_at DESC LIMIT 50`;

    const result = await pool.query(query, values);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error("GET NOTIFICATIONS ERROR:", err);
    res.status(500).json({ error: "فشل تحميل الإشعارات" });
  }
});

/* ===============================
   🔔 NOTIFICATIONS - عدد غير المقروءة
================================ */
app.get("/notifications/unread-count", authMiddleware, async (req, res) => {
  try {
    const branch_id = req.user.branch_id;
    const result = await pool.query(
      `SELECT COUNT(*) AS count FROM notifications n
       JOIN users u ON u.id = n.from_user_id
       WHERE n.to_branch_id = $1 AND n.is_read = false AND (u.branch_id != $1 OR u.branch_id IS NULL)`,
      [branch_id],
    );
    res.json({ success: true, count: parseInt(result.rows[0].count) });
  } catch (err) {
    console.error("UNREAD COUNT ERROR:", err);
    res.status(500).json({ error: "خطأ" });
  }
});

/* ===============================
   🔔 NOTIFICATIONS - تعليم الكل كمقروء
================================ */
app.put("/notifications/read-all", authMiddleware, async (req, res) => {
  try {
    await pool.query(
      `UPDATE notifications SET is_read = true WHERE to_branch_id = $1 AND is_read = false`,
      [req.user.branch_id],
    );
    res.json({ success: true });
  } catch (err) {
    console.error("READ ALL ERROR:", err);
    res.status(500).json({ error: "خطأ" });
  }
});

/* ===============================
   🔔 NOTIFICATIONS - تعليم كمقروء
================================ */
app.put("/notifications/:id/read", authMiddleware, async (req, res) => {
  try {
    await pool.query(
      `UPDATE notifications SET is_read = true WHERE id = $1 AND to_branch_id = $2`,
      [req.params.id, req.user.branch_id],
    );
    res.json({ success: true });
  } catch (err) {
    console.error("MARK READ ERROR:", err);
    res.status(500).json({ error: "خطأ" });
  }
});

/* ===============================
   💬 CHAT SYSTEM - Tables (sequential)
================================ */
if (process.env.ENABLE_STARTUP_MIGRATIONS === "true") {
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id SERIAL PRIMARY KEY,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log("✅ conversations table ready");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS conversation_participants (
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        PRIMARY KEY (conversation_id, user_id)
      )
    `);
    console.log("✅ conversation_participants table ready");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        is_read BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log("✅ messages table ready");

    // Add type and file_url columns if they don't exist
    await pool.query(
      `ALTER TABLE messages ADD COLUMN IF NOT EXISTS type VARCHAR(20) DEFAULT 'text'`,
    );
    await pool.query(
      `ALTER TABLE messages ADD COLUMN IF NOT EXISTS file_url TEXT`,
    );
    await pool.query(`ALTER TABLE messages ALTER COLUMN content DROP NOT NULL`);
    await pool.query(
      `ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_id INTEGER REFERENCES messages(id)`,
    );
    console.log("✅ messages columns updated (type, file_url, reply_to_id)");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS chat_attachments (
        id SERIAL PRIMARY KEY,
        message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
        storage_key TEXT NOT NULL UNIQUE,
        original_name TEXT,
        mime_type TEXT NOT NULL,
        file_size INTEGER NOT NULL DEFAULT 0,
        file_data BYTEA NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log("✅ chat_attachments table ready");

    // Push subscriptions table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log("✅ push_subscriptions table ready");

    // --- Branch Connections Schema ---
    await pool.query(`
      CREATE TABLE IF NOT EXISTS branch_connections (
          id SERIAL PRIMARY KEY,
          branch_name VARCHAR(255) NOT NULL,
          remote_url VARCHAR(255) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log("✅ branch_connections table ready");

    // --- Inter-Branch Transfer Portal Schema ---
    await pool.query(`
      CREATE TABLE IF NOT EXISTS inter_branch_transfers (
        id SERIAL PRIMARY KEY,
        transfer_uuid VARCHAR(255) NOT NULL UNIQUE,
        direction VARCHAR(50) NOT NULL, -- 'inbound' or 'outbound'
        status VARCHAR(50) NOT NULL, -- 'pending_dispatch', 'in_transit', 'received', 'cancelled', 'rejected'
        remote_branch_url VARCHAR(255) NOT NULL,
        total_value DECIMAL(12,2) DEFAULT 0.00,
        total_cost DECIMAL(12,2) DEFAULT 0.00,
        created_at TIMESTAMP DEFAULT NOW(),
        dispatched_at TIMESTAMP,
        received_at TIMESTAMP
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS inter_branch_transfer_items (
        id SERIAL PRIMARY KEY,
        transfer_id INTEGER NOT NULL REFERENCES inter_branch_transfers(id) ON DELETE CASCADE,
        barcode VARCHAR(255),
        product_name VARCHAR(255),
        quantity DECIMAL(10,2) NOT NULL,
        transfer_price DECIMAL(10,2) NOT NULL,
        original_cost DECIMAL(10,2) NOT NULL
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS external_branches_ledger (
        id SERIAL PRIMARY KEY,
        remote_branch_url VARCHAR(255) NOT NULL,
        transfer_id INTEGER REFERENCES inter_branch_transfers(id) ON DELETE SET NULL,
        amount DECIMAL(12,2) NOT NULL, -- Positive = Credit (We are owed), Negative = Debit (We owe them)
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log("✅ Inter-Branch Portal tables ready");

    // --- App settings (key/value) — يُستخدم للرصيد الافتتاحي لمديونية المخزن ---
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key        VARCHAR(100) PRIMARY KEY,
        value      TEXT,
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log("✅ app_settings table ready");
  } catch (e) {
    console.error("❌ chat tables error:", e.message);
  }
})();
}

/* ===============================
   💬 CHAT - Get all conversations for current user
================================ */
app.get("/chat/conversations", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await pool.query(
      `
      SELECT c.id, c.updated_at,
        (
          SELECT json_build_object('id', u2.id, 'username', u2.username, 'full_name', u2.full_name, 'branch_id', u2.branch_id)
          FROM conversation_participants cp2
          JOIN users u2 ON u2.id = cp2.user_id
          WHERE cp2.conversation_id = c.id AND cp2.user_id != $1
          LIMIT 1
        ) AS other_user,
        (
          SELECT json_build_object('content', m.content, 'created_at', m.created_at, 'sender_id', m.sender_id, 'type', m.type, 'file_url', m.file_url)
          FROM messages m
          WHERE m.conversation_id = c.id
          ORDER BY m.created_at DESC LIMIT 1
        ) AS last_message,
        (
          SELECT COUNT(*)::int
          FROM messages m
          WHERE m.conversation_id = c.id AND m.sender_id != $1 AND m.is_read = false
        ) AS unread_count
      FROM conversations c
      JOIN conversation_participants cp ON cp.conversation_id = c.id AND cp.user_id = $1
      ORDER BY c.updated_at DESC
    `,
      [userId],
    );

    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error("GET CONVERSATIONS ERROR:", err);
    res.status(500).json({ error: "فشل تحميل المحادثات" });
  }
});

/* ===============================
   💬 CHAT - Get or create conversation with a user
================================ */
app.post("/chat/conversations", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { other_user_id } = req.body;

    if (!other_user_id || other_user_id === userId) {
      return res.status(400).json({ error: "يوزر غير صالح" });
    }

    // Check if conversation already exists between these two users
    const existing = await pool.query(
      `
      SELECT cp1.conversation_id
      FROM conversation_participants cp1
      JOIN conversation_participants cp2 ON cp2.conversation_id = cp1.conversation_id
      WHERE cp1.user_id = $1 AND cp2.user_id = $2
      LIMIT 1
    `,
      [userId, other_user_id],
    );

    if (existing.rows.length > 0) {
      return res.json({
        success: true,
        conversation_id: existing.rows[0].conversation_id,
      });
    }

    // Create new conversation
    const conv = await pool.query(
      "INSERT INTO conversations DEFAULT VALUES RETURNING id",
    );
    const convId = conv.rows[0].id;

    await pool.query(
      "INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2), ($1, $3)",
      [convId, userId, other_user_id],
    );

    res.json({ success: true, conversation_id: convId });
  } catch (err) {
    console.error("CREATE CONVERSATION ERROR:", err);
    res.status(500).json({ error: "فشل إنشاء المحادثة" });
  }
});

/* ===============================
   💬 CHAT - Get messages for a conversation
================================ */
app.get(
  "/chat/conversations/:id/messages",
  authMiddleware,
  async (req, res) => {
    try {
      const userId = req.user.id;
      const convId = Number(req.params.id);

      // Verify user is a participant
      const participant = await pool.query(
        "SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2",
        [convId, userId],
      );
      if (!participant.rows.length) {
        return res.status(403).json({ error: "غير مصرح" });
      }

      // Mark messages as read
      await pool.query(
        "UPDATE messages SET is_read = true WHERE conversation_id = $1 AND sender_id != $2 AND is_read = false",
        [convId, userId],
      );

      const result = await pool.query(
        `
      SELECT m.id, m.content, m.sender_id, m.is_read, m.created_at,
             m.type, m.file_url, m.reply_to_id,
             u.username, u.full_name,
             rm.content AS reply_content,
             rm.sender_id AS reply_sender_id,
             ru.full_name AS reply_sender_name,
             rm.type AS reply_type
      FROM messages m
      JOIN users u ON u.id = m.sender_id
      LEFT JOIN messages rm ON rm.id = m.reply_to_id
      LEFT JOIN users ru ON ru.id = rm.sender_id
      WHERE m.conversation_id = $1
      ORDER BY m.created_at ASC
    `,
        [convId],
      );

      res.json({ success: true, data: result.rows });
    } catch (err) {
      console.error("GET MESSAGES ERROR:", err);
      res.status(500).json({ error: "فشل تحميل الرسايل" });
    }
  },
);

app.get("/chat/media/:storageKey", async (req, res) => {
  try {
    const storageKey = String(req.params.storageKey || "").trim();
    if (!storageKey) {
      return res.status(400).send("Invalid media key");
    }

    const attachmentRes = await pool.query(
      `
      SELECT mime_type, original_name, file_data
      FROM chat_attachments
      WHERE storage_key = $1
      LIMIT 1
      `,
      [storageKey],
    );

    if (!attachmentRes.rows.length) {
      return res.status(404).send("Media not found");
    }

    const attachment = attachmentRes.rows[0];
    const mimeType = attachment.mime_type || "application/octet-stream";
    const originalName = attachment.original_name || "file";
    const disposition = mimeType.startsWith("image/") ? "inline" : "attachment";

    res.setHeader("Content-Type", mimeType);
    res.setHeader(
      "Content-Disposition",
      `${disposition}; filename*=UTF-8''${encodeURIComponent(originalName)}`,
    );
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.send(attachment.file_data);
  } catch (err) {
    console.error("CHAT MEDIA ERROR:", err);
    res.status(500).send("Failed to load media");
  }
});

/* ===============================
   💬 CHAT - Upload file/image for chat
================================ */
app.post(
  "/chat/conversations/:id/upload",
  authMiddleware,
  chatUpload.single("file"),
  async (req, res) => {
    try {
      const userId = req.user.id;
      const convId = Number(req.params.id);

      if (!req.file) {
        return res.status(400).json({ error: "لم يتم رفع ملف" });
      }

      // Verify participant
      const participant = await pool.query(
        "SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2",
        [convId, userId],
      );
      if (!participant.rows.length) {
        return res.status(403).json({ error: "غير مصرح" });
      }

      const storageKey = crypto.randomBytes(24).toString("hex");
      const fileUrl = `/chat/media/${storageKey}`;
      const isImage = req.file.mimetype.startsWith("image/");
      const msgType = isImage ? "image" : "file";
      const caption = String(req.body?.content || "").trim();
      const replyToId = Number(req.body?.reply_to_id || 0) || null;
      const storedContent = isImage
        ? caption
        : caption || req.file.originalname;

      const msgResult = await pool.query(
        "INSERT INTO messages (conversation_id, sender_id, content, type, file_url, reply_to_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *",
        [convId, userId, storedContent, msgType, fileUrl, replyToId],
      );

      await pool.query(
        `
        INSERT INTO chat_attachments
          (message_id, storage_key, original_name, mime_type, file_size, file_data)
        VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [
          msgResult.rows[0].id,
          storageKey,
          req.file.originalname,
          req.file.mimetype,
          Number(req.file.size || 0),
          req.file.buffer,
        ],
      );

      await pool.query(
        "UPDATE conversations SET updated_at = NOW() WHERE id = $1",
        [convId],
      );

      const senderResult = await pool.query(
        "SELECT username, full_name FROM users WHERE id = $1",
        [userId],
      );

      const message = {
        ...msgResult.rows[0],
        username: senderResult.rows[0].username,
        full_name: senderResult.rows[0].full_name,
      };

      if (replyToId) {
        const replyResult = await pool.query(
          "SELECT m.content, m.sender_id, m.type, u.full_name FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = $1",
          [replyToId],
        );
        if (replyResult.rows.length) {
          message.reply_content = replyResult.rows[0].content;
          message.reply_sender_id = replyResult.rows[0].sender_id;
          message.reply_sender_name = replyResult.rows[0].full_name;
          message.reply_type = replyResult.rows[0].type;
        }
      }

      const otherUser = await pool.query(
        "SELECT user_id FROM conversation_participants WHERE conversation_id = $1 AND user_id != $2",
        [convId, userId],
      );

      const io = req.app.get("io");
      if (io && otherUser.rows.length) {
        const otherUserId = otherUser.rows[0].user_id;
        io.to(`user_${otherUserId}`).emit("new_message", {
          conversation_id: convId,
          message,
        });
      }

      // Send push notification to other user
      if (otherUser.rows.length) {
        sendPushToUser(
          otherUser.rows[0].user_id,
          message.full_name || message.username,
          isImage ? (caption ? `📷 ${caption}` : "📷 صورة") : "📄 ملف",
          convId,
        );
      }

      res.json({ success: true, data: message });
    } catch (err) {
      console.error("CHAT UPLOAD ERROR:", err);
      res.status(500).json({ error: "فشل رفع الملف" });
    }
  },
);

/* ===============================
   💬 CHAT - Send a message
================================ */
app.post(
  "/chat/conversations/:id/messages",
  authMiddleware,
  async (req, res) => {
    try {
      const userId = req.user.id;
      const convId = Number(req.params.id);
      const { content, reply_to_id } = req.body;

      if (!content || !content.trim()) {
        return res.status(400).json({ error: "الرسالة فاضية" });
      }

      // Verify user is a participant
      const participant = await pool.query(
        "SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2",
        [convId, userId],
      );
      if (!participant.rows.length) {
        return res.status(403).json({ error: "غير مصرح" });
      }

      // Insert message
      const msgResult = await pool.query(
        "INSERT INTO messages (conversation_id, sender_id, content, reply_to_id) VALUES ($1, $2, $3, $4) RETURNING *",
        [convId, userId, content.trim(), reply_to_id || null],
      );

      // Update conversation timestamp
      await pool.query(
        "UPDATE conversations SET updated_at = NOW() WHERE id = $1",
        [convId],
      );

      // Get sender info
      const senderResult = await pool.query(
        "SELECT username, full_name FROM users WHERE id = $1",
        [userId],
      );

      const message = {
        ...msgResult.rows[0],
        username: senderResult.rows[0].username,
        full_name: senderResult.rows[0].full_name,
      };

      // If replying, attach reply info
      if (reply_to_id) {
        const replyResult = await pool.query(
          "SELECT m.content, m.sender_id, m.type, u.full_name FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = $1",
          [reply_to_id],
        );
        if (replyResult.rows.length) {
          message.reply_content = replyResult.rows[0].content;
          message.reply_sender_id = replyResult.rows[0].sender_id;
          message.reply_sender_name = replyResult.rows[0].full_name;
          message.reply_type = replyResult.rows[0].type;
        }
      }

      // Get other participant to send real-time notification
      const otherUser = await pool.query(
        "SELECT user_id FROM conversation_participants WHERE conversation_id = $1 AND user_id != $2",
        [convId, userId],
      );

      // Emit to the other user via socket
      const io = req.app.get("io");
      if (io && otherUser.rows.length) {
        const otherUserId = otherUser.rows[0].user_id;
        io.to(`user_${otherUserId}`).emit("new_message", {
          conversation_id: convId,
          message,
        });
      }

      // Send push notification to other user
      if (otherUser.rows.length) {
        const preview =
          content.trim().length > 80
            ? content.trim().substring(0, 80) + "..."
            : content.trim();
        sendPushToUser(
          otherUser.rows[0].user_id,
          senderResult.rows[0].full_name,
          preview,
          convId,
        );
      }

      res.json({ success: true, data: message });
    } catch (err) {
      console.error("SEND MESSAGE ERROR:", err);
      res.status(500).json({ error: "فشل إرسال الرسالة" });
    }
  },
);

/* ===============================
   � PUSH - Helper: send push to user
================================ */
async function sendPushToBranch(targetBranchId, title, body, data = {}) {
  try {
    // Get all users in the target branch
    const usersRes = await pool.query(
      "SELECT id FROM users WHERE branch_id = $1",
      [targetBranchId],
    );
    for (const user of usersRes.rows) {
      const subs = await pool.query(
        "SELECT * FROM push_subscriptions WHERE user_id = $1",
        [user.id],
      );
      const payload = JSON.stringify({
        title,
        body,
        data: { ...data, url: "/" },
      });
      for (const sub of subs.rows) {
        const pushSub = {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        };
        try {
          await webPush.sendNotification(pushSub, payload);
        } catch (err) {
          if (err.statusCode === 410 || err.statusCode === 404) {
            await pool.query("DELETE FROM push_subscriptions WHERE id = $1", [
              sub.id,
            ]);
          }
        }
      }
    }
  } catch (err) {
    console.error("PUSH TO BRANCH ERROR:", err);
  }
}

async function sendPushToUser(targetUserId, senderName, body, convId) {
  try {
    const subs = await pool.query(
      "SELECT * FROM push_subscriptions WHERE user_id = $1",
      [targetUserId],
    );
    const payload = JSON.stringify({
      title: senderName,
      body,
      data: { conversation_id: convId, url: "/" },
    });
    for (const sub of subs.rows) {
      const pushSub = {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth },
      };
      try {
        await webPush.sendNotification(pushSub, payload);
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          await pool.query("DELETE FROM push_subscriptions WHERE id = $1", [
            sub.id,
          ]);
        }
      }
    }
  } catch (err) {
    console.error("PUSH NOTIFICATION ERROR:", err);
  }
}

/* ===============================
   🔔 PUSH - Get VAPID public key
================================ */
app.get("/push/vapid-key", (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

/* ===============================
   🔔 PUSH - Subscribe
================================ */
app.post("/push/subscribe", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { endpoint, keys } = req.body;
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ error: "بيانات الاشتراك ناقصة" });
    }
    await pool.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = $1, p256dh = $3, auth = $4`,
      [userId, endpoint, keys.p256dh, keys.auth],
    );
    res.json({ success: true });
  } catch (err) {
    console.error("PUSH SUBSCRIBE ERROR:", err);
    res.status(500).json({ error: "فشل تسجيل الاشتراك" });
  }
});

/* ===============================
   🔔 PUSH - Unsubscribe
================================ */
app.post("/push/unsubscribe", authMiddleware, async (req, res) => {
  try {
    const { endpoint } = req.body;
    await pool.query("DELETE FROM push_subscriptions WHERE endpoint = $1", [
      endpoint,
    ]);
    res.json({ success: true });
  } catch (err) {
    console.error("PUSH UNSUBSCRIBE ERROR:", err);
    res.status(500).json({ error: "فشل إلغاء الاشتراك" });
  }
});

/* ===============================
   🔊 SOUNDS - Upload custom notification sound
================================ */
app.post(
  "/sounds/upload",
  authMiddleware,
  soundUpload.single("file"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "لم يتم رفع ملف صوتي" });
      }
      const fileUrl = `/uploads/sounds/${req.file.filename}`;
      res.json({
        success: true,
        url: fileUrl,
        filename: req.file.filename,
        originalName: req.file.originalname,
      });
    } catch (err) {
      console.error("SOUND UPLOAD ERROR:", err);
      res.status(500).json({ error: "فشل رفع الملف الصوتي" });
    }
  },
);

/* ===============================
   🔊 SOUNDS - List uploaded sounds
================================ */
app.get("/sounds/list", authMiddleware, async (req, res) => {
  try {
    const soundsPath = path.join(__dirname, "uploads", "sounds");
    if (!fs.existsSync(soundsPath)) {
      return res.json({ sounds: [] });
    }
    const files = fs.readdirSync(soundsPath).filter((f) => {
      const ext = path.extname(f).toLowerCase();
      return [".mp3", ".wav", ".ogg", ".m4a", ".aac", ".webm"].includes(ext);
    });
    const sounds = files.map((f) => ({
      filename: f,
      url: `/uploads/sounds/${f}`,
    }));
    res.json({ sounds });
  } catch (err) {
    console.error("SOUNDS LIST ERROR:", err);
    res.status(500).json({ error: "فشل تحميل قائمة الأصوات" });
  }
});

/* ===============================
   �💬 CHAT - Total unread count
================================ */
app.get("/chat/unread-count", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await pool.query(
      `
      SELECT COUNT(*)::int AS count
      FROM messages m
      JOIN conversation_participants cp ON cp.conversation_id = m.conversation_id AND cp.user_id = $1
      WHERE m.sender_id != $1 AND m.is_read = false
    `,
      [userId],
    );
    res.json({ success: true, count: result.rows[0].count });
  } catch (err) {
    console.error("CHAT UNREAD COUNT ERROR:", err);
    res.status(500).json({ error: "خطأ" });
  }
});

/* ===============================
   💬 CHAT - Get all users (for starting new conversation)
================================ */
app.get("/chat/users", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await pool.query(
      "SELECT id, username, full_name, branch_id FROM users WHERE id != $1 ORDER BY full_name, username",
      [userId],
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error("GET CHAT USERS ERROR:", err);
    res.status(500).json({ error: "فشل تحميل المستخدمين" });
  }
});

/* ===============================
   🖨️ LOCAL PRINT SERVICE
================================ */
app.post("/print/invoice/:id", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const io = req.app.get("io");
    const token = req.headers.authorization?.split(" ")[1] || "";
    
    // Emit event to a dedicated room for local print services
    // The print service will listen to 'print-job' and process it
    io.emit("print-job", {
      type: "invoice",
      id: id,
      path: `/invoices/${id}/print-thermal`,
      token: token,
      timestamp: Date.now()
    });

    res.json({ success: true, message: "Print job sent successfully" });
  } catch (err) {
    console.error("PRINT INVOICE ERROR:", err);
    res.status(500).json({ error: "فشل إرسال أمر الطباعة" });
  }
});

app.post("/print/barcode/:id", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { count = 1 } = req.body;
    const io = req.app.get("io");
    const token = req.headers.authorization?.split(" ")[1] || "";
    
    io.emit("print-job", {
      type: "barcode",
      id: id,
      path: `/products/${id}/barcode-thermal?count=${count}`,
      token: token,
      timestamp: Date.now()
    });

    res.json({ success: true, message: "Barcode print job sent successfully" });
  } catch (err) {
    console.error("PRINT BARCODE ERROR:", err);
    res.status(500).json({ error: "فشل إرسال أمر طباعة الباركود" });
  }
});

// GET print settings
app.get("/settings/print-settings", authMiddleware, async (req, res) => {
  try {
    const id = req.user.branch_id;
    const result = await pool.query(`SELECT thermal_print_settings, barcode_print_settings FROM branches WHERE id = $1`, [id]);
    if (!result.rows.length) return res.status(404).json({ error: "الفرع غير موجود" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("GET PRINT SETTINGS ERR:", err);
    res.status(500).json({ error: "فشل جلب إعدادات الطباعة" });
  }
});

// POST print settings
app.post("/settings/print-settings", authMiddleware, async (req, res) => {
  try {
    const id = req.user.branch_id;
    const { type, settings } = req.body; // type: "thermal" or "barcode"
    
    if (type === "thermal") {
      await pool.query(`UPDATE branches SET thermal_print_settings = $1 WHERE id = $2`, [settings, id]);
    } else if (type === "barcode") {
      await pool.query(`UPDATE branches SET barcode_print_settings = $1 WHERE id = $2`, [settings, id]);
    } else {
      return res.status(400).json({ error: "نوع الإعدادات غير صحيح" });
    }
    
    res.json({ success: true, message: "تم حفظ الإعدادات بنجاح" });
  } catch (err) {
    console.error("POST PRINT SETTINGS ERR:", err);
    res.status(500).json({ error: "فشل حفظ إعدادات الطباعة" });
  }
});

/* ===============================
   🔌 SOCKET.IO
================================ */
const http = require("http");
const { Server } = require("socket.io");

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" },
});

// نخلي io متاح في أي مكان
app.set("io", io);

// ===== Simple in-memory cache to reduce DB load =====
const _cache = new Map();
function getCached(key, ttlMs, fetchFn) {
  const entry = _cache.get(key);
  if (entry && Date.now() - entry.ts < ttlMs)
    return Promise.resolve(entry.data);
  return fetchFn().then((data) => {
    _cache.set(key, { data, ts: Date.now() });
    return data;
  });
}
function clearCache(prefix) {
  for (const k of _cache.keys()) {
    if (k.startsWith(prefix)) _cache.delete(k);
  }
}

// Online users tracking: userId -> Set of socketIds
const onlineUsers = new Map();

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("register_user", async ({ user_id }) => {
    try {
      // 🧠 هات الفرع الحقيقي من الداتابيز
      const result = await pool.query(
        "SELECT branch_id FROM users WHERE id = $1",
        [user_id],
      );

      const branch_id = result.rows[0]?.branch_id;

      if (!branch_id) {
        console.log(`User ${user_id} has no branch_id`);
        return;
      }

      // 🧹 يخرج من أي رومات قديمة
      for (const room of socket.rooms) {
        if (room !== socket.id) socket.leave(room);
      }

      // ✅ يدخل روم الفرع الصح + روم اليوزر الشخصي (للشات)
      socket.join(`branch_${branch_id}`);
      socket.join(`user_${user_id}`);

      // Track online status
      socket.userId = user_id;
      if (!onlineUsers.has(user_id)) {
        onlineUsers.set(user_id, new Set());
      }
      onlineUsers.get(user_id).add(socket.id);

      // Broadcast to all that this user is online
      io.emit("user_online", { user_id });

      // Send current online users list to this socket
      const onlineIds = Array.from(onlineUsers.keys());
      socket.emit("online_users", { user_ids: onlineIds });

      console.log(
        `User ${user_id} joined branch_${branch_id} + user_${user_id} (online)`,
      );
    } catch (err) {
      console.error("Socket register error:", err);
    }
  });

  // 💬 Chat: typing indicator
  socket.on("chat_typing", ({ conversation_id, user_id, to_user_id }) => {
    io.to(`user_${to_user_id}`).emit("chat_typing", {
      conversation_id,
      user_id,
    });
  });

  socket.on("chat_stop_typing", ({ conversation_id, user_id, to_user_id }) => {
    io.to(`user_${to_user_id}`).emit("chat_stop_typing", {
      conversation_id,
      user_id,
    });
  });

  // 💬 Chat: mark messages as read in real-time
  socket.on(
    "chat_messages_read",
    ({ conversation_id, reader_id, to_user_id }) => {
      io.to(`user_${to_user_id}`).emit("chat_messages_read", {
        conversation_id,
        reader_id,
      });
    },
  );

  socket.on("disconnect", () => {
    const uid = socket.userId;
    if (uid && onlineUsers.has(uid)) {
      onlineUsers.get(uid).delete(socket.id);
      if (onlineUsers.get(uid).size === 0) {
        onlineUsers.delete(uid);
        // Broadcast to all that this user went offline
        io.emit("user_offline", { user_id: uid });
      }
    }
    console.log("User disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 3001;

async function runStartupMigrations() {
  const migrations = [
    {
      name: "customers.apply_items_discount",
      sql: `
        ALTER TABLE customers
        ADD COLUMN IF NOT EXISTS apply_items_discount BOOLEAN DEFAULT true
      `,
    },
    {
      name: "customers.is_market_customer",
      sql: `
        ALTER TABLE customers
        ADD COLUMN IF NOT EXISTS is_market_customer BOOLEAN DEFAULT false
      `,
    },
    {
      name: "invoices.invoice_revision",
      sql: `
        ALTER TABLE invoices
        ADD COLUMN IF NOT EXISTS invoice_revision INTEGER NOT NULL DEFAULT 0
      `,
    },
    {
      name: "invoices.hidden_from_list",
      sql: `
        ALTER TABLE invoices
        ADD COLUMN IF NOT EXISTS hidden_from_list BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS hidden_from_list_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS hidden_from_list_by TEXT
      `,
    },
    {
      name: "invoices.additional_amount",
      sql: `
        ALTER TABLE invoices
        ADD COLUMN IF NOT EXISTS additional_amount NUMERIC NOT NULL DEFAULT 0
      `,
    },
  ];

  for (const migration of migrations) {
    await runStartupSqlOnAllPools(migration.name, migration.sql);
  }
}

runStartupMigrations().finally(() => {
  app.get("/debug-notifications-xyz", async (req, res) => {
  try {
    const result = await pool.query("SELECT n.*, u.branch_id as sender_branch FROM notifications n JOIN users u ON u.id = n.from_user_id ORDER BY n.id DESC LIMIT 20");
    res.json(result.rows);
  } catch(e) { res.json({ error: e.message }); }
});

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server + Socket running on port ${PORT}`);
  });
});
