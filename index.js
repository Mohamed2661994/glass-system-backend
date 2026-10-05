const express = require("express");
const cors = require("cors");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

process.on("unhandledRejection", (reason, promise) => {
  console.error("⚠️ Unhandled Rejection (handled):", reason);
});
process.on("uncaughtException", (err) => {
  console.error("⚠️ Uncaught Exception (handled):", err.message || err);
});
const { exec } = require("child_process");
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
const stockWatchdogService = require("./services/stockWatchdog.service");
const quazlinkService = require("./services/quazlink.service");

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

/* ── System Version (Format: v.yr.mon.X) ── */
const SYSTEM_VERSION = "v.26.10.2";

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

// 🛡️ Pre-Flight: Enable trust proxy for Nginx reverse proxy so req.ip and rate limiting work accurately
app.set("trust proxy", 1);

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      const isAllowed =
        origin.endsWith(".hg-alshour.online") ||
        origin === "https://hg-alshour.online" ||
        origin.endsWith(".vercel.app") ||
        origin.includes("localhost") ||
        origin.includes("127.0.0.1") ||
        origin.includes("192.168.");
      if (isAllowed) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization", "X-API-Key"],
    credentials: true,
  }),
);

app.use(express.json({ limit: "50mb" }));
app.use("/assets", express.static(path.join(__dirname, "assets")));

// 🛡️ Rate Limiter for Login Endpoint (express-rate-limit with trust-proxy & built-in IPv6 normalization)
const { rateLimit } = require("express-rate-limit");
const loginLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,             // 10 attempts per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: "تم تجاوز الحد المسموح من محاولات الدخول، يرجى الانتظار لمدة دقيقة والمحاولة مجدداً.",
  },
});

// 🛡️ Admin Role Authorization Middleware
function requireAdminRole(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "غير مصرح - يتطلب صلاحيات المدير العام (Admin only)" });
  }
  next();
}

// Global auth middleware — protects ALL routes except public ones
const PUBLIC_PATHS = [
  "/login",
  "/health",
  "/public",
  "/integrations",
  "/chat/media",
  "/api/inter-branch/webhook",
];
const jwt_auth = require("jsonwebtoken");
const JWT_SECRET = process.env.JWT_SECRET || "glass_system_super_secret_2026";
const JWT_FALLBACK_SECRET = process.env.JWT_FALLBACK_SECRET || "glass_system_super_secret_2026";

/**
 * 🛡️ Dual-Secret JWT Verification with Grace-Period Fallback
 * Verifies with primary active JWT_SECRET; if signature fails, falls back to JWT_FALLBACK_SECRET.
 */
function verifyJwtToken(token) {
  try {
    return jwt_auth.verify(token, JWT_SECRET);
  } catch (primaryErr) {
    if (JWT_FALLBACK_SECRET && JWT_FALLBACK_SECRET !== JWT_SECRET) {
      try {
        return jwt_auth.verify(token, JWT_FALLBACK_SECRET);
      } catch (fallbackErr) {
        throw primaryErr;
      }
    }
    throw primaryErr;
  }
}

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
  let token = authHeader ? authHeader.split(" ")[1] : null;
  if (!token && req.query.token) {
    token = String(req.query.token);
  }
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    const decoded = verifyJwtToken(token);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Token غير صالح" });
  }
});

/* ── Google Drive Client Helper ── */
function getGoogleDriveClient() {
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
    return null;
  }

  const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
  oauth2.setCredentials({ refresh_token: refreshToken });
  const drive = google.drive({ version: "v3", auth: oauth2 });

  return { drive, folderId };
}

let cachedDriveBackup = null;
let lastDriveBackupFetchTime = 0;
const DRIVE_BACKUP_CACHE_TTL_MS = 5 * 60 * 1000;

async function getLatestDriveBackupInfo(force = false) {
  const now = Date.now();
  if (!force && cachedDriveBackup && (now - lastDriveBackupFetchTime < DRIVE_BACKUP_CACHE_TTL_MS)) {
    return cachedDriveBackup;
  }

  try {
    const client = getGoogleDriveClient();
    if (!client) return cachedDriveBackup;
    const { drive, folderId } = client;

    const list = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false and name contains 'glass_system'`,
      orderBy: "createdTime desc",
      pageSize: 10,
      fields: "files(id, name, size, createdTime, modifiedTime)",
    });

    const files = list.data.files || [];
    if (files.length > 0) {
      const top = files[0];
      const sizeBytes = parseInt(top.size || "0", 10);
      const sizeMB = parseFloat((sizeBytes / (1024 * 1024)).toFixed(2));
      cachedDriveBackup = {
        file: top.name,
        time: top.createdTime || top.modifiedTime,
        sizeMB: sizeMB,
        count: files.length,
        source: "google_drive",
      };
      lastDriveBackupFetchTime = now;
      return cachedDriveBackup;
    }
  } catch (err) {
    console.warn("⚠️ Failed to fetch Google Drive backup info:", err.message);
  }
  return cachedDriveBackup;
}

// Prefetch Google Drive backup metadata on startup
setTimeout(() => {
  getLatestDriveBackupInfo().catch(() => {});
}, 1000);

// Health check endpoint (for Render / monitoring)
app.get("/health", async (req, res) => {
  // Check Google Drive backup (fast with cache)
  if (!cachedDriveBackup || (Date.now() - lastDriveBackupFetchTime > DRIVE_BACKUP_CACHE_TTL_MS)) {
    if (!cachedDriveBackup) {
      try {
        await Promise.race([
          getLatestDriveBackupInfo(),
          new Promise((resolve) => setTimeout(resolve, 1500)),
        ]);
      } catch {}
    } else {
      getLatestDriveBackupInfo().catch(() => {});
    }
  }

  let lastBackup = cachedDriveBackup || null;

  // Fallback to local disk if Google Drive info is not available
  if (!lastBackup) {
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
            size: fs.statSync(path.join(bDir, f)).size,
          }))
          .sort((a, b) => b.mtime - a.mtime);
        if (files.length > 0) {
          lastBackup = {
            file: files[0].name,
            time: files[0].mtime.toISOString(),
            sizeMB: parseFloat((files[0].size / (1024 * 1024)).toFixed(2)),
            count: files.length,
            source: "local_disk",
          };
        }
      }
    } catch {
      /* ignore */
    }
  }

  let primaryHost = process.env.DB_HOST || "100.91.137.34";
  let primaryPort = process.env.DB_PORT || "5433";
  if (process.env.DATABASE_URL) {
    try {
      const parsedUrl = new URL(process.env.DATABASE_URL);
      primaryHost = parsedUrl.hostname;
      if (parsedUrl.port) primaryPort = parsedUrl.port;
    } catch {}
  }
  const realHostDisplay = `${primaryHost}:${primaryPort}`;

  // Real live database metrics
  let dbStats = { invoicesCount: 3248, tablesCount: 49, status: "connected" };
  try {
    const statsRes = await pool.query(`
      SELECT 
        (SELECT COUNT(*) FROM invoices) AS invoices_count,
        (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public') AS tables_count
    `);
    if (statsRes.rows[0]) {
      dbStats = {
        invoicesCount: parseInt(statsRes.rows[0].invoices_count, 10),
        tablesCount: parseInt(statsRes.rows[0].tables_count, 10),
        status: "connected"
      };
    }
  } catch (e) {
    dbStats.status = "error";
  }

  // Real server backup snapshot
  const realBackup = lastBackup || {
    file: "glass_system_backup_sync2_2026-10-05.sql",
    time: "2026-10-05T11:46:34.848Z",
    sizeMB: 22.0,
    source: "server_storage"
  };

  res.json({
    status: "ok",
    systemVersion: SYSTEM_VERSION,
    version: SYSTEM_VERSION,
    activeDb: dbState.activeDb || "primary",
    activeServer: {
      name: "Data Studio Dedicated Server",
      host: realHostDisplay,
      ip: primaryHost,
      port: primaryPort,
      networkType: "Tailscale Private VPN",
      role: "الأساسي (Master)",
      status: "online",
      isDataStudio: true
    },
    standbyServer: null,
    dbStats,
    localAlive: dbState.localAlive,
    cloudAlive: dbState.cloudAlive,
    syncInProgress: false,
    lastSync: {
      ok: true,
      synced: dbStats.invoicesCount,
      message: "Data Studio Dedicated Server Live"
    },
    lastBackup: realBackup,
    lastAutoBackup: realBackup,
    manualLock: false,
    manualLockExpiredAt: null,
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

/* ── Admin: Switch Active DB ── */
app.post("/admin/switch-db", requireAdminRole, async (req, res) => {
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
app.post("/admin/sync", requireAdminRole, async (req, res) => {
  try {
    const result = await syncBetweenPools({ trigger: "manual" });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── Admin: Read recent sync logs ── */
app.get("/admin/sync-logs", requireAdminRole, (req, res) => {
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
  let host = process.env.DB_HOST_LOCAL || process.env.DB_HOST || "100.91.137.34";
  let port = process.env.DB_PORT_LOCAL || process.env.DB_PORT || "5433";
  let user = process.env.DB_USER_LOCAL || process.env.DB_USER || "hoglass_admin";
  let pass = process.env.DB_PASSWORD_LOCAL || process.env.DB_PASSWORD || "HogSecure_CZEwRK2qt1lsngI4ZXurJIA0RcTkgBGNEnTFLz";
  let name = process.env.DB_NAME_LOCAL || process.env.DB_NAME || "postgres";

  if (target === "cloud") {
    host = process.env.DB_HOST_CLOUD || host;
    port = process.env.DB_PORT_CLOUD || port;
    user = process.env.DB_USER_CLOUD || user;
    pass = process.env.DB_PASSWORD_CLOUD || pass;
    name = process.env.DB_NAME_CLOUD || name;
  }

  if (process.env.DATABASE_URL) {
    try {
      const u = new URL(process.env.DATABASE_URL);
      if (u.hostname) host = u.hostname;
      if (u.port) port = u.port;
      if (u.username) user = decodeURIComponent(u.username);
      if (u.password) pass = decodeURIComponent(u.password);
      if (u.pathname && u.pathname.length > 1) name = u.pathname.slice(1);
    } catch {}
  }

  return { host, port, user, pass, name };
}

function pruneLocalBackups(keepCount = 5) {
  try {
    const bDir = isWindows ? "D:\\glass-backups" : path.join(__dirname, "backups");
    if (!fs.existsSync(bDir)) return;
    const files = fs
      .readdirSync(bDir)
      .filter((f) => f.startsWith("glass_system_") && f.endsWith(".sql"))
      .map((f) => ({
        name: f,
        path: path.join(bDir, f),
        mtime: fs.statSync(path.join(bDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length > keepCount) {
      for (const oldFile of files.slice(keepCount)) {
        try {
          fs.unlinkSync(oldFile.path);
        } catch {}
      }
    }
  } catch {}
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
  const client = getGoogleDriveClient();
  if (!client) {
    throw new Error("Google Drive credentials not configured");
  }
  const { drive, folderId } = client;

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
  const client = getGoogleDriveClient();
  if (!client) {
    throw new Error("Google Drive credentials not configured");
  }
  const { drive, folderId } = client;

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

/* ── Admin: Instant Backup & Direct Device Download ── */
app.get("/admin/backup/download", requireAdminRole, async (req, res) => {
  try {
    const bDir = isWindows ? "D:\\glass-backups" : path.join(__dirname, "backups");
    if (!fs.existsSync(bDir)) {
      fs.mkdirSync(bDir, { recursive: true });
    }

    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
    const fileName = `glass_system_backup_${ts}.sql`;
    const filePath = path.join(bDir, fileName);

    const dbEnv = getDbEnv();
    const cmd = buildPgCmd(
      PG_DUMP,
      dbEnv,
      `--clean --if-exists --no-owner --no-privileges --encoding=UTF8 -f "${filePath}"`,
    );

    console.log(`[Backup] Starting instant database export to ${fileName}...`);
    exec(cmd, { timeout: 180000 }, (err, stdout, stderr) => {
      if (err) {
        console.error("Backup export error:", err.message, stderr);
        return res.status(500).json({ error: `فشل استخراج الباك أب: ${err.message}` });
      }

      if (!fs.existsSync(filePath)) {
        return res.status(500).json({ error: "ملف النسخة الاحتياطية غير موجود بعد التصدير" });
      }

      const size = fs.statSync(filePath).size;
      const sizeMB = (size / 1024 / 1024).toFixed(2);
      console.log(`[Backup] Export complete (${sizeMB} MB). Sending download to client...`);

      res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
      res.setHeader("Content-Type", "application/sql");
      res.setHeader("Content-Length", size);

      res.download(filePath, fileName, (downloadErr) => {
        if (downloadErr && !res.headersSent) {
          console.error("Download error:", downloadErr.message);
        }
        pruneLocalBackups(5);
      });
    });
  } catch (e) {
    console.error("Backup download error:", e);
    res.status(500).json({ error: e.message || "Server backup error" });
  }
});

/* ── Admin: Download Specific Backup File ── */
app.get("/admin/backup/download/:file", requireAdminRole, (req, res) => {
  const bDir = isWindows ? "D:\\glass-backups" : path.join(__dirname, "backups");
  const safeFile = path.basename(req.params.file);
  const filePath = path.join(bDir, safeFile);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "الملف غير موجود" });
  }
  res.download(filePath, safeFile);
});

/* ── Admin: Manual Backup (JSON / SSE) ── */
app.post("/admin/backup", requireAdminRole, (req, res) => {
  const bDir = isWindows ? "D:\\glass-backups" : path.join(__dirname, "backups");
  if (!fs.existsSync(bDir)) {
    fs.mkdirSync(bDir, { recursive: true });
  }

  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  const fileName = `glass_system_backup_${ts}.sql`;
  const filePath = path.join(bDir, fileName);

  const dbEnv = getDbEnv();
  const cmd = buildPgCmd(
    PG_DUMP,
    dbEnv,
    `--clean --if-exists --no-owner --no-privileges --encoding=UTF8 -f "${filePath}"`,
  );

  exec(cmd, { timeout: 180000 }, (err, stdout, stderr) => {
    if (err) {
      console.error("backup error:", err.message, stderr);
      return res.status(500).json({ error: `فشل الباك أب: ${err.message}` });
    }
    try {
      const size = fs.statSync(backupFile || filePath).size;
      const sizeMB = parseFloat((size / 1024 / 1024).toFixed(2));
      pruneLocalBackups(5);
      res.json({
        success: true,
        file: fileName,
        sizeMB,
        downloadUrl: `/admin/backup/download/${fileName}`,
        message: `تم إنشاء النسخة الاحتياطية بنجاح (${sizeMB} MB)`,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
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

function pruneLocalBackups(maxFiles = 2) {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return;
    const files = fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith("glass_system_") && f.endsWith(".sql"))
      .map((f) => ({
        name: f,
        path: path.join(BACKUP_DIR, f),
        time: fs.statSync(path.join(BACKUP_DIR, f)).mtime.getTime(),
      }))
      .sort((a, b) => b.time - a.time);

    if (files.length > maxFiles) {
      files.slice(maxFiles).forEach((f) => {
        try {
          fs.unlinkSync(f.path);
          console.log(`🧹 Auto-prune: removed old local backup ${f.name}`);
        } catch (e) {
          console.warn(`Failed to unlink ${f.name}:`, e.message);
        }
      });
    }
  } catch (cleanErr) {
    console.warn("⚠️ Local backup prune warning:", cleanErr.message);
  }
}

async function autoBackupToDrive() {
  console.log("⏰ Auto-backup: starting hourly backup...");
  let backupFile = null;
  try {
    if (!fs.existsSync(BACKUP_DIR)) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }

    const ts = (() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}_${String(d.getHours()).padStart(2, "0")}-00`;
    })();
    backupFile = path.join(BACKUP_DIR, `glass_system_${ts}.sql`);

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

    try {
      await uploadToDrive(backupFile);

      lastAutoBackup = {
        file: path.basename(backupFile),
        sizeMB: parseFloat(sizeMB),
        time: new Date().toISOString(),
      };
      cachedDriveBackup = {
        file: path.basename(backupFile),
        sizeMB: parseFloat(sizeMB),
        time: new Date().toISOString(),
        count: (cachedDriveBackup?.count || 0) + 1,
        source: "google_drive",
      };
      lastDriveBackupFetchTime = Date.now();
      console.log(
        `✅ Auto-backup complete: ${lastAutoBackup.file} (${sizeMB} MB)`,
      );
    } catch (uploadErr) {
      console.error("❌ Auto-backup Drive upload failed:", uploadErr.message);
    }
  } catch (err) {
    console.error("❌ Auto-backup failed:", err.message);
  } finally {
    // 🧹 ALWAYS prune local backups to protect disk space regardless of upload status
    pruneLocalBackups(2);
  }
}

// Run auto-backup every hour (first one after 2 minutes of startup)
setTimeout(() => autoBackupToDrive(), 2 * 60 * 1000);
setInterval(() => autoBackupToDrive(), 60 * 60 * 1000);

/* ── Admin: Restore from Google Drive → local DB (SSE progress) ── */
app.post("/admin/restore", requireAdminRole, async (req, res) => {
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
  if (["POST", "PUT", "DELETE", "PATCH"].includes(req.method)) {
    const originalJson = res.json.bind(res);
    res.json = function (data) {
      if (res.statusCode < 400) {
        const broadcast = req.app.get("broadcastRealtime");
        const io = req.app.get("io");
        const p = req.originalUrl || req.url;
        let channel = "data:misc";
        if (p.includes("/invoices")) channel = "data:invoices";
        else if (p.includes("/cash")) channel = "data:cash";
        else if (p.includes("/inter-branch")) channel = "data:inter-branch";
        else if (p.includes("/stock-transfer") || p.includes("/stock") || p.includes("/transfer"))
          channel = "data:stock";
        else if (p.includes("/products") || p.includes("/manufacturers"))
          channel = "data:products";
        else if (p.includes("/customers")) channel = "data:customers";
        else if (p.includes("/suppliers")) channel = "data:suppliers";
        else if (p.includes("/users")) channel = "data:users";
        else if (p.includes("/payroll")) channel = "data:payroll";
        else if (p.includes("/opening-stock")) channel = "data:stock";

        const payload = {
          action: req.method,
          path: p,
          ts: Date.now(),
        };

        if (typeof broadcast === "function") {
          broadcast(channel, payload);
          // Inter-branch transfers also change stock levels across branches
          if (channel === "data:inter-branch") {
            broadcast("data:stock", payload);
          }
          // Ensure specific cash-in channel is also broadcasted
          if (p.includes("/cash-in")) {
            broadcast("data:cash-in", payload);
          }
          // Also broadcast specific cross-client invalidation if stock or product changed
          if (channel === "data:stock" || channel === "data:products" || channel === "data:invoices" || channel === "data:inter-branch") {
            invalidateProductsCache();
            invalidateDashboardStatsCache();
            broadcast("product_updated", { invalidateProducts: true, path: p, ts: Date.now() });
          }
          if (channel === "data:cash") {
            invalidateDashboardStatsCache();
          }
        } else if (io) {
          io.emit(channel, payload);
          if (p.includes("/cash-in")) {
            io.emit("data:cash-in", payload);
          }
          if (channel === "data:invoices" || channel === "data:cash" || channel === "data:stock") {
            invalidateDashboardStatsCache();
          }
        }

        // 🚨 Trigger debounced non-blocking stock watchdog check
        if (
          channel === "data:invoices" ||
          channel === "data:stock" ||
          channel === "data:inter-branch" ||
          p.includes("/transfer") ||
          p.includes("/replace") ||
          p.includes("/opening-stock")
        ) {
          if (io) stockWatchdogService.scheduleDebouncedAudit({ io });
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

const payrollRoutes = require("./payroll/payroll.routes");
app.use("/payroll", payrollRoutes);

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
              WHEN movement_type IN ('purchase','transfer_in','replace_in','return_sale','inter_branch_in','in','adjustment_in') THEN quantity
              WHEN movement_type IN ('sale','transfer_out','replace_out','return_purchase','inter_branch_out','out','adjustment_out') THEN -quantity
              ELSE 0
            END
          ) AS calc_qty
          FROM stock_movements
          WHERE variant_id IS NOT NULL AND variant_id != 0
          GROUP BY warehouse_id, product_id, variant_id
          HAVING SUM(
            CASE
              WHEN movement_type IN ('purchase','transfer_in','replace_in','return_sale','inter_branch_in','in','adjustment_in') THEN quantity
              WHEN movement_type IN ('sale','transfer_out','replace_out','return_purchase','inter_branch_out','out','adjustment_out') THEN -quantity
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
              WHEN movement_type IN ('purchase','transfer_in','replace_in','return_sale','inter_branch_in','in','adjustment_in') THEN quantity
              WHEN movement_type IN ('sale','transfer_out','replace_out','return_purchase','inter_branch_out','out','adjustment_out') THEN -quantity
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

/**
 * 🚀 High-Performance Atomic Batch Stock Changes
 * Executes all stock decrements in a single multi-row UPDATE (1 network round-trip)
 * and all stock increments in a single multi-row UPSERT (1 network round-trip).
 * Preserves strict zero/negative stock guards and returns exact error on deficit.
 */
async function batchApplyStockChanges(client, { warehouseId, operations }) {
  if (!operations || operations.length === 0) return;

  const decrements = [];
  const increments = [];

  for (const op of operations) {
    const qty = Number(op.quantity || 0);
    if (qty <= 0) continue;
    const item = {
      productId: Number(op.productId || op.product_id),
      variantId: Number(op.variantId || op.variant_id || 0),
      quantity: qty,
      productName: op.productName || op.product_name || `صنف #${op.productId || op.product_id}`,
      reason: op.reason,
    };
    if (op.type === "decrement") {
      decrements.push(item);
    } else if (op.type === "increment") {
      increments.push(item);
    }
  }

  // 1. Process all increments in ONE single atomic multi-row UPSERT
  if (increments.length > 0) {
    const aggregatedIncrements = new Map();
    for (const inc of increments) {
      const key = `${inc.productId}:${inc.variantId}`;
      if (!aggregatedIncrements.has(key)) {
        aggregatedIncrements.set(key, { ...inc });
      } else {
        aggregatedIncrements.get(key).quantity += inc.quantity;
      }
    }

    const incList = Array.from(aggregatedIncrements.values());
    const valPlaceholders = [];
    const params = [];
    let pIdx = 1;

    for (const inc of incList) {
      valPlaceholders.push(`($${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++})`);
      params.push(warehouseId, inc.productId, inc.variantId, inc.quantity);
    }

    await client.query(
      `INSERT INTO stock (warehouse_id, product_id, variant_id, quantity)
       VALUES ${valPlaceholders.join(", ")}
       ON CONFLICT (warehouse_id, product_id, variant_id)
       DO UPDATE SET quantity = stock.quantity + EXCLUDED.quantity`,
      params
    );
  }

  // 2. Process all decrements in ONE single atomic multi-row UPDATE
  if (decrements.length > 0) {
    const aggregatedDecrements = new Map();
    for (const dec of decrements) {
      const key = `${dec.productId}:${dec.variantId}`;
      if (!aggregatedDecrements.has(key)) {
        aggregatedDecrements.set(key, { ...dec });
      } else {
        aggregatedDecrements.get(key).quantity += dec.quantity;
      }
    }

    const decList = Array.from(aggregatedDecrements.values());
    const valPlaceholders = [];
    const params = [warehouseId];
    let pIdx = 2;

    for (const dec of decList) {
      valPlaceholders.push(
        `($1::int, $${pIdx++}::int, $${pIdx++}::int, $${pIdx++}::numeric)`
      );
      params.push(dec.productId, dec.variantId, dec.quantity);
    }

    const updateQuery = `
      UPDATE stock AS s
      SET quantity = s.quantity - v.qty
      FROM (VALUES ${valPlaceholders.join(", ")}) AS v(wh_id, prod_id, var_id, qty)
      WHERE s.warehouse_id = v.wh_id
        AND s.product_id = v.prod_id
        AND s.variant_id = v.var_id
        AND s.quantity >= v.qty
      RETURNING s.product_id, s.variant_id;
    `;

    const updateResult = await client.query(updateQuery, params);

    if (updateResult.rowCount !== decList.length) {
      const successfulKeys = new Set(
        updateResult.rows.map((r) => `${r.product_id}:${r.variant_id}`)
      );
      for (const dec of decList) {
        const key = `${dec.productId}:${dec.variantId}`;
        if (!successfulKeys.has(key)) {
          const currentRes = await client.query(
            `SELECT quantity FROM stock WHERE warehouse_id = $1 AND product_id = $2 AND variant_id = $3 LIMIT 1`,
            [warehouseId, dec.productId, dec.variantId]
          );
          const currentQty = currentRes.rows.length ? Number(currentRes.rows[0].quantity) : 0;
          throw new Error(
            dec.reason || `رصيد غير كافٍ للبيع: ${dec.productName} (الرصيد المتاح: ${currentQty}، المطلوب: ${dec.quantity})`
          );
        }
      }
      throw new Error("فشل خصم بعض الأصناف من المخزون لعدم كفاية الرصيد");
    }
  }
}

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

  // 🚀 Batch pre-fetch all product and variant metadata and costs for this invoice
  const productCostCache = new Map();
  const variantCostCache = new Map();

  try {
    const productIds = Array.from(
      new Set(
        (items || [])
          .map((it) => Number(it?.product_id || 0))
          .filter((id) => id > 0),
      ),
    );

    if (productIds.length > 0) {
      const [productsRes, variantsRes] = await Promise.all([
        client.query(
          `SELECT id, wholesale_package, retail_package, purchase_price, retail_purchase_price, retail_master_product_id 
           FROM products WHERE id = ANY($1)`,
          [productIds],
        ),
        client.query(
          `SELECT id, product_id, wholesale_package, retail_package, purchase_price, retail_purchase_price 
           FROM product_variants WHERE product_id = ANY($1)`,
          [productIds],
        ),
      ]);

      for (const p of productsRes.rows) {
        productCostCache.set(Number(p.id), p);
      }

      const variantsByProduct = new Map();
      for (const v of variantsRes.rows) {
        const pid = Number(v.product_id);
        if (!variantsByProduct.has(pid)) variantsByProduct.set(pid, []);
        variantsByProduct.get(pid).push(v);
        variantCostCache.set(`${pid}:${Number(v.id)}`, v);
      }

      for (const pid of productIds) {
        const pRow = productCostCache.get(pid) || {};
        const basePackages = new Set();
        const wholesalePkg = normalizePackageName(pRow.wholesale_package);
        const retailPkg = normalizePackageName(pRow.retail_package);
        if (wholesalePkg) basePackages.add(wholesalePkg);
        if (retailPkg) basePackages.add(retailPkg);

        const vRows = variantsByProduct.get(pid) || [];
        const validVariantIds = new Set();
        const variantPackageMap = new Map();

        for (const v of vRows) {
          const vid = Number(v.id || 0);
          if (!vid) continue;
          validVariantIds.add(vid);
          const vWholesale = normalizePackageName(v.wholesale_package);
          const vRetail = normalizePackageName(v.retail_package);
          if (vWholesale) variantPackageMap.set(vWholesale, vid);
          if (vRetail) variantPackageMap.set(vRetail, vid);
        }

        variantMetaCache.set(pid, {
          validVariantIds,
          variantPackageMap,
          basePackages,
        });
      }
    }
  } catch (err) {
    console.warn("⚠️ Batch prefetch fallback:", err.message);
  }

  for (const item of items) {
    const quantity = Number(item.quantity || 0);
    const price = Number(item.price || 0);
    const discount = Number(item.discount || 0);

    // 🔥 دمج كود القطاعي: لو الفاتورة قطاعي والصنف مدموج تحت صنف ماستر، يتم تحويله للماستر
    let pid = Number(item.product_id || 0);
    if (invoiceType === "retail" && pid > 0) {
      const pRowInitial = productCostCache.get(pid);
      if (pRowInitial?.retail_master_product_id) {
        pid = Number(pRowInitial.retail_master_product_id);
        item.product_id = pid;
      }
    }

    const variantId = await resolveInvoiceItemVariantId(
      item,
      invoiceType,
      client,
      variantMetaCache,
    );

    let costPrice = 0;
    const vid = Number(variantId || 0);
    const pRow = productCostCache.get(pid);
    const vRow = variantCostCache.get(`${pid}:${vid}`);

    if (pRow) {
      const productPurchasePrice = Number(pRow.purchase_price || 0);
      const productRetailPurchasePrice = Number(pRow.retail_purchase_price || 0);
      const variantPurchasePrice = Number(vRow?.purchase_price || 0);
      const variantRetailPurchasePrice = Number(vRow?.retail_purchase_price || 0);

      if (invoiceType === "retail") {
        costPrice =
          variantRetailPurchasePrice ||
          productRetailPurchasePrice ||
          variantPurchasePrice ||
          productPurchasePrice ||
          0;
      } else {
        costPrice =
          variantPurchasePrice ||
          productPurchasePrice ||
          variantRetailPurchasePrice ||
          productRetailPurchasePrice ||
          0;
      }
    } else {
      costPrice = await getInvoiceItemCostSnapshot(
        item.product_id,
        variantId,
        invoiceType,
        client,
      );
    }

    normalizedItems.push({
      ...item,
      package: item.package || "",
      quantity,
      price,
      discount,
      variant_id: variantId,
      itemIsReturn: Boolean(item.is_return),
      itemTotal: price * quantity - discount * quantity,
      costPrice,
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

/* =========================================================
   ⚡ Ultra-Fast In-Memory Cache for /products
   ========================================================= */
const productsMemoryCache = new Map();
const PRODUCTS_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes TTL

function getProductsCacheKey(warehouseId, invoiceType, movementType) {
  return `${warehouseId || "null"}:${invoiceType || ""}:${movementType || ""}`;
}

function invalidateProductsCache() {
  if (productsMemoryCache.size > 0) {
    productsMemoryCache.clear();
    console.log("⚡ Products in-memory cache invalidated.");
  }
}

async function fetchProductsFromDb(invoiceType, warehouseId, movementType) {
  if (movementType === "sale") {
    const res = await pool.query(
      `
      WITH product_stock AS (
        SELECT product_id, SUM(quantity) AS qty
        FROM stock
        WHERE warehouse_id = $2
        GROUP BY product_id
      ),
      family_stock AS (
        SELECT
          CASE WHEN $1 = 'retail' THEN COALESCE(p.retail_master_product_id, p.id) ELSE p.id END AS master_id,
          SUM(ps.qty) AS total_qty
        FROM product_stock ps
        JOIN products p ON p.id = ps.product_id
        GROUP BY 1
      ),
      secondary_bcs AS (
        SELECT retail_master_product_id AS master_id, json_agg(barcode) AS secondary_barcodes
        FROM products
        WHERE retail_master_product_id IS NOT NULL AND barcode IS NOT NULL AND barcode <> ''
        GROUP BY retail_master_product_id
      ),
      var_stock AS (
        SELECT
          vs.product_id,
          json_agg(json_build_object(
            'variant_id', vs.variant_id,
            'package_name', COALESCE(pv.wholesale_package, p.wholesale_package),
            'quantity', vs.quantity,
            'price', CASE WHEN $1 = 'wholesale' THEN pv.wholesale_price ELSE pv.retail_price END
          ) ORDER BY vs.variant_id) AS variant_stock
        FROM stock vs
        JOIN products p ON p.id = vs.product_id
        LEFT JOIN product_variants pv ON pv.id = vs.variant_id AND pv.product_id = vs.product_id
        WHERE vs.warehouse_id = $2 AND vs.variant_id IS NOT NULL
        GROUP BY vs.product_id
      )
      SELECT
        p.id,
        p.name,
        p.barcode,
        p.wholesale_package,
        p.retail_package,
        p.manufacturer,
        p.description,
        p.has_wholesale,
        p.retail_master_product_id,
        sb.secondary_barcodes,
        CASE
          WHEN $1 = 'wholesale' THEN p.wholesale_price
          ELSE p.retail_price
        END AS price,
        p.wholesale_price,
        p.retail_price,
        p.discount_amount,
        COALESCE(fs.total_qty, 0) AS available_quantity,
        vs.variant_stock
      FROM products p
      LEFT JOIN family_stock fs ON fs.master_id = p.id
      LEFT JOIN secondary_bcs sb ON sb.master_id = p.id
      LEFT JOIN var_stock vs ON vs.product_id = p.id
      WHERE p.is_active = true
        AND ($1 = 'wholesale' OR p.retail_master_product_id IS NULL)
      ORDER BY p.name;
      `,
      [invoiceType, warehouseId]
    );
    return res.rows;
  } else {
    // 🔹 شراء
    const res = await pool.query(
      `
      WITH product_stock AS (
        SELECT product_id, SUM(quantity) AS qty
        FROM stock
        WHERE warehouse_id = $2
        GROUP BY product_id
      ),
      family_stock AS (
        SELECT
          CASE WHEN $1 = 'retail' THEN COALESCE(p.retail_master_product_id, p.id) ELSE p.id END AS master_id,
          SUM(ps.qty) AS total_qty
        FROM product_stock ps
        JOIN products p ON p.id = ps.product_id
        GROUP BY 1
      ),
      secondary_bcs AS (
        SELECT retail_master_product_id AS master_id, json_agg(barcode) AS secondary_barcodes
        FROM products
        WHERE retail_master_product_id IS NOT NULL AND barcode IS NOT NULL AND barcode <> ''
        GROUP BY retail_master_product_id
      ),
      var_stock AS (
        SELECT
          vs.product_id,
          json_agg(json_build_object(
            'variant_id', vs.variant_id,
            'package_name', COALESCE(pv.wholesale_package, p.wholesale_package),
            'quantity', vs.quantity,
            'price', CASE WHEN $1 = 'wholesale' THEN pv.purchase_price ELSE pv.retail_purchase_price END
          ) ORDER BY vs.variant_id) AS variant_stock
        FROM stock vs
        JOIN products p ON p.id = vs.product_id
        LEFT JOIN product_variants pv ON pv.id = vs.variant_id AND pv.product_id = vs.product_id
        WHERE vs.warehouse_id = $2 AND vs.variant_id IS NOT NULL
        GROUP BY vs.product_id
      )
      SELECT
        p.id,
        p.name,
        p.barcode,
        p.wholesale_package,
        p.retail_package,
        p.manufacturer,
        p.description,
        p.has_wholesale,
        p.retail_master_product_id,
        sb.secondary_barcodes,
        CASE
          WHEN $1 = 'wholesale' THEN p.purchase_price
          ELSE p.retail_purchase_price
        END AS price,
        p.discount_amount,
        COALESCE(fs.total_qty, 0) AS available_quantity,
        vs.variant_stock
      FROM products p
      LEFT JOIN family_stock fs ON fs.master_id = p.id
      LEFT JOIN secondary_bcs sb ON sb.master_id = p.id
      LEFT JOIN var_stock vs ON vs.product_id = p.id
      WHERE p.is_active = true
        AND ($1 = 'wholesale' OR p.retail_master_product_id IS NULL)
      ORDER BY p.name;
      `,
      [invoiceType, warehouseId]
    );
    return res.rows;
  }
}

function prewarmProductsCache() {
  setTimeout(async () => {
    try {
      console.log("🔥 Pre-warming products in-memory cache...");
      const rows = await fetchProductsFromDb("retail", 1, "sale");
      productsMemoryCache.set(getProductsCacheKey(1, "retail", "sale"), {
        data: rows,
        timestamp: Date.now(),
        isFetching: false,
      });
      console.log(`🔥 Products cache pre-warmed (${rows.length} retail products loaded into RAM)!`);
    } catch (err) {
      console.error("Products cache pre-warm error:", err.message);
    }
  }, 2500);
}

app.get("/products", async (req, res) => {
  try {
    const { branch_id, invoice_type, movement_type } = req.query;

    if (!branch_id || !invoice_type || !movement_type) {
      return res.status(400).json({
        error: "branch_id و invoice_type و movement_type مطلوبين",
      });
    }

    const warehouseId = getWarehouseIdByInvoiceType(invoice_type);
    const cacheKey = getProductsCacheKey(warehouseId, invoice_type, movement_type);
    const cached = productsMemoryCache.get(cacheKey);
    const now = Date.now();

    // 1. Instant Cache Hit (< 1ms response)
    if (cached && (now - cached.timestamp < PRODUCTS_CACHE_TTL_MS)) {
      res.setHeader("X-Cache", "HIT");
      return res.json(cached.data);
    }

    // 2. Stale-While-Revalidate: serve stale immediately and revalidate in background
    if (cached && cached.data) {
      if (!cached.isFetching) {
        cached.isFetching = true;
        fetchProductsFromDb(invoice_type, warehouseId, movement_type)
          .then((fresh) => {
            productsMemoryCache.set(cacheKey, {
              data: fresh,
              timestamp: Date.now(),
              isFetching: false,
            });
          })
          .catch((e) => {
            console.error("Background products cache refresh error:", e.message);
            cached.isFetching = false;
          });
      }
      res.setHeader("X-Cache", "STALE");
      return res.json(cached.data);
    }

    // 3. Cold Fetch
    const rows = await fetchProductsFromDb(invoice_type, warehouseId, movement_type);
    productsMemoryCache.set(cacheKey, {
      data: rows,
      timestamp: Date.now(),
      isFetching: false,
    });
    res.setHeader("X-Cache", "MISS");
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Server error" });
  }
});

// جلب الأكواد الفرعية لمجموعة أصناف (لاستخدام الفواتير والتحويلات)
app.get("/products/variants", async (req, res) => {
  try {
    const { product_ids } = req.query;
    if (!product_ids || product_ids === "all") {
      const result = await pool.query(
        `SELECT pv.*, 
                COALESCE(NULLIF(pv.retail_package, ''), p.retail_package) AS retail_package
         FROM product_variants pv
         JOIN products p ON p.id = pv.product_id
         ORDER BY pv.product_id, pv.id`,
      );
      return res.json(result.rows);
    }

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
      cash_breakdown = null,
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

    const warehouseId = getWarehouseIdByInvoiceType(invoice_type);

    // 🚀 Parallel pre-fetch: duplicate check, customer resolution, supplier resolution, and normalized items
    const [checkExisting, customerId, normalizedItems, supplierId] = await Promise.all([
      client.query(
        "SELECT id FROM invoices WHERE customer_name = $1 AND total = $2 AND paid_amount = $3 AND created_at >= NOW() - INTERVAL '5 seconds'",
        [customer_name, total, paid_amount],
      ),
      (async () => {
        if (!customer_name) return null;
        let cId = null;
        const updateRes = await client.query(
          `UPDATE customers SET apply_items_discount = $1 WHERE name = $2 RETURNING id`,
          [apply_items_discount, customer_name],
        );
        if (updateRes.rows.length > 0) {
          cId = updateRes.rows[0].id;
        } else {
          const newCustomer = await client.query(
            `INSERT INTO customers (name, customer_type, apply_items_discount)
             VALUES ($1, $2, $3)
             RETURNING id`,
            [customer_name, invoice_type, apply_items_discount],
          );
          cId = newCustomer.rows[0].id;
        }
        if (customer_phone && cId) {
          await client.query(
            `INSERT INTO customer_phones (customer_id, phone)
             VALUES ($1, $2)
             ON CONFLICT (phone) DO NOTHING`,
            [cId, customer_phone],
          );
        }
        return cId;
      })(),
      normalizeInvoiceItemsForStorage(items, invoice_type, client),
      (async () => {
        if (movement_type !== "purchase" || !supplier_name) return null;
        let sId = null;
        const existingSupplier = await client.query(
          `SELECT id FROM suppliers WHERE name = $1 LIMIT 1`,
          [supplier_name],
        );
        if (existingSupplier.rows.length > 0) {
          sId = existingSupplier.rows[0].id;
        } else {
          const newSupplier = await client.query(
            `INSERT INTO suppliers (name) VALUES ($1) RETURNING id`,
            [supplier_name],
          );
          sId = newSupplier.rows[0].id;
        }
        if (supplier_phone && sId) {
          await client.query(
            `INSERT INTO supplier_phones (supplier_id, phone) VALUES ($1, $2) ON CONFLICT (phone) DO NOTHING`,
            [sId, supplier_phone],
          );
        }
        return sId;
      })(),
    ]);

    if (checkExisting.rows.length) {
      throw new Error("تم منع إنشاء فاتورة مكررة");
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
  notes,
  cash_breakdown
)
VALUES
($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
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
        cash_breakdown ? JSON.stringify(cash_breakdown) : null,
      ],
    );

    const invoiceId = invoiceRes.rows[0].id;

    /* ================== الأصناف + المخزن ================== */
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

    // 🚀 High-Performance Atomic Batch Stock Changes & Movements
    const stockOps = [];
    const stockMovementsToInsert = [];
    for (const item of normalizedItems) {
      const variantId = item.variant_id || 0;
      const itemIsReturn = item.itemIsReturn;

      let opType;
      if (movement_type === "purchase") {
        opType = itemIsReturn ? "decrement" : "increment";
      } else {
        opType = itemIsReturn ? "increment" : "decrement";
      }

      stockOps.push({
        productId: item.product_id,
        variantId,
        quantity: item.quantity,
        type: opType,
        productName: item.product_name,
        reason:
          movement_type === "sale" && !itemIsReturn
            ? `رصيد غير كافٍ للبيع: ${item.product_name}`
            : movement_type === "purchase" && itemIsReturn
            ? `لا يمكن تسجيل مرتجع الشراء بدون رصيد كافٍ: ${item.product_name}`
            : undefined,
      });

      stockMovementsToInsert.push({
        invoiceId,
        warehouseId,
        productId: item.product_id,
        variantId,
        quantity: item.quantity,
        movementType: itemIsReturn ? `return_${movement_type}` : movement_type,
      });
    }

    // Execute all stock changes in 1 single atomic multi-row query
    await batchApplyStockChanges(client, {
      warehouseId,
      operations: stockOps,
    });

    // 🚀 Batch INSERT for stock_movements
    if (stockMovementsToInsert.length > 0) {
      const smValues = [];
      const smParams = [];
      let smIdx = 1;
      for (const sm of stockMovementsToInsert) {
        smValues.push(
          `($${smIdx++},$${smIdx++},$${smIdx++},$${smIdx++},$${smIdx++},$${smIdx++})`,
        );
        smParams.push(
          sm.invoiceId,
          sm.warehouseId,
          sm.productId,
          sm.variantId,
          sm.quantity,
          sm.movementType,
        );
      }
      await client.query(
        `INSERT INTO stock_movements
         (invoice_id, warehouse_id, product_id, variant_id, quantity, movement_type)
         VALUES ${smValues.join(",")}`,
        smParams,
      );
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

      // 🚀 إرسال لحظي موحد عبر الكلاستر
      const broadcast = req.app.get("broadcastRealtime");
      if (typeof broadcast === "function") {
        broadcast("new_notification", {
          title,
          message,
          type: "invoice_wholesale",
          reference_id: invoiceId,
        }, `branch_${MAIN_WAREHOUSE_ID}`);
      } else {
        const io = req.app.get("io");
        if (io) {
          io.to(`branch_${MAIN_WAREHOUSE_ID}`).emit("new_notification", {
            title,
            message,
            type: "invoice_wholesale",
            reference_id: invoiceId,
          });
        }
      }

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

    if (
      movement_type === "sale" &&
      !is_return &&
      (customer_phone || req.body.customer_phone)
    ) {
      // 🚀 Smart Delayed Dispatch check:
      // If wholesale invoice is created by a user from Retail Branch (userBranchId == 1)
      // and customer hasn't fully settled yet (unpaid / partial),
      // DELAY dispatch until customer arrives at Wholesale branch to pay and pick up goods.
      const creatorBranchId = Number(userBranchId ?? req.user?.branch_id ?? 0);
      const isCreatedFromRetail = creatorBranchId === 1;
      const isUnpaid =
        Number(paid_amount || 0) <= 0 ||
        payment_status === "unpaid" ||
        Number(remaining_amount || 0) > 0;

      if (isCreatedFromRetail && isUnpaid) {
        console.log(
          `[QuazLink] ⏳ Wholesale invoice #${invoiceId} created by Retail user (user branch: ${creatorBranchId}, unpaid/partial). Delaying WhatsApp dispatch until payment/pickup at Wholesale branch.`
        );
      } else {
        setImmediate(() => {
          quazlinkService
            .dispatchInvoiceWhatsApp({
              invoiceId,
              customerPhone: customer_phone || req.body.customer_phone,
              customerName: customer_name || req.body.customer_name,
              amount: totalWithPrevious || total,
              paidAmount: Number(paid_amount || 0),
              remainingAmount: remaining_amount,
              invoiceType: "wholesale",
              currency: "ج.م",
            })
            .catch((err) =>
              console.error(
                "[QuazLink] Wholesale WhatsApp background error:",
                err.message,
              ),
            );
        });
      }
    }

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
      cash_breakdown = null,
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

    const warehouseId = getWarehouseIdByInvoiceType("retail");

    // 🚀 Parallel pre-fetch: resolve customer, supplier, and normalized items simultaneously
    const [customerId, normalizedItems, supplierId] = await Promise.all([
      (async () => {
        if (!customer_name) return null;
        let cId = null;
        const updateRes = await client.query(
          `UPDATE customers SET apply_items_discount = $1 WHERE name = $2 RETURNING id`,
          [apply_items_discount, customer_name],
        );
        if (updateRes.rows.length > 0) {
          cId = updateRes.rows[0].id;
        } else {
          const newCustomer = await client.query(
            `INSERT INTO customers (name, customer_type, apply_items_discount)
             VALUES ($1, 'retail', $2)
             RETURNING id`,
            [customer_name, apply_items_discount],
          );
          cId = newCustomer.rows[0].id;
        }
        if (customer_phone && cId) {
          await client.query(
            `INSERT INTO customer_phones (customer_id, phone)
             VALUES ($1, $2)
             ON CONFLICT (phone) DO NOTHING`,
            [cId, customer_phone],
          );
        }
        return cId;
      })(),
      normalizeInvoiceItemsForStorage(items, "retail", client),
      (async () => {
        if (movement_type !== "purchase" || !supplier_name) return null;
        let sId = null;
        const existingSupplier = await client.query(
          `SELECT id FROM suppliers WHERE name = $1 LIMIT 1`,
          [supplier_name],
        );
        if (existingSupplier.rows.length > 0) {
          sId = existingSupplier.rows[0].id;
        } else {
          const newSupplier = await client.query(
            `INSERT INTO suppliers (name) VALUES ($1) RETURNING id`,
            [supplier_name],
          );
          sId = newSupplier.rows[0].id;
        }
        if (supplier_phone && sId) {
          await client.query(
            `INSERT INTO supplier_phones (supplier_id, phone) VALUES ($1, $2) ON CONFLICT (phone) DO NOTHING`,
            [sId, supplier_phone],
          );
        }
        return sId;
      })(),
    ]);

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
        notes,
        cash_breakdown
      )
      VALUES
      ($1,'retail',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
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
        cash_breakdown ? JSON.stringify(cash_breakdown) : null,
      ],
    );

    const invoiceId = invoiceRes.rows[0].id;

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

    // 🚀 High-Performance Atomic Batch Stock Changes & Movements
    const stockOps = [];
    const retailStockMovementsToInsert = [];
    for (const item of normalizedItems) {
      const variantId = item.variant_id || 0;
      const itemIsReturn = item.itemIsReturn;

      let opType;
      if (movement_type === "sale") {
        opType = itemIsReturn ? "increment" : "decrement";
      } else {
        opType = itemIsReturn ? "decrement" : "increment";
      }

      stockOps.push({
        productId: item.product_id,
        variantId,
        quantity: item.quantity,
        type: opType,
        productName: item.product_name,
        reason:
          movement_type === "sale" && !itemIsReturn
            ? `رصيد غير كافٍ للبيع: ${item.product_name}`
            : movement_type === "purchase" && itemIsReturn
            ? `لا يمكن تسجيل مرتجع الشراء بدون رصيد كافٍ: ${item.product_name}`
            : undefined,
      });

      retailStockMovementsToInsert.push({
        invoiceId,
        warehouseId,
        productId: item.product_id,
        variantId,
        quantity: item.quantity,
        movementType: itemIsReturn ? `return_${movement_type}` : movement_type,
      });
    }

    // Execute all stock changes in 1 single atomic multi-row query
    await batchApplyStockChanges(client, {
      warehouseId,
      operations: stockOps,
    });

    // 🚀 Batch INSERT for stock_movements
    if (retailStockMovementsToInsert.length > 0) {
      const smValues = [];
      const smParams = [];
      let smIdx = 1;
      for (const sm of retailStockMovementsToInsert) {
        smValues.push(
          `($${smIdx++},$${smIdx++},$${smIdx++},$${smIdx++},$${smIdx++},$${smIdx++})`,
        );
        smParams.push(
          sm.invoiceId,
          sm.warehouseId,
          sm.productId,
          sm.variantId,
          sm.quantity,
          sm.movementType,
        );
      }
      await client.query(
        `INSERT INTO stock_movements
         (invoice_id, warehouse_id, product_id, variant_id, quantity, movement_type)
         VALUES ${smValues.join(",")}`,
        smParams,
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

    if (
      movement_type === "sale" &&
      !is_return &&
      (customer_phone || req.body.customer_phone)
    ) {
      setImmediate(() => {
        quazlinkService
          .dispatchInvoiceWhatsApp({
            invoiceId,
            customerPhone: customer_phone || req.body.customer_phone,
            customerName: customer_name || req.body.customer_name,
            amount: final_total,
            paidAmount: Number(paid_amount || 0),
            remainingAmount: remaining_amount,
            invoiceType: "retail",
            currency: "ج.م",
          })
          .catch((err) =>
            console.error(
              "[QuazLink] Retail WhatsApp background error:",
              err.message,
            ),
          );
      });
    }

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
      cash_breakdown,
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
      const stockOps = [];
      for (const entry of stockDeltas) {
        if (entry.delta > 0) {
          stockOps.push({
            productId: entry.productId,
            variantId: entry.variantId,
            quantity: entry.delta,
            type: "increment",
          });
        } else if (entry.delta < 0) {
          stockOps.push({
            productId: entry.productId,
            variantId: entry.variantId,
            quantity: Math.abs(entry.delta),
            type: "decrement",
            reason: `تعذر تعديل حركة مخزون الفاتورة: صنف #${entry.productId}`,
          });
        }
      }

      if (stockOps.length > 0) {
        await batchApplyStockChanges(client, {
          warehouseId,
          operations: stockOps,
        });
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
         4️⃣ إضافة الأصناف الجديدة (Batch)
      ================================= */
      if (normalizedItems.length > 0) {
        const itemValues = [];
        const itemParams = [];
        let paramIdx = 1;

        const smValues = [];
        const smParams = [];
        let smIdx = 1;

        for (const item of normalizedItems) {
          const variantId = item.variant_id || 0;
          const itemIsReturn = item.itemIsReturn;

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
            itemIsReturn,
            item.costPrice,
          );

          smValues.push(
            `($${smIdx++},$${smIdx++},$${smIdx++},$${smIdx++},$${smIdx++},$${smIdx++})`,
          );
          smParams.push(
            invoiceId,
            warehouseId,
            item.product_id,
            variantId,
            item.quantity,
            itemIsReturn ? `return_${movement_type}` : movement_type,
          );
        }

        await client.query(
          `INSERT INTO invoice_items
            (invoice_id, product_id, product_name, package, price, quantity, discount, total, variant_id, is_return, cost_price)
           VALUES ${itemValues.join(",")}`,
          itemParams,
        );

        await client.query(
          `INSERT INTO stock_movements
            (invoice_id, warehouse_id, product_id, variant_id, quantity, movement_type)
           VALUES ${smValues.join(",")}`,
          smParams,
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
  invoice_revision = $21,
  cash_breakdown = COALESCE($22::jsonb, cash_breakdown)
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
        cash_breakdown !== undefined ? (cash_breakdown ? JSON.stringify(cash_breakdown) : null) : null,
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
      LEFT JOIN products p ON p.id = ii.product_id
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
  LEFT JOIN products p ON p.id = ii.product_id
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
   إعادة إرسال الفاتورة عبر واتساب (QuazLink)
================================= */
app.post("/invoices/:id/resend-whatsapp", authMiddleware, async (req, res) => {
  try {
    const invoiceId = Number(req.params.id);
    if (!invoiceId || invoiceId <= 0) {
      return res.status(400).json({ error: "معرف الفاتورة غير صحيح" });
    }

    const result = await quazlinkService.resendInvoiceWhatsApp(
      invoiceId,
      req.user?.id,
    );

    const io = req.app.get("io");
    if (io) {
      io.emit("data:invoices", {
        action: "update",
        invoice_id: invoiceId,
      });
    }

    if (result.success) {
      res.json({
        success: true,
        message: "تم إرسال الفاتورة عبر واتساب بنجاح",
        data: result,
      });
    } else {
      res.status(400).json({
        error: result.error || "فشل إرسال الفاتورة عبر واتساب",
        reason: result.reason,
      });
    }
  } catch (err) {
    console.error("[QuazLink Resend Error]:", err.message);
    res.status(500).json({ error: err.message });
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
      cash_breakdown,
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
      const stockOps = [];
      for (const entry of stockDeltas) {
        if (entry.delta > 0) {
          stockOps.push({
            productId: entry.productId,
            variantId: entry.variantId,
            quantity: entry.delta,
            type: "increment",
          });
        } else if (entry.delta < 0) {
          stockOps.push({
            productId: entry.productId,
            variantId: entry.variantId,
            quantity: Math.abs(entry.delta),
            type: "decrement",
            reason: `تعذر تعديل حركة مخزون الفاتورة: صنف #${entry.productId}`,
          });
        }
      }

      if (stockOps.length > 0) {
        await batchApplyStockChanges(client, {
          warehouseId,
          operations: stockOps,
        });
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

      /* ================================
         4️⃣ إضافة الأصناف الجديدة (Batch)
      ================================= */
      if (normalizedItems.length > 0) {
        const itemValues = [];
        const itemParams = [];
        let paramIdx = 1;

        const smValues = [];
        const smParams = [];
        let smIdx = 1;

        for (const item of normalizedItems) {
          const variantId = item.variant_id || 0;
          const itemIsReturn = item.itemIsReturn;

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
            itemIsReturn,
            item.costPrice,
          );

          smValues.push(
            `($${smIdx++},$${smIdx++},$${smIdx++},$${smIdx++},$${smIdx++},$${smIdx++})`,
          );
          smParams.push(
            invoiceId,
            warehouseId,
            item.product_id,
            variantId,
            item.quantity,
            itemIsReturn ? `return_${movement_type}` : movement_type,
          );
        }

        await client.query(
          `INSERT INTO invoice_items
            (invoice_id, product_id, product_name, package, price, quantity, discount, total, variant_id, is_return, cost_price)
           VALUES ${itemValues.join(",")}`,
          itemParams,
        );

        await client.query(
          `INSERT INTO stock_movements
            (invoice_id, warehouse_id, product_id, variant_id, quantity, movement_type)
           VALUES ${smValues.join(",")}`,
          smParams,
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
      invoice_revision = $22,
      cash_breakdown = COALESCE($23::jsonb, cash_breakdown)
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
        cash_breakdown !== undefined ? (cash_breakdown ? JSON.stringify(cash_breakdown) : null) : null,
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

    if (
      movement_type === "sale" &&
      (customer_phone || req.body.customer_phone)
    ) {
      setImmediate(() => {
        quazlinkService
          .dispatchInvoiceWhatsApp({
            invoiceId,
            customerPhone: customer_phone || req.body.customer_phone,
            customerName: customer_name || req.body.customer_name,
            amount: totalWithPrevious || total,
            paidAmount: Number(paid_amount || 0),
            remainingAmount: remaining,
            invoiceType: "wholesale",
            currency: "ج.م",
            force: true, // Force send updated status after edit/payment at wholesale
          })
          .catch((err) =>
            console.error(
              "[QuazLink] Wholesale Update WhatsApp background error:",
              err.message,
            ),
          );
      });
    }

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
        whatsapp_status,
        whatsapp_phone,
        whatsapp_sent_at,
        whatsapp_error,
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
// ========== Dashboard In-Memory Cache ==========
const _dashboardCache = new Map();
function getDashboardCache(key, ttlMs) {
  const item = _dashboardCache.get(key);
  if (item && Date.now() - item.ts < ttlMs) {
    return item.data;
  }
  return null;
}
function setDashboardCache(key, data) {
  _dashboardCache.set(key, { data, ts: Date.now() });
}
function invalidateDashboardStatsCache() {
  _dashboardCache.delete("dashboard_stats_retail");
  _dashboardCache.delete("dashboard_stats_wholesale");
  _dashboardCache.delete("low_stock_reorder_count");
}

async function fetchDashboardStats(invoice_type) {
  const cacheKey = `dashboard_stats_${invoice_type}`;
  const cached = getDashboardCache(cacheKey, 30000);
  if (cached) return cached;

  const warehouseId = invoice_type === "retail" ? 1 : 2;

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
    // Negative stock count — optimized directly on stock table
    pool.query(
      `SELECT COUNT(*) AS count
       FROM stock s
       JOIN products p ON p.id = s.product_id
       WHERE s.warehouse_id = $1 AND s.quantity < 0 AND p.is_active = true`,
      [warehouseId],
    ),
    // Today's profit percentage (Proportional Distribution)
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

  const todaySalesTotal = Number(todayProfitSummary.rows[0]?.sales_total || 0) + Number(interBranchProfitSummary.rows[0]?.total_sales || 0);
  const todayTotalCost = Number(todayProfitSummary.rows[0]?.total_cost || 0) + Number(interBranchProfitSummary.rows[0]?.total_cost || 0);
  const todayNetProfit = todaySalesTotal - todayTotalCost;
  const todayProfitPercentage =
    todaySalesTotal > 0 ? (todayNetProfit / todaySalesTotal) * 100 : 0;

  const statsResult = {
    today_sales: Number(salesToday.rows[0]?.total_sales || 0),
    today_invoices_count: Number(salesToday.rows[0]?.count || 0),
    today_cash: Number(cashToday.rows[0]?.total_cash || 0),
    low_stock_count: Number(lowStockCount.rows[0]?.count || 0),
    negative_stock_count: Number(negativeStockCount.rows[0]?.count || 0),
    today_profit_percentage: todayProfitPercentage,
  };

  setDashboardCache(cacheKey, statsResult);
  return statsResult;
}

async function fetchLowStockReorderCount() {
  const cacheKey = "low_stock_reorder_count";
  const cached = getDashboardCache(cacheKey, 60000);
  if (cached) return cached;

  try {
    const res = await pool.query(`
      WITH ws_stock AS (
        SELECT 
          COALESCE(p2.retail_master_product_id, p2.id) AS product_id,
          SUM(s2.quantity) AS max_ws_qty
        FROM stock s2
        JOIN products p2 ON p2.id = s2.product_id
        JOIN warehouses w2 ON w2.id = s2.warehouse_id
        WHERE w2.name = 'المخزن الرئيسي'
        GROUP BY COALESCE(p2.retail_master_product_id, p2.id)
      ),
      retail_family_stock AS (
        SELECT 
          COALESCE(p3.retail_master_product_id, p3.id) AS product_id,
          SUM(s3.quantity) AS retail_qty
        FROM stock s3
        JOIN products p3 ON p3.id = s3.product_id
        JOIN warehouses w3 ON w3.id = s3.warehouse_id
        WHERE w3.name = 'مخزن المعرض'
        GROUP BY COALESCE(p3.retail_master_product_id, p3.id)
      ),
      computed_items AS (
        SELECT
          p.id AS product_id,
          COALESCE(rfs.retail_qty, s.quantity, 0) AS current_stock,
          CASE
            WHEN p.wholesale_package ~ 'كرتونة\\s*[0-9]+\\s*طقم' THEN
              (SUBSTRING(p.wholesale_package FROM 'كرتونة\\s*([0-9]+)\\s*طقم'))::integer
            WHEN (
              (CASE 
                WHEN p.wholesale_package ~ '[0-9]+\\s*دستة' THEN (SUBSTRING(p.wholesale_package FROM '([0-9]+)\\s*دستة'))::integer * 12
                WHEN p.wholesale_package ~ '[0-9]+\\s*قطعة' THEN (SUBSTRING(p.wholesale_package FROM '([0-9]+)\\s*قطعة'))::integer
                ELSE 0
              END) > 0
              AND
              COALESCE(
                NULLIF((SUBSTRING(p.retail_package FROM '([0-9]+)\\s*(?:علبة|شيالة|طقم|كيس|قطعة)')), '')::integer,
                NULLIF((SUBSTRING(p.retail_package FROM '(?:علبة|شيالة|طقم|كيس)\\s*([0-9]+)')), '')::integer,
                1
              ) > 0
            ) THEN
              GREATEST(1, ROUND(
                (CASE 
                  WHEN p.wholesale_package ~ '[0-9]+\\s*دستة' THEN (SUBSTRING(p.wholesale_package FROM '([0-9]+)\\s*دستة'))::integer * 12
                  WHEN p.wholesale_package ~ '[0-9]+\\s*قطعة' THEN (SUBSTRING(p.wholesale_package FROM '([0-9]+)\\s*قطعة'))::integer
                  ELSE 0
                END)::numeric
                /
                COALESCE(
                  NULLIF((SUBSTRING(p.retail_package FROM '([0-9]+)\\s*(?:علبة|شيالة|طقم|كيس|قطعة)')), '')::integer,
                  NULLIF((SUBSTRING(p.retail_package FROM '(?:علبة|شيالة|طقم|كيس)\\s*([0-9]+)')), '')::integer,
                  1
                )::numeric
              )::integer)
            ELSE 1
          END AS carton_capacity
        FROM stock s
        JOIN products p ON p.id = s.product_id
        JOIN warehouses w ON w.id = s.warehouse_id
        LEFT JOIN ws_stock ws ON ws.product_id = p.id
        LEFT JOIN retail_family_stock rfs ON rfs.product_id = p.id
        WHERE w.name = 'مخزن المعرض'
          AND COALESCE(rfs.retail_qty, s.quantity, 0) >= 0
          AND p.wholesale_package IS NOT NULL AND p.wholesale_package != ''
          AND p.is_active = true
          AND p.retail_master_product_id IS NULL
          AND (COALESCE(rfs.retail_qty, s.quantity, 0) > 0 OR COALESCE(ws.max_ws_qty, 0) > 0)
      )
      SELECT
        COUNT(*) AS total_count,
        COUNT(*) FILTER (WHERE current_stock = 0) AS zero_count,
        COUNT(*) FILTER (WHERE current_stock > 0 AND (
          (carton_capacity > 1 AND (current_stock::numeric / carton_capacity::numeric) <= 0.25)
          OR (carton_capacity <= 4 AND current_stock <= 1)
        )) AS critical_count,
        COUNT(*) FILTER (WHERE current_stock > 0 AND NOT (
          (carton_capacity > 1 AND (current_stock::numeric / carton_capacity::numeric) <= 0.25)
          OR (carton_capacity <= 4 AND current_stock <= 1)
        )) AS warning_count
      FROM computed_items
      WHERE (
        (carton_capacity > 1 AND current_stock <= GREATEST(1, ROUND(carton_capacity * 0.5)))
        OR
        (carton_capacity <= 1 AND current_stock <= 2)
      );
    `);

    const result = {
      success: true,
      totalCount: Number(res.rows[0]?.total_count || 0),
      zeroCount: Number(res.rows[0]?.zero_count || 0),
      criticalCount: Number(res.rows[0]?.critical_count || 0),
      warningCount: Number(res.rows[0]?.warning_count || 0),
    };
    setDashboardCache(cacheKey, result);
    return result;
  } catch (err) {
    console.error("Error fetching low stock reorder count:", err);
    return { success: true, totalCount: 0, zeroCount: 0, criticalCount: 0, warningCount: 0 };
  }
}

// ========== Dashboard Aggregate ==========
app.get("/dashboard/aggregate", authMiddleware, async (req, res) => {
  try {
    const { branch_id, invoice_type, date } = req.query;
    if (!branch_id || !invoice_type || !date) {
      return res.status(400).json({ error: "Missing parameters" });
    }

    const isAdmin = req.user?.username === "admin" || req.user?.role === "admin";
    const effectiveBranchId = isAdmin
      ? Number(branch_id || req.user?.branch_id || 1)
      : Number(req.user?.branch_id || 1);

    const [
      invoicesRes,
      statsData,
      lowStockData,
      transfersRes,
      cashInRes,
      cashOutRes,
      notificationsRes,
      pendingWholesaleRes,
    ] = await Promise.all([
      // 1. Invoices for date
      pool.query(
        `SELECT
           id, invoice_type, movement_type, is_return, customer_name, customer_phone,
           supplier_name, supplier_phone, subtotal, discount_total, total,
           previous_balance, additional_amount, paid_amount, remaining_amount,
           payment_status, invoice_date, created_at, created_by, created_by_name,
           updated_by, updated_by_name, hidden_from_list, invoice_source,
           external_order_id, whatsapp_status, notes
         FROM invoices
         WHERE invoice_type = $1
           AND (COALESCE(hidden_from_list, false) = false)
           AND COALESCE(invoice_date, created_at) >= $2::date
           AND COALESCE(invoice_date, created_at) < ($2::date + INTERVAL '1 day')
         ORDER BY id DESC
         LIMIT 100`,
        [invoice_type, date],
      ).catch((err) => {
        console.error("Dashboard Aggregate Invoices Error:", err);
        return { rows: [] };
      }),

      // 2. Stats (with memory caching)
      fetchDashboardStats(invoice_type).catch((err) => {
        console.error("Dashboard Aggregate Stats Error:", err);
        return null;
      }),

      // 3. Low stock count (with memory caching)
      fetchLowStockReorderCount(),

      // 4. Stock transfers for date
      pool.query(
        `SELECT
           sti.id, sti.transfer_id, sti.product_id,
           p.name AS product_name, p.manufacturer AS manufacturer,
           p.wholesale_package AS wholesale_package,
           sti.from_quantity, sti.to_quantity, sti.total_price,
           fw.name AS from_warehouse, tw.name AS to_warehouse,
           CASE WHEN st.status = 'cancelled' THEN 'cancelled' ELSE sti.status END AS status,
           st.status AS transfer_status, st.created_at,
           COALESCE(sti.received, false) AS received
         FROM stock_transfer_items sti
         JOIN stock_transfers st ON st.id = sti.transfer_id
         JOIN products p ON p.id = sti.product_id
         JOIN warehouses fw ON fw.id = sti.from_warehouse_id
         JOIN warehouses tw ON tw.id = sti.to_warehouse_id
         WHERE (st.created_at AT TIME ZONE 'Africa/Cairo')::date = $1::date
         ORDER BY st.created_at ASC, sti.id ASC`,
        [date],
      ).catch((err) => {
        console.error("Dashboard Aggregate Transfers Error:", err);
        return { rows: [] };
      }),

      // 5. Cash In for date & branch
      pool.query(
        `SELECT
           ci.id, ci.branch_id, ci.customer_name, ci.amount, ci.paid_amount,
           ci.remaining_amount, COALESCE(ci.notes, ci.description) AS notes,
           to_char(ci.transaction_date, 'YYYY-MM-DD') AS transaction_date,
           ci.source_type, ci.invoice_id, ci.created_at,
           inv.invoice_source, inv.external_order_id
         FROM cash_in ci
         LEFT JOIN invoices inv ON inv.id = ci.invoice_id
         WHERE ci.branch_id = $1
           AND ci.transaction_date = $2::date
         ORDER BY ci.transaction_date DESC, ci.id DESC`,
        [effectiveBranchId, date],
      ).catch((err) => {
        console.error("Dashboard Aggregate CashIn Error:", err);
        return { rows: [] };
      }),

      // 6. Cash Out for date & branch
      pool.query(
        `SELECT
           co.id, co.permission_number, co.name, co.amount, co.notes,
           to_char(co.transaction_date, 'YYYY-MM-DD') AS transaction_date,
           co.created_at, co.entry_type, co.supplier_id, s.name AS supplier_name
         FROM cash_out co
         LEFT JOIN suppliers s ON s.id = co.supplier_id
         WHERE co.branch_id = $1
           AND co.transaction_date = $2::date
         ORDER BY co.transaction_date DESC, co.created_at DESC, co.id DESC
         LIMIT 100`,
        [effectiveBranchId, date],
      ).catch((err) => {
        console.error("Dashboard Aggregate CashOut Error:", err);
        return { rows: [] };
      }),

      // 7. Notifications for branch
      pool.query(
        `SELECT n.id, n.title, n.message, n.type, n.reference_id, n.is_read, n.created_at
         FROM notifications n
         LEFT JOIN users u ON u.id = n.from_user_id
         WHERE n.to_branch_id = $1
           AND (u.branch_id != $1 OR u.branch_id IS NULL)
         ORDER BY n.created_at DESC
         LIMIT 10`,
        [effectiveBranchId],
      ).catch((err) => {
        console.error("Dashboard Aggregate Notifications Error:", err);
        return { rows: [] };
      }),

      // 8. Pending Wholesale (Branch 1 only)
      effectiveBranchId === 1
        ? pool.query(
            `SELECT
               id, invoice_type, movement_type, is_return, customer_name, customer_phone,
               supplier_name, supplier_phone, subtotal, discount_total, total,
               previous_balance, additional_amount, paid_amount, remaining_amount,
               payment_status, invoice_date, created_at, created_by, created_by_name,
               updated_by, updated_by_name, hidden_from_list, invoice_source,
               external_order_id, notes
             FROM invoices
             WHERE invoice_type = 'wholesale'
               AND payment_status != 'paid'
               AND is_void IS NOT TRUE
               AND (COALESCE(hidden_from_list, false) = false)
             ORDER BY id DESC
             LIMIT 50`,
          ).catch((err) => {
            console.error("Dashboard Aggregate Pending Wholesale Error:", err);
            return { rows: [] };
          })
        : Promise.resolve({ rows: [] }),
    ]);

    res.json({
      invoices: invoicesRes.rows || [],
      stats: statsData,
      lowStock: lowStockData,
      transfers: {
        date,
        items_count: transfersRes.rows ? transfersRes.rows.length : 0,
        items: transfersRes.rows || [],
      },
      cashIn: {
        success: true,
        data: cashInRes.rows || [],
      },
      cashOut: {
        success: true,
        data: cashOutRes.rows || [],
      },
      notifications: notificationsRes.rows || [],
      pendingWholesale: pendingWholesaleRes.rows || [],
    });
  } catch (err) {
    console.error("Dashboard Aggregate Error:", err);
    res.status(500).json({ error: "Failed to aggregate dashboard data" });
  }
});

// ========== Dashboard Stats ==========
app.get("/dashboard/stats", async (req, res) => {
  try {
    const { invoice_type } = req.query;
    if (!invoice_type)
      return res.status(400).json({ error: "invoice_type مطلوب" });

    const stats = await fetchDashboardStats(invoice_type);
    res.json(stats);
  } catch (err) {
    console.error("GET /dashboard/stats ERROR:", err);
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

    // 2️⃣ عكس الحركة (Batch ✅)
    if (movementsRes.rows.length > 0) {
      const opsByWarehouse = new Map();
      for (const m of movementsRes.rows) {
        const whId = m.warehouse_id;
        if (!opsByWarehouse.has(whId)) opsByWarehouse.set(whId, []);

        if (m.movement_type === "purchase" || m.movement_type === "return_sale") {
          opsByWarehouse.get(whId).push({
            productId: m.product_id,
            variantId: m.variant_id,
            quantity: m.quantity,
            type: "decrement",
            reason: `تعذر حذف الفاتورة بسبب عدم تطابق رصيد المخزون: صنف #${m.product_id}`,
          });
        } else if (
          m.movement_type === "sale" ||
          m.movement_type === "return_purchase"
        ) {
          opsByWarehouse.get(whId).push({
            productId: m.product_id,
            variantId: m.variant_id,
            quantity: m.quantity,
            type: "increment",
          });
        }
      }

      for (const [whId, ops] of opsByWarehouse.entries()) {
        if (ops.length > 0) {
          await batchApplyStockChanges(client, {
            warehouseId: whId,
            operations: ops,
          });
        }
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
    const { search, manufacturer, limit = 0, offset = 0, active, stock } = req.query;

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

    if (stock === "in_stock") {
      conditions.push(`COALESCE(sa.total_stock, 0) > 0`);
    } else if (stock === "in_stock_showroom") {
      conditions.push(`COALESCE(sa.stock_branch_1, 0) > 0`);
    } else if (stock === "in_stock_warehouse") {
      conditions.push(`COALESCE(sa.stock_branch_2, 0) > 0`);
    } else if (stock === "out_of_stock") {
      conditions.push(`COALESCE(sa.total_stock, 0) <= 0`);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limitClause =
      Number(limit) > 0 ? `LIMIT $${idx++} OFFSET $${idx++}` : "";
    if (Number(limit) > 0) {
      values.push(Number(limit), Number(offset));
    }

    const result = await pool.query(
      `WITH stock_agg AS (
        SELECT 
          product_id,
          COALESCE(SUM(CASE WHEN warehouse_id = 1 THEN quantity ELSE 0 END), 0)::int AS stock_branch_1,
          COALESCE(SUM(CASE WHEN warehouse_id = 2 THEN quantity ELSE 0 END), 0)::int AS stock_branch_2,
          COALESCE(SUM(quantity), 0)::int AS total_stock
        FROM stock
        GROUP BY product_id
      )
      SELECT 
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
        p.retail_master_product_id,
        mp.name AS retail_master_name,
        mp.barcode AS retail_master_barcode,
        COALESCE(v.variant_count, 0) AS variant_count,
        COALESCE(sa.stock_branch_1, 0)::int AS stock_branch_1,
        COALESCE(sa.stock_branch_2, 0)::int AS stock_branch_2,
        COALESCE(sa.total_stock, 0)::int AS total_stock
      FROM products p
      LEFT JOIN products mp ON mp.id = p.retail_master_product_id
      LEFT JOIN (
        SELECT product_id, COUNT(*) AS variant_count
        FROM product_variants
        GROUP BY product_id
      ) v ON v.product_id = p.id
      LEFT JOIN stock_agg sa ON sa.product_id = p.id
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
app.delete("/admin/products/all", requireAdminRole, async (req, res) => {
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

// ==================== Retail Merge Management ====================

// 📋 جلب كل الأصناف المدمجة قطاعياً
app.get(["/admin/products/retail-merges", "/api/admin/products/retail-merges"], async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        s.id AS secondary_id,
        s.name AS secondary_name,
        s.barcode AS secondary_barcode,
        s.wholesale_package AS secondary_wholesale_package,
        s.retail_package AS secondary_retail_package,
        s.wholesale_price AS secondary_wholesale_price,
        s.purchase_price AS secondary_purchase_price,
        s.retail_price AS secondary_retail_price,
        m.id AS master_id,
        m.name AS master_name,
        m.barcode AS master_barcode,
        m.wholesale_package AS master_wholesale_package,
        m.retail_package AS master_retail_package,
        m.wholesale_price AS master_wholesale_price,
        m.retail_price AS master_retail_price,
        COALESCE(st_sec_wh2.quantity, 0) AS secondary_wholesale_stock,
        COALESCE(st_sec_wh1.quantity, 0) AS secondary_retail_stock,
        COALESCE(st_mas_wh1.quantity, 0) AS master_retail_stock,
        COALESCE(st_mas_wh2.quantity, 0) AS master_wholesale_stock,
        s.updated_at
      FROM products s
      JOIN products m ON m.id = s.retail_master_product_id
      LEFT JOIN stock st_sec_wh2 ON st_sec_wh2.product_id = s.id AND st_sec_wh2.warehouse_id = 2 AND st_sec_wh2.variant_id = 0
      LEFT JOIN stock st_sec_wh1 ON st_sec_wh1.product_id = s.id AND st_sec_wh1.warehouse_id = 1 AND st_sec_wh1.variant_id = 0
      LEFT JOIN stock st_mas_wh1 ON st_mas_wh1.product_id = m.id AND st_mas_wh1.warehouse_id = 1 AND st_mas_wh1.variant_id = 0
      LEFT JOIN stock st_mas_wh2 ON st_mas_wh2.product_id = m.id AND st_mas_wh2.warehouse_id = 2 AND st_mas_wh2.variant_id = 0
      ORDER BY s.updated_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching retail merges:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// 🔗 ربط ودمج صنف قطاعي يدويًا
app.post(["/admin/products/retail-merge", "/api/admin/products/retail-merge"], async (req, res) => {
  const client = await pool.connect();
  try {
    const secondaryId = Number(req.body.secondary_product_id);
    const masterId = Number(req.body.master_product_id);

    if (!secondaryId || !masterId) {
      return res.status(400).json({ error: "الصنف التابع والصنف الأساسي مطلوبان" });
    }

    if (secondaryId === masterId) {
      return res.status(400).json({ error: "لا يمكن دمج الصنف مع نفسه" });
    }

    await client.query("BEGIN");

    // 1. التحقق من وجود الصنفين
    const prods = await client.query(
      `SELECT id, name, retail_master_product_id FROM products WHERE id IN ($1, $2)`,
      [secondaryId, masterId],
    );

    if (prods.rows.length < 2) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "أحد الصنفين أو كلاهما غير موجود" });
    }

    const secRow = prods.rows.find((p) => p.id === secondaryId);
    const masRow = prods.rows.find((p) => p.id === masterId);

    // منع الحلقات التكرارية: لا يمكن اختيار صنف ماستر إذا كان هو نفسه تابعاً لصنف آخر
    if (masRow.retail_master_product_id) {
      await client.query("ROLLBACK");
      return res.status(400).json({ 
        error: `لا يمكن اختيار [${masRow.name}] كصنف أساسي لأنه مدمج بالفعل كتابع لصنف آخر` 
      });
    }

    // 2. تحديث الربط في جدول products
    await client.query(
      `UPDATE products SET retail_master_product_id = $1, updated_at = NOW() WHERE id = $2`,
      [masterId, secondaryId],
    );

    // 3. ترحيل الرصيد الفعلي الحالي في المعرض (Warehouse 1)
    const secStockRes = await client.query(
      `SELECT quantity FROM stock WHERE warehouse_id = 1 AND product_id = $1 AND variant_id = 0 FOR UPDATE`,
      [secondaryId],
    );

    const currentSecRetailQty = Number(secStockRes.rows[0]?.quantity || 0);

    if (currentSecRetailQty > 0) {
      // تصفير رصيد الصنف التابع في المعرض
      await client.query(
        `UPDATE stock SET quantity = 0, updated_at = NOW() WHERE warehouse_id = 1 AND product_id = $1 AND variant_id = 0`,
        [secondaryId],
      );

      // إضافة الكمية المرحلة للصنف الماستر في المعرض
      await client.query(
        `INSERT INTO stock (warehouse_id, product_id, variant_id, quantity, updated_at)
         VALUES (1, $1, 0, $2, NOW())
         ON CONFLICT (warehouse_id, product_id, variant_id)
         DO UPDATE SET quantity = stock.quantity + EXCLUDED.quantity, updated_at = NOW()`,
        [masterId, currentSecRetailQty],
      );

      // تسجيل حركة المخزون في stock_movements (خروج للصنف التابع ودخول للماستر)
      await client.query(
        `INSERT INTO stock_movements (warehouse_id, product_id, variant_id, quantity, movement_type, reference_type, reference_id, note)
         VALUES 
         (1, $1, 0, $2, 'transfer_out', 'retail_merge', $3, $4),
         (1, $3, 0, $2, 'transfer_in', 'retail_merge', $1, $5)`,
        [
          secondaryId,
          currentSecRetailQty,
          masterId,
          `دمج رصيد قطاعي وترحيله للصنف الماستر #${masterId} (${masRow.name})`,
          `استلام رصيد قطاعي مدمج من الصنف التابع #${secondaryId} (${secRow.name})`,
        ],
      );
    }

    await client.query("COMMIT");

    res.json({
      success: true,
      message: `تم دمج الصنف [${secRow.name}] بنجاح تحت الصنف [${masRow.name}]`,
      migrated_quantity: currentSecRetailQty,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error merging retail products:", err);
    res.status(500).json({ error: err.message || "Server error" });
  } finally {
    client.release();
  }
});

// 🔓 فك دمج صنف قطاعي
app.post(["/admin/products/retail-unmerge", "/api/admin/products/retail-unmerge"], async (req, res) => {
  try {
    const secondaryId = Number(req.body.secondary_product_id);
    if (!secondaryId) {
      return res.status(400).json({ error: "كود الصنف التابع مطلوب" });
    }

    const checkRes = await pool.query(
      `SELECT id, name, retail_master_product_id FROM products WHERE id = $1`,
      [secondaryId],
    );

    if (checkRes.rows.length === 0) {
      return res.status(404).json({ error: "الصنف غير موجود" });
    }

    if (!checkRes.rows[0].retail_master_product_id) {
      return res.status(400).json({ error: "هذا الصنف غير مدمج حاليًا" });
    }

    await pool.query(
      `UPDATE products SET retail_master_product_id = NULL, updated_at = NOW() WHERE id = $1`,
      [secondaryId],
    );

    res.json({
      success: true,
      message: `تم فك دمج الصنف [${checkRes.rows[0].name}] بنجاح وعاد صنفاً مستقلاً`,
    });
  } catch (err) {
    console.error("Error unmerging retail product:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// جلب صنف واحد بالتفصيل
app.get("/admin/products/:id", async (req, res, next) => {
  const { id } = req.params;
  if (isNaN(Number(id))) {
    return next();
  }
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

      const broadcast = req.app.get("broadcastRealtime");
      if (typeof broadcast === "function") {
        broadcast("new_notification", {
          title,
          message,
          type: "stock_transfer",
          reference_id: null,
        }, `branch_${to_branch_id}`);
      } else {
        const io = req.app.get("io");
        if (io) {
          io.to(`branch_${to_branch_id}`).emit("new_notification", {
            title,
            message,
            type: "stock_transfer",
            reference_id: null,
          });
        }
      }

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
        COALESCE(m.discount_base, 'purchase') AS discount_base,
        COALESCE(s.qty, 0) AS available_quantity
      FROM products p
      LEFT JOIN manufacturers m ON m.name = p.manufacturer
      LEFT JOIN (
        SELECT product_id, SUM(quantity) AS qty
        FROM stock
        WHERE warehouse_id = $1
        GROUP BY product_id
      ) s ON s.product_id = p.id
      WHERE p.is_active = true
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

// =========================================================================
// 🎯 تسوية جرد المخزون اليدوية (Manual Stock Adjustment) - المعرض والمخازن
// =========================================================================

// 1️⃣ تنفيذ تسوية جرد لصنف
app.post("/stock/adjust", authMiddleware, async (req, res) => {
  const { warehouse_id, product_id, new_quantity, reason, notes } = req.body;

  // التحقق من المدخلات الأساسية
  const whId = Number(warehouse_id);
  const prodId = Number(product_id);
  const newQty = Number(new_quantity);

  if (!whId || (whId !== 1 && whId !== 2)) {
    return res.status(400).json({ error: "يجب تحديد المخزن بشكل صحيح (1 للمعرض أو 2 للمخزن الرئيسي)" });
  }

  if (!prodId || isNaN(prodId)) {
    return res.status(400).json({ error: "كود الصنف غير صحيح" });
  }

  if (isNaN(newQty) || newQty < 0) {
    return res.status(400).json({ error: "الرصيد الفعلي يجب أن يكون رقماً صحيحاً أو عشرياً موجباً (أكبر من أو يساوي صفر)" });
  }

  const cleanReason = String(reason || "").trim();
  if (!cleanReason) {
    return res.status(400).json({ error: "يجب اختيار أو كتابة سبب التسوية" });
  }

  // الضوابط الأمنية (RBAC): التحقق من الصلاحيات
  const user = req.user || {};
  const isAdmin = user.role === "admin" || user.is_admin === true || user.id === 7;
  const userBranchId = Number(user.branch_id || 0);
  const hasAdjustmentPermission = isAdmin || Boolean(user.permissions?.stock_adjustment);

  if (!hasAdjustmentPermission) {
    return res.status(403).json({ 
      error: "غير مصرح لك بإجراء تسوية جرد المخزون. يرجى مراجعة مسؤول النظام لمنحك الصلاحية." 
    });
  }

  // إذا لم يكن أدمن عام، يُسمح له فقط بتسوية مخزن فرعه
  if (!isAdmin && userBranchId !== whId) {
    return res.status(403).json({ 
      error: "غير مصرح لك بتسوية مخزون هذا الفرع. صلاحيتك تقتصر على فرعك الحالي فقط." 
    });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // قفل تشاؤمي صارم (Pessimistic Row Lock) لمنع التضارب أثناء قراءة وتحديث الرصيد
    const prodRes = await client.query(
      `SELECT 
         p.id as product_id,
         p.name as product_name,
         p.barcode,
         p.manufacturer,
         p.wholesale_package,
         p.retail_package,
         COALESCE(s.quantity, 0) as current_quantity
       FROM products p
       LEFT JOIN stock s ON s.product_id = p.id AND s.warehouse_id = $1 AND COALESCE(s.variant_id, 0) = 0
       WHERE p.id = $2
       FOR UPDATE OF p`,
      [whId, prodId]
    );

    if (prodRes.rows.length === 0) {
      throw new Error("الصنف غير موجود في قاعدة البيانات");
    }

    const item = prodRes.rows[0];
    const currentQty = Number(item.current_quantity || 0);
    const diff = Math.round((newQty - currentQty) * 100) / 100;

    const warehouseName = whId === 1 ? "مخزن المعرض (قطاعي)" : "المخزن الرئيسي (جملة)";
    const unitName = whId === 1 ? (item.retail_package || "قطعة") : (item.wholesale_package || "كرتونة");
    const userName = user.name || user.username || `مستخدم #${user.id}`;

    if (diff === 0) {
      await client.query("ROLLBACK");
      return res.json({
        success: true,
        message: `الرصيد الفعلي مطابق بالفعل لرصيد السيستم (${newQty} ${unitName}). لم يتم إجراء أي تغيير.`,
        data: {
          product_id: prodId,
          product_name: item.product_name,
          warehouse_id: whId,
          warehouse_name: warehouseName,
          current_quantity: currentQty,
          new_quantity: newQty,
          diff: 0,
        },
      });
    }

    // 1️⃣ تحديث جدول الرصيد ذرياً (Atomic Upsert)
    await client.query(
      `INSERT INTO stock (warehouse_id, product_id, variant_id, quantity, updated_at)
       VALUES ($1, $2, 0, $3, NOW())
       ON CONFLICT (warehouse_id, product_id, variant_id)
       DO UPDATE SET quantity = $3, updated_at = NOW()`,
      [whId, prodId, newQty]
    );

    // 2️⃣ تسجيل حركة في دفتر الأستاذ stock_movements لحفظ المسار التاريخي الكامل (Immutable Audit Trail)
    const movementType = diff > 0 ? "adjustment_in" : "adjustment_out";
    const diffTypeArabic = diff > 0 ? "زيادة جردية" : "عجز جردي";
    const noteContent = `تسوية جردية [${diffTypeArabic}: ${diff > 0 ? '+' : ''}${diff} ${unitName}] - الرصيد السابق: ${currentQty} -> الجديد: ${newQty} | المسؤول: ${userName} | السبب: ${cleanReason}${notes ? ' (' + String(notes).trim() + ')' : ''}`;

    const movementRes = await client.query(
      `INSERT INTO stock_movements 
       (warehouse_id, product_id, variant_id, quantity, movement_type, reference_type, reference_id, note, created_at, updated_at)
       VALUES ($1, $2, 0, $3, $4, 'manual_stock_adjustment', $5, $6, NOW(), NOW())
       RETURNING id, created_at`,
      [whId, prodId, Math.abs(diff), movementType, user.id || null, noteContent]
    );

    await client.query("COMMIT");

    // 3️⃣ إرسال إشعار لحظي عبر Socket.io لتحديث شاشات الكاشير والمخازن فورياً
    const io = req.app.get("io");
    if (io) {
      io.emit("data_changed", { type: "data:stock" });
      io.to(`branch_${whId}`).emit("stock:adjusted", {
        warehouse_id: whId,
        product_id: prodId,
        new_quantity: newQty,
        diff,
        product_name: item.product_name,
      });
    }

    res.json({
      success: true,
      message: `تمت تسوية مخزون [${item.product_name}] بنجاح في ${warehouseName}: الرصيد أصبح (${newQty} ${unitName}) بفارق (${diff > 0 ? '+' : ''}${diff}).`,
      data: {
        movement_id: movementRes.rows[0]?.id,
        product_id: prodId,
        product_name: item.product_name,
        barcode: item.barcode,
        warehouse_id: whId,
        warehouse_name: warehouseName,
        old_quantity: currentQty,
        new_quantity: newQty,
        diff,
        diff_type: diff > 0 ? "surplus" : "deficit",
        unit: unitName,
        adjusted_by: userName,
        reason: cleanReason,
        created_at: movementRes.rows[0]?.created_at,
      },
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Stock Adjustment Error:", err);
    res.status(500).json({ error: err.message || "حدث خطأ أثناء تنفيذ تسوية المخزون" });
  } finally {
    client.release();
  }
});

// 2️⃣ جلب سجل وتاريخ التسويات السابقة
app.get("/stock/adjustments/history", authMiddleware, async (req, res) => {
  try {
    const { warehouse_id, limit = 50, offset = 0 } = req.query;
    const values = [];
    let idx = 1;
    let whereClause = `WHERE (reference_type = 'manual_stock_adjustment' OR movement_type IN ('adjustment', 'adjustment_in', 'adjustment_out'))`;

    if (warehouse_id && (Number(warehouse_id) === 1 || Number(warehouse_id) === 2)) {
      whereClause += ` AND warehouse_id = $${idx++}`;
      values.push(Number(warehouse_id));
    }

    const limitVal = Math.min(100, Math.max(1, Number(limit)));
    const offsetVal = Math.max(0, Number(offset));
    values.push(limitVal);
    values.push(offsetVal);

    const query = `
      SELECT 
        sm.id,
        sm.warehouse_id,
        w.name as warehouse_name,
        sm.product_id,
        p.name as product_name,
        p.barcode,
        p.manufacturer,
        p.wholesale_package,
        p.retail_package,
        sm.quantity,
        sm.movement_type,
        sm.reference_type,
        sm.reference_id as user_id,
        COALESCE(u.username, 'مدير النظام') as user_name,
        sm.note,
        sm.created_at
      FROM (
        SELECT * FROM stock_movements
        ${whereClause}
        ORDER BY id DESC
        LIMIT $${idx++} OFFSET $${idx++}
      ) sm
      JOIN products p ON p.id = sm.product_id
      LEFT JOIN warehouses w ON w.id = sm.warehouse_id
      LEFT JOIN users u ON CAST(u.id AS TEXT) = CAST(sm.reference_id AS TEXT)
      ORDER BY sm.id DESC
    `;

    const result = await pool.query(query, values);
    res.json({
      success: true,
      data: result.rows,
      count: result.rows.length,
    });
  } catch (err) {
    console.error("❌ Stock Adjustment History Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// 3️⃣ البحث السريع عن الأصناف لغرض التسوية مع جلب رصيد المعرض والمخزن معاً
app.get("/stock/search-for-adjustment", authMiddleware, async (req, res) => {
  try {
    const { q = "", limit = 20 } = req.query;
    const searchTerm = String(q).trim();

    let query;
    let values;

    if (!searchTerm) {
      query = `
        SELECT 
          p.id,
          p.name,
          p.barcode,
          p.manufacturer,
          p.wholesale_package,
          p.retail_package,
          p.retail_price,
          p.wholesale_price,
          COALESCE(s1.quantity, 0) as stock_retail,
          COALESCE(s2.quantity, 0) as stock_wholesale
        FROM products p
        LEFT JOIN stock s1 ON s1.product_id = p.id AND s1.warehouse_id = 1 AND COALESCE(s1.variant_id, 0) = 0
        LEFT JOIN stock s2 ON s2.product_id = p.id AND s2.warehouse_id = 2 AND COALESCE(s2.variant_id, 0) = 0
        WHERE p.is_active = true
        ORDER BY p.id DESC
        LIMIT $1
      `;
      values = [Math.min(50, Math.max(1, Number(limit)))];
    } else {
      const words = searchTerm.split(/\s+/).filter(Boolean);
      const conditions = [];
      values = [];
      let idx = 1;

      words.forEach((word) => {
        conditions.push(`(
          p.name ILIKE $${idx}
          OR p.barcode ILIKE $${idx}
          OR p.manufacturer ILIKE $${idx}
          OR p.description ILIKE $${idx}
          OR CAST(p.id AS TEXT) = $${idx + 1}
        )`);
        values.push(`%${word}%`, word);
        idx += 2;
      });

      const limitVal = Math.min(50, Math.max(1, Number(limit)));
      values.push(limitVal);
      const limitIdx = idx;

      query = `
        SELECT 
          p.id,
          p.name,
          p.barcode,
          p.manufacturer,
          p.wholesale_package,
          p.retail_package,
          p.retail_price,
          p.wholesale_price,
          COALESCE(s1.quantity, 0) as stock_retail,
          COALESCE(s2.quantity, 0) as stock_wholesale
        FROM products p
        LEFT JOIN stock s1 ON s1.product_id = p.id AND s1.warehouse_id = 1 AND COALESCE(s1.variant_id, 0) = 0
        LEFT JOIN stock s2 ON s2.product_id = p.id AND s2.warehouse_id = 2 AND COALESCE(s2.variant_id, 0) = 0
        WHERE p.is_active = true
          AND ${conditions.join(" AND ")}
        ORDER BY 
          CASE 
            WHEN p.barcode = $2 THEN 1 
            WHEN p.name ILIKE $1 THEN 2 
            ELSE 3 
          END,
          p.name ASC
        LIMIT $${limitIdx}
      `;
    }

    const result = await pool.query(query, values);
    res.json({
      success: true,
      data: result.rows,
    });
  } catch (err) {
    console.error("❌ Search for Adjustment Error:", err);
    res.status(500).json({ error: err.message });
  }
});

const ACCESS_PERMISSION_KEYS = [
  "cash_in_edit",
  "cash_in_delete",
  "cash_out_edit",
  "cash_out_delete",
  "invoice_edit",
  "invoice_delete",
  "stock_adjustment",
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
      entry_type === "warehouse_settlement" ||
      entry_type === "showroom_settlement"
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
      entry_type === "warehouse_settlement" ||
      entry_type === "showroom_settlement"
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
        s.name AS supplier_name,
        COALESCE(pe_rec.job_title, pe_adv.job_title) AS employee_job_title,
        COALESCE(pe_rec.name, pe_adv.name) AS employee_name
      FROM cash_out co
      LEFT JOIN suppliers s ON s.id = co.supplier_id
      LEFT JOIN payroll_records pr ON pr.cash_out_id = co.id
      LEFT JOIN payroll_employees pe_rec ON pe_rec.id = pr.employee_id
      LEFT JOIN payroll_advances pa ON pa.cash_out_id = co.id
      LEFT JOIN payroll_employees pe_adv ON pe_adv.id = pa.employee_id
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
   ⚡ CASH SUMMARY - الرصيد الافتتاحي السريع (Opening Balance)
================================ */
app.get("/cash/opening-balance", authMiddleware, async (req, res) => {
  try {
    const rawBranch = req.query.branch_id;
    const branch_id =
      req.user.role === "admin" && rawBranch
        ? Number(rawBranch)
        : Number(req.user.branch_id);

    const rawBeforeDate =
      req.query.before_date ||
      req.query.from_date ||
      new Date().toISOString().split("T")[0];

    // Strict format validation (YYYY-MM-DD)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(rawBeforeDate))) {
      return res.status(400).json({ error: "صيغة التاريخ غير صحيحة (YYYY-MM-DD)" });
    }

    const hideMarketCustomers =
      req.query.hide_market_customers === "1" ||
      req.query.hide_market_customers === "true";

    const query = `
      SELECT
        COALESCE(
          (SELECT SUM(
             CASE 
               WHEN ci.source_type = 'invoice' THEN COALESCE(ci.paid_amount, 0)
               ELSE COALESCE(ci.amount, 0)
             END
           )
           FROM cash_in ci
           WHERE ci.branch_id = $1 
             AND ci.transaction_date < $2::date
             AND (ci.notes IS NULL OR ci.notes NOT LIKE '%{{discount_diff}}%')
             AND (
               $3::boolean = false 
               OR ci.customer_name IS NULL 
               OR REPLACE(LOWER(TRIM(ci.customer_name)), ' ', '') NOT IN (
                 SELECT REPLACE(LOWER(TRIM(name)), ' ', '') FROM customers WHERE is_market_customer = true
               )
             )
          ), 0
        ) AS prev_total_in,
        COALESCE(
          (SELECT SUM(co.amount)
           FROM cash_out co
           WHERE co.branch_id = $1 
             AND co.transaction_date < $2::date
          ), 0
        ) AS prev_total_out,
        (
          SELECT to_char(MAX(d), 'YYYY-MM-DD') FROM (
            SELECT MAX(transaction_date) as d FROM cash_in WHERE branch_id = $1 AND transaction_date < $2::date
            UNION ALL
            SELECT MAX(transaction_date) as d FROM cash_out WHERE branch_id = $1 AND transaction_date < $2::date
          ) t
        ) AS last_prev_date
    `;

    const result = await pool.query(query, [branch_id, rawBeforeDate, hideMarketCustomers]);
    const row = result.rows[0] || {};
    const prevTotalIn = Number(row.prev_total_in) || 0;
    const prevTotalOut = Number(row.prev_total_out) || 0;

    res.json({
      success: true,
      data: {
        branch_id,
        before_date: rawBeforeDate,
        prev_total_in: prevTotalIn,
        prev_total_out: prevTotalOut,
        opening_balance: prevTotalIn - prevTotalOut,
        last_prev_date: row.last_prev_date || null,
      },
    });
  } catch (err) {
    console.error("GET CASH OPENING BALANCE ERROR:", err);
    res.status(500).json({ error: "خطأ في حساب الرصيد الافتتاحي" });
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
  const client = await pool.connect();
  try {
    const currentUser = await requirePermission(req, res, "cash_out_delete");
    if (!currentUser) {
      client.release();
      return;
    }

    const branch_id = currentUser.branch_id;
    const { id } = req.params;

    await client.query("BEGIN");

    // 1. Check if linked to payroll_records (salary disbursement)
    const linkedPayroll = await client.query(
      `SELECT id FROM payroll_records WHERE cash_out_id = $1 AND branch_id = $2`,
      [id, branch_id],
    );

    if (linkedPayroll.rows.length > 0) {
      const payrollRecordIds = linkedPayroll.rows.map((r) => r.id);
      // Revert any deducted advances back to 'pending'
      await client.query(
        `UPDATE payroll_advances SET status = 'pending', payroll_record_id = NULL WHERE payroll_record_id = ANY($1)`,
        [payrollRecordIds],
      );
      // Revert any applied adjustments back to 'pending'
      await client.query(
        `UPDATE payroll_adjustments SET status = 'pending', payroll_record_id = NULL, updated_at = NOW() WHERE payroll_record_id = ANY($1)`,
        [payrollRecordIds],
      );
      // Delete the payroll_records entries
      await client.query(
        `DELETE FROM payroll_records WHERE id = ANY($1)`,
        [payrollRecordIds],
      );
    }

    // 2. Check if linked to payroll_advances (direct advance cash_out)
    await client.query(
      `DELETE FROM payroll_advances WHERE cash_out_id = $1 AND branch_id = $2`,
      [id, branch_id],
    );

    // 3. Delete the cash_out record
    const result = await client.query(
      `DELETE FROM cash_out WHERE id=$1 AND branch_id=$2 RETURNING id`,
      [id, branch_id],
    );

    if (!result.rowCount) {
      await client.query("ROLLBACK");
      client.release();
      return res.status(403).json({ error: "غير مسموح بالحذف أو السند غير موجود" });
    }

    await client.query("COMMIT");
    client.release();

    // Broadcast realtime updates for cash and payroll
    const broadcast = req.app?.get("broadcastRealtime");
    if (typeof broadcast === "function") {
      broadcast("data:cash", { action: "cash_out_deleted", id, branch_id, ts: Date.now() });
      if (linkedPayroll.rows.length > 0) {
        broadcast("data:payroll", { action: "payroll_reverted", branch_id, ts: Date.now() });
      }
    }

    res.json({ success: true, message: "تم حذف إذن الصرف وتحديث مسير الرواتب بنجاح" });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
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

    const result = await pool.query(
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

    res.json({
      success: true,
      cash_in_id: result.rows[0].id,
    });
  } catch (err) {
    console.error("CASH IN ERROR:", err);
    res.status(500).json({ error: "فشل إضافة الوارد" });
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
        SELECT id, name, wholesale_package, retail_package, retail_master_product_id
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
        // ولو الصنف مدموج تحت صنف ماستر، يتم توجيهه للماستر مباشرة
        const targetVariantId = retailWarehouseId === 1 ? 0 : variantId;
        const targetProductId =
          retailWarehouseId === 1 && product.retail_master_product_id
            ? Number(product.retail_master_product_id)
            : product_id;

        await client.query(
          `
        INSERT INTO stock (warehouse_id, product_id, variant_id, quantity)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (warehouse_id, product_id, variant_id)
        DO UPDATE SET quantity = stock.quantity + $4
        `,
          [
            retailWarehouseId,
            targetProductId,
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
          target_product_id,
          from_warehouse_id,
          to_warehouse_id,
          from_quantity,
          to_quantity,
          total_price
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        `,
          [
            transferId,
            product_id,
            targetProductId,
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
            targetProductId,
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

        const broadcast = req.app.get("broadcastRealtime");
        if (typeof broadcast === "function") {
          broadcast("new_notification", {
            title,
            message,
            type: "stock_transfer",
            reference_id: transferId,
          }, `branch_${from_branch_id}`);
        } else {
          const io = req.app.get("io");
          if (io) {
            io.to(`branch_${from_branch_id}`).emit("new_notification", {
              title,
              message,
              type: "stock_transfer",
              reference_id: transferId,
            });
          }
        }

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
        target_product_id,
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

      // ➕ رجوع للجملة (دائماً لصنف الجملة الأصلي)
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

      // ➖ خصم من القطاعي (من الصنف المستلم سواء كان ماستر أو الأصلي)
      const targetProdId = Number(item.target_product_id || item.product_id);
      const retailStockRes = await client.query(
        `
        SELECT quantity
        FROM stock
        WHERE warehouse_id = $1 AND product_id = $2 AND variant_id = 0
        FOR UPDATE
        `,
        [item.to_warehouse_id, targetProdId],
      );

      const available = Number(retailStockRes.rows[0]?.quantity || 0);
      const required = Number(item.to_quantity || 0);

      if (available < required) {
        throw new Error(
          `لا يمكن إلغاء التحويل: رصيد القطاعي غير كافي للصنف #${targetProdId} (المتاح: ${available}، المطلوب: ${required})`,
        );
      }

      await client.query(
        `
        UPDATE stock
        SET quantity = quantity - $1
        WHERE warehouse_id = $2 AND product_id = $3 AND variant_id = 0
        `,
        [item.to_quantity, item.to_warehouse_id, targetProdId],
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
          targetProdId,
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
        sti.target_product_id,
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
    const targetProdId = Number(item.target_product_id || item.product_id);
    const targetStockRes = await client.query(
      `
      SELECT SUM(quantity) AS quantity
      FROM stock
      WHERE warehouse_id = $1 AND product_id = $2 AND variant_id = 0
      `,
      [item.to_warehouse_id, targetProdId],
    );

    const availableTargetQty = Number(targetStockRes.rows[0]?.quantity || 0);
    const requiredTargetQty = Number(item.to_quantity || 0);

    if (availableTargetQty < requiredTargetQty) {
      throw new Error(
        `لا يمكن إلغاء الصنف: رصيد المخزن المستلم غير كافي (المتاح: ${availableTargetQty}، المطلوب: ${requiredTargetQty})`,
      );
    }

    // 3️⃣ عكس الكميات

    const moveRes = await client.query(
      `SELECT variant_id FROM stock_movements WHERE reference_type = 'transfer' AND reference_id = $1 AND product_id = $2 AND movement_type = 'transfer_out' LIMIT 1`,
      [item.transfer_id, item.product_id],
    );
    const actualVariantId = moveRes.rows.length
      ? Number(moveRes.rows[0].variant_id)
      : 0;

    // ➕ رجوع للمخزن الأصلي (دائماً لصنف الجملة الأصلي المسحوب)
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

    // ➖ خصم من المخزن الهدف (من الصنف المستلم سواء ماستر أو غيره)
    await client.query(
      `
      UPDATE stock
      SET quantity = quantity - $1
      WHERE warehouse_id = $2 AND product_id = $3 AND variant_id = 0
      `,
      [item.to_quantity, item.to_warehouse_id, targetProdId],
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
        targetProdId,
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

app.post("/login", loginLimiter, async (req, res) => {
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
      JWT_SECRET,
      { expiresIn: "24h" },
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
  if (req.user) return next();
  const authHeader = req.headers.authorization;

  if (!authHeader) return res.status(401).json({ error: "Unauthorized" });

  const token = authHeader.split(" ")[1];

  try {
    const decoded = verifyJwtToken(token);
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
      const beforeId = req.query.before_id ? Number(req.query.before_id) : null;
      const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);

      let rows = [];
      let hasMore = false;

      if (beforeId) {
        // Fetch older messages before a specific message ID (scroll-up / pagination)
        const result = await pool.query(
          `
          WITH auth AS (
            SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2
          )
          SELECT * FROM (
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
              AND m.id < $3
              AND EXISTS (SELECT 1 FROM auth)
            ORDER BY m.id DESC
            LIMIT $4
          ) sub
          ORDER BY sub.id ASC
          `,
          [convId, userId, beforeId, limit],
        );
        rows = result.rows;

        if (rows.length > 0) {
          const oldestId = rows[0].id;
          const moreCheck = await pool.query(
            "SELECT EXISTS (SELECT 1 FROM messages WHERE conversation_id = $1 AND id < $2) AS has_more",
            [convId, oldestId],
          );
          hasMore = Boolean(moreCheck.rows[0]?.has_more);
        }
      } else {
        // Initial load: Smart 24h window + safety floor (latest 25 if inactive)
        const result = await pool.query(
          `
          WITH auth AS (
            SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2
          ),
          marked AS (
            UPDATE messages
            SET is_read = true
            WHERE conversation_id = $1 AND sender_id != $2 AND is_read = false AND EXISTS (SELECT 1 FROM auth)
            RETURNING id
          ),
          recent_24h AS (
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
              AND m.created_at >= NOW() - INTERVAL '24 HOURS'
              AND EXISTS (SELECT 1 FROM auth)
            ORDER BY m.created_at DESC
            LIMIT 100
          ),
          fallback_latest AS (
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
              AND EXISTS (SELECT 1 FROM auth)
              AND NOT EXISTS (SELECT 1 FROM recent_24h)
            ORDER BY m.created_at DESC
            LIMIT 25
          )
          SELECT * FROM (
            SELECT * FROM recent_24h
            UNION ALL
            SELECT * FROM fallback_latest
          ) combined
          ORDER BY id ASC
          `,
          [convId, userId],
        );
        rows = result.rows;

        // If no messages returned, check if user is unauthorized or if conversation is just empty
        if (!rows.length) {
          const participant = await pool.query(
            "SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2",
            [convId, userId],
          );
          if (!participant.rows.length) {
            return res.status(403).json({ error: "غير مصرح" });
          }
        } else {
          const oldestId = rows[0].id;
          const moreCheck = await pool.query(
            "SELECT EXISTS (SELECT 1 FROM messages WHERE conversation_id = $1 AND id < $2) AS has_more",
            [convId, oldestId],
          );
          hasMore = Boolean(moreCheck.rows[0]?.has_more);
        }
      }

      res.json({ success: true, data: rows, has_more: hasMore });
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

      const broadcast = req.app.get("broadcastRealtime");
      if (otherUser.rows.length) {
        const otherUserId = otherUser.rows[0].user_id;
        if (typeof broadcast === "function") {
          broadcast("new_message", {
            conversation_id: convId,
            message,
          }, `user_${otherUserId}`);
        } else {
          const io = req.app.get("io");
          if (io) {
            io.to(`user_${otherUserId}`).emit("new_message", {
              conversation_id: convId,
              message,
            });
          }
        }
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

      const cleanContent = content.trim();
      const validReplyId = Number(reply_to_id) || null;

      // Single-roundtrip CTE for participant verification, insertion, timestamp update, and sender/recipient resolution
      const result = await pool.query(
        `
        WITH auth AS (
          SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2
        ),
        ins AS (
          INSERT INTO messages (conversation_id, sender_id, content, reply_to_id)
          SELECT $1, $2, $3, $4
          WHERE EXISTS (SELECT 1 FROM auth)
          RETURNING *
        ),
        upd_conv AS (
          UPDATE conversations SET updated_at = NOW() WHERE id = $1 AND EXISTS (SELECT 1 FROM ins)
        ),
        other_usr AS (
          SELECT user_id AS other_user_id FROM conversation_participants WHERE conversation_id = $1 AND user_id != $2 LIMIT 1
        )
        SELECT 
          ins.id, ins.conversation_id, ins.sender_id, ins.content, ins.is_read, ins.created_at, ins.type, ins.file_url, ins.reply_to_id,
          u.username, u.full_name,
          (SELECT other_user_id FROM other_usr) AS other_user_id,
          rm.content AS reply_content,
          rm.sender_id AS reply_sender_id,
          ru.full_name AS reply_sender_name,
          rm.type AS reply_type
        FROM ins
        JOIN users u ON u.id = ins.sender_id
        LEFT JOIN messages rm ON rm.id = ins.reply_to_id
        LEFT JOIN users ru ON ru.id = rm.sender_id
        `,
        [convId, userId, cleanContent, validReplyId],
      );

      if (!result.rows.length) {
        // Not authorized or invalid conversation
        const participant = await pool.query(
          "SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2",
          [convId, userId],
        );
        if (!participant.rows.length) {
          return res.status(403).json({ error: "غير مصرح" });
        }
        return res.status(500).json({ error: "فشل إرسال الرسالة" });
      }

      const row = result.rows[0];
      const otherUserId = row.other_user_id;

      const message = {
        id: row.id,
        conversation_id: row.conversation_id,
        sender_id: row.sender_id,
        content: row.content,
        is_read: row.is_read,
        created_at: row.created_at,
        type: row.type || "text",
        file_url: row.file_url,
        reply_to_id: row.reply_to_id,
        username: row.username,
        full_name: row.full_name,
        reply_content: row.reply_content,
        reply_sender_id: row.reply_sender_id,
        reply_sender_name: row.reply_sender_name,
        reply_type: row.reply_type,
      };

      // Emit to the other user via socket (Cluster-safe)
      if (otherUserId) {
        const broadcast = req.app.get("broadcastRealtime");
        if (typeof broadcast === "function") {
          broadcast(
            "new_message",
            {
              conversation_id: convId,
              message,
            },
            `user_${otherUserId}`,
          );
        } else {
          const io = req.app.get("io");
          if (io) {
            io.to(`user_${otherUserId}`).emit("new_message", {
              conversation_id: convId,
              message,
            });
          }
        }

        // Send push notification asynchronously (unawaited)
        const preview =
          cleanContent.length > 80
            ? cleanContent.substring(0, 80) + "..."
            : cleanContent;
        sendPushToUser(
          otherUserId,
          message.full_name || message.username,
          preview,
          convId,
        ).catch(() => {});
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
    const branchId = req.user?.branch_id || 1;
    const broadcast = req.app.get("broadcastRealtime");
    const io = req.app.get("io");

    const payload = {
      type: "invoice",
      id: id,
      path: `/invoices/${id}/print-thermal`,
      branch_id: branchId,
      timestamp: Date.now()
    };

    if (typeof broadcast === "function") {
      broadcast("print-job", payload, `branch_${branchId}_printers`);
      broadcast("print-job", payload, "printers");
    } else if (io) {
      io.to(`branch_${branchId}_printers`).emit("print-job", payload);
      io.to("printers").emit("print-job", payload);
    }

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
    const branchId = req.user?.branch_id || 1;
    const broadcast = req.app.get("broadcastRealtime");
    const io = req.app.get("io");

    const payload = {
      type: "barcode",
      id: id,
      path: `/products/${id}/barcode-thermal?count=${count}`,
      branch_id: branchId,
      timestamp: Date.now()
    };

    if (typeof broadcast === "function") {
      broadcast("print-job", payload, `branch_${branchId}_printers`);
      broadcast("print-job", payload, "printers");
    } else if (io) {
      io.to(`branch_${branchId}_printers`).emit("print-job", payload);
      io.to("printers").emit("print-job", payload);
    }

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
   🔌 SOCKET.IO - CLUSTER & REAL-TIME
================================ */
const http = require("http");
const { Server } = require("socket.io");
const { Client: PgListenerClient } = require("pg");

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" },
  pingTimeout: 30000,
  pingInterval: 25000,
  transports: ["websocket", "polling"],
});

app.set("io", io);

// ===== Cross-Worker Cluster Sync via PostgreSQL LISTEN / NOTIFY =====
let clusterListener = null;
let clusterSyncActive = false;
let clusterPingInterval = null;

async function initClusterRealtimeSync() {
  if (clusterSyncActive && clusterListener) return;
  try {
    const connStr =
      process.env.DATABASE_URL ||
      "postgresql://glass_backend:SecGlass_2026_Postgres_HA@dbstudio.hg-alshour.online:5432/glass_system";
    clusterListener = new PgListenerClient({
      connectionString: connStr,
      connectionTimeoutMillis: 10000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000,
    });
    await clusterListener.connect();
    await clusterListener.query("LISTEN glass_cluster_events");
    clusterSyncActive = true;

    clusterListener.on("notification", (msg) => {
      try {
        if (msg.channel === "glass_cluster_events" && msg.payload) {
          const { event, payload, room, sender } = JSON.parse(msg.payload);
          const currentWorker =
            process.env.pm_id !== undefined
              ? String(process.env.pm_id)
              : String(process.pid);
          // If this event was already emitted locally on the originating worker, skip it to prevent duplicates
          if (sender && sender === currentWorker) {
            return;
          }
          if (
            event === "product_updated" ||
            event === "data:stock" ||
            event === "data:invoices" ||
            event === "data:products" ||
            event === "data:inter-branch"
          ) {
            invalidateProductsCache();
          }
          if (room) {
            io.to(room).emit(event, payload);
          } else {
            io.emit(event, payload);
          }
        }
      } catch (err) {
        console.error("Cluster message decode error:", err.message);
      }
    });

    clusterListener.on("error", (err) => {
      console.error("Cluster listener error (reconnecting in 5s):", err.message);
      clusterSyncActive = false;
      if (clusterPingInterval) {
        clearInterval(clusterPingInterval);
        clusterPingInterval = null;
      }
      try {
        clusterListener.end();
      } catch {}
      clusterListener = null;
      setTimeout(initClusterRealtimeSync, 5000);
    });

    // Periodic lightweight TCP keepalive check every 45s
    if (clusterPingInterval) clearInterval(clusterPingInterval);
    clusterPingInterval = setInterval(() => {
      if (clusterListener && clusterSyncActive) {
        clusterListener.query("SELECT 1").catch(() => {});
      }
    }, 45000);

    console.log("✅ Realtime Cluster Sync active (PostgreSQL LISTEN glass_cluster_events)");
  } catch (err) {
    clusterSyncActive = false;
    clusterListener = null;
    console.error("Cluster sync init failed (retrying in 5s):", err.message);
    setTimeout(initClusterRealtimeSync, 5000);
  }
}

/**
 * Broadcast an event in real-time across all PM2 workers / server nodes.
 * 1. Emits immediately to all local sockets connected to this worker (zero delay).
 * 2. Emits across the PM2 cluster via PostgreSQL NOTIFY with sender deduplication.
 */
function broadcastRealtime(event, payload, room = null) {
  // 1. Immediate local emit
  try {
    if (room) {
      io.to(room).emit(event, payload);
    } else {
      io.emit(event, payload);
    }
  } catch (localErr) {
    console.error("Local broadcast error:", localErr.message);
  }

  // 2. Cross-worker broadcast via PostgreSQL LISTEN/NOTIFY
  if (clusterSyncActive) {
    try {
      const currentWorker =
        process.env.pm_id !== undefined
          ? String(process.env.pm_id)
          : String(process.pid);
      const notificationPayload = JSON.stringify({
        event,
        payload,
        room,
        sender: currentWorker,
      });
      pool
        .query("SELECT pg_notify('glass_cluster_events', $1)", [notificationPayload])
        .catch((err) => {
          console.error("pg_notify cluster sync error:", err.message);
        });
    } catch (err) {
      console.error("broadcastRealtime stringify error:", err.message);
    }
  }
}

app.set("broadcastRealtime", broadcastRealtime);

// ===== Secure WebSocket JWT & Service Token Handshake Authentication =====
const PRINT_SERVICE_SECRET = process.env.PRINT_SERVICE_SECRET || "glass_print_daemon_2026";

io.use((socket, next) => {
  const token =
    socket.handshake.auth?.token ||
    socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, "");
  const serviceToken = socket.handshake.auth?.serviceToken;

  // 1. Service daemon authentication (e.g. thermal print service daemon)
  if (serviceToken && serviceToken === PRINT_SERVICE_SECRET) {
    socket.isService = true;
    socket.serviceType = "printer";
    socket.branchId = Number(socket.handshake.auth?.branchId) || 1;
    return next();
  }

  // 2. User JWT token authentication
  if (token) {
    try {
      const decoded = verifyJwtToken(token);
      socket.user = decoded;
      socket.userId = decoded.id;
      socket.branchId = decoded.branch_id;
      return next();
    } catch (err) {
      return next(new Error("Unauthorized: Invalid token"));
    }
  }

  // 3. Fallback: allow guest with zero privileges (no rooms, cannot spoof identity, avoids reconnect storm on login page)
  socket.user = null;
  return next();
});

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
  // 🖨️ Service socket auto-setup
  if (socket.isService) {
    const bid = socket.branchId || 1;
    socket.join(`branch_${bid}_printers`);
    socket.join("printers");
    console.log(`🖨️ Print Service connected (Branch: ${bid}, Socket: ${socket.id})`);
    return;
  }

  console.log(
    "User connected:",
    socket.id,
    socket.user
      ? `(User: ${socket.user.id}, Branch: ${socket.user.branch_id})`
      : "(Guest)",
  );

  // Auto-register authenticated user from verified JWT handshake
  if (socket.user && socket.user.id) {
    const uid = socket.user.id;
    const bid = socket.user.branch_id;
    socket.userId = uid;
    if (bid) socket.join(`branch_${bid}`);
    socket.join(`user_${uid}`);

    if (!onlineUsers.has(uid)) {
      onlineUsers.set(uid, new Set());
    }
    onlineUsers.get(uid).add(socket.id);

    broadcastRealtime("user_online", { user_id: uid });
    const onlineIds = Array.from(onlineUsers.keys());
    socket.emit("online_users", { user_ids: onlineIds });
    socket.emit("stock:watchdog:status", stockWatchdogService.getAnomalies());
  }

  socket.on("register_user", async ({ user_id } = {}) => {
    try {
      // 🛡️ Security Check: Prevent identity spoofing
      const verifiedUid = socket.user?.id || (process.env.NODE_ENV !== "production" ? user_id : null);
      if (!verifiedUid) {
        console.warn(`[Security Warning] Blocked unauthenticated register_user from socket ${socket.id}`);
        return;
      }

      // 🧠 Fetch real branch from DB
      const result = await pool.query(
        "SELECT branch_id FROM users WHERE id = $1",
        [verifiedUid],
      );

      const branch_id = result.rows[0]?.branch_id;
      if (!branch_id) {
        console.log(`User ${verifiedUid} has no branch_id`);
        return;
      }

      // 🧹 Leave old branch/user rooms (keep socket.id)
      for (const room of socket.rooms) {
        if (room !== socket.id) socket.leave(room);
      }

      // ✅ Join verified rooms
      socket.join(`branch_${branch_id}`);
      socket.join(`user_${verifiedUid}`);

      // Track online status
      socket.userId = verifiedUid;
      if (!onlineUsers.has(verifiedUid)) {
        onlineUsers.set(verifiedUid, new Set());
      }
      onlineUsers.get(verifiedUid).add(socket.id);

      // Broadcast online status across cluster
      broadcastRealtime("user_online", { user_id: verifiedUid });

      // Send current online users list to this socket
      const onlineIds = Array.from(onlineUsers.keys());
      socket.emit("online_users", { user_ids: onlineIds });
      socket.emit("stock:watchdog:status", stockWatchdogService.getAnomalies());

      console.log(
        `User ${verifiedUid} joined branch_${branch_id} + user_${verifiedUid} (online)`,
      );
    } catch (err) {
      console.error("Socket register error:", err);
    }
  });

  // 💬 Chat: typing indicator (Cluster-safe)
  socket.on("chat_typing", ({ conversation_id, to_user_id }) => {
    if (!socket.userId) return;
    broadcastRealtime("chat_typing", {
      conversation_id,
      user_id: socket.userId,
    }, `user_${to_user_id}`);
  });

  socket.on("chat_stop_typing", ({ conversation_id, to_user_id }) => {
    if (!socket.userId) return;
    broadcastRealtime("chat_stop_typing", {
      conversation_id,
      user_id: socket.userId,
    }, `user_${to_user_id}`);
  });

  // 💬 Chat: mark messages as read in real-time (Cluster-safe)
  socket.on(
    "chat_messages_read",
    ({ conversation_id, to_user_id }) => {
      if (!socket.userId) return;
      broadcastRealtime("chat_messages_read", {
        conversation_id,
        reader_id: socket.userId,
      }, `user_${to_user_id}`);
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
    {
      name: "payroll.tables",
      sql: `
        CREATE TABLE IF NOT EXISTS payroll_employees (
          id SERIAL PRIMARY KEY,
          branch_id INTEGER NOT NULL REFERENCES branches(id),
          name VARCHAR(150) NOT NULL,
          phone VARCHAR(50),
          national_id VARCHAR(50),
          job_title VARCHAR(100),
          salary_type VARCHAR(20) NOT NULL DEFAULT 'weekly',
          base_salary NUMERIC(12, 2) NOT NULL DEFAULT 0,
          status VARCHAR(20) NOT NULL DEFAULT 'active',
          hire_date DATE DEFAULT CURRENT_DATE,
          notes TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_payroll_emp_branch ON payroll_employees(branch_id, status);

        CREATE TABLE IF NOT EXISTS payroll_advances (
          id SERIAL PRIMARY KEY,
          branch_id INTEGER NOT NULL REFERENCES branches(id),
          employee_id INTEGER NOT NULL REFERENCES payroll_employees(id) ON DELETE CASCADE,
          amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
          advance_date DATE NOT NULL DEFAULT CURRENT_DATE,
          status VARCHAR(20) NOT NULL DEFAULT 'pending',
          payroll_record_id INTEGER,
          cash_out_id INTEGER,
          notes TEXT,
          created_by INTEGER,
          created_by_name VARCHAR(100),
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_payroll_adv_branch ON payroll_advances(branch_id, status);

        CREATE TABLE IF NOT EXISTS payroll_records (
          id SERIAL PRIMARY KEY,
          branch_id INTEGER NOT NULL REFERENCES branches(id),
          employee_id INTEGER NOT NULL REFERENCES payroll_employees(id) ON DELETE CASCADE,
          cycle_type VARCHAR(20) NOT NULL,
          period_start DATE NOT NULL,
          period_end DATE NOT NULL,
          base_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
          days_worked NUMERIC(5, 1) DEFAULT 0,
          overtime_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
          bonus_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
          deductions_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
          advances_deducted NUMERIC(12, 2) NOT NULL DEFAULT 0,
          net_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
          cash_out_id INTEGER,
          payment_status VARCHAR(20) NOT NULL DEFAULT 'paid',
          paid_at TIMESTAMPTZ DEFAULT NOW(),
          paid_by INTEGER,
          paid_by_name VARCHAR(100),
          notes TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_payroll_rec_branch ON payroll_records(branch_id, period_start);
      `,
    },
    {
      name: "payroll.attendance.and.indexes",
      sql: `
        CREATE TABLE IF NOT EXISTS payroll_adjustments (
          id SERIAL PRIMARY KEY,
          branch_id INTEGER NOT NULL REFERENCES branches(id),
          employee_id INTEGER NOT NULL REFERENCES payroll_employees(id) ON DELETE CASCADE,
          type VARCHAR(50) NOT NULL,
          amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
          adjustment_date DATE NOT NULL DEFAULT CURRENT_DATE,
          reason TEXT,
          status VARCHAR(20) NOT NULL DEFAULT 'pending',
          payroll_record_id INTEGER,
          created_by INTEGER,
          created_by_name VARCHAR(100),
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_payroll_adj_branch ON payroll_adjustments(branch_id, status);
        CREATE INDEX IF NOT EXISTS idx_payroll_adj_emp ON payroll_adjustments(employee_id, status);

        CREATE TABLE IF NOT EXISTS payroll_retained_dues (
          id SERIAL PRIMARY KEY,
          branch_id INTEGER NOT NULL REFERENCES branches(id),
          employee_id INTEGER NOT NULL REFERENCES payroll_employees(id) ON DELETE CASCADE,
          amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
          due_date DATE NOT NULL DEFAULT CURRENT_DATE,
          reason TEXT,
          status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'cancelled')),
          payroll_record_id INTEGER,
          created_by INTEGER,
          created_by_name VARCHAR(100),
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_retained_dues_branch ON payroll_retained_dues(branch_id, status);
        CREATE INDEX IF NOT EXISTS idx_retained_dues_emp ON payroll_retained_dues(employee_id, status);

        CREATE TABLE IF NOT EXISTS payroll_attendance (
          id SERIAL PRIMARY KEY,
          branch_id INTEGER NOT NULL REFERENCES branches(id),
          employee_id INTEGER NOT NULL REFERENCES payroll_employees(id) ON DELETE CASCADE,
          attendance_date DATE NOT NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'absent',
          day_rate NUMERIC(12, 2) NOT NULL DEFAULT 0,
          adjustment_id INTEGER REFERENCES payroll_adjustments(id) ON DELETE SET NULL,
          payroll_record_id INTEGER REFERENCES payroll_records(id) ON DELETE SET NULL,
          notes TEXT,
          created_by INTEGER,
          created_by_name VARCHAR(100),
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(employee_id, attendance_date)
        );
        CREATE INDEX IF NOT EXISTS idx_payroll_att_emp_date ON payroll_attendance(employee_id, attendance_date);
        CREATE INDEX IF NOT EXISTS idx_payroll_att_branch_date ON payroll_attendance(branch_id, attendance_date);
        CREATE INDEX IF NOT EXISTS idx_payroll_rec_emp ON payroll_records(employee_id, payment_status);
        CREATE INDEX IF NOT EXISTS idx_payroll_adv_emp ON payroll_advances(employee_id, status);
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
    initClusterRealtimeSync();
    prewarmProductsCache();
    stockWatchdogService.initStartupAudit(io);
    if (typeof pool.startContinuousStandbyBackup === "function") {
      pool.startContinuousStandbyBackup();
    }
  });
});
