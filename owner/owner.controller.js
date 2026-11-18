const pool = require("../db");
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "glass_system_super_secret_2026";
const OWNER_PIN = process.env.OWNER_PIN || "7777";

// In-Memory Rate Limiting for PIN attempts (IP-based)
const pinAttempts = new Map(); // ip -> { count: number, lockedUntil: number }

// ============================================================================
// 1. DECOUPLED HEAVY AGGREGATES CACHE (Inventory Valuation & Market Debts)
//    Uses Stale-While-Revalidate + Startup Pre-Warming + Debounced Event Sync
// ============================================================================
const ownerHeavyCache = {
  data: null,
  lastUpdated: 0,
  ttlMs: 5 * 60 * 1000, // 5 minutes TTL
  isFetching: false,
  isDirty: false,
};

let heavyRefreshTimer = null;
let lastBroadcastFn = null;

// ============================================================================
// 2. FAST-TRACK PERIOD RESPONSE CACHE (Short TTL, instant write invalidation)
//    Stores all 3 branch views ({ all, "1", "2" }) per date range in RAM
// ============================================================================
const ownerFastCache = new Map(); // `${from}_${to}` -> { ts: number, pillarsByBranch: object }
const FAST_CACHE_TTL_MS = 15 * 1000; // 15 seconds

// Historical As-Of-Date Heavy Cache (for yesterday / last_month / custom past dates)
const ownerHistoricalHeavyCache = new Map(); // `asOfDate` -> { ts: number, data: object }
const HISTORICAL_HEAVY_TTL_MS = 60 * 1000; // 60 seconds

// Trends / Curves Cache (60s TTL, cleared immediately on writes)
const ownerTrendsCache = new Map(); // `${from}_${to}_${mode}` -> { ts: number, payload: object }
const TRENDS_CACHE_TTL_MS = 60 * 1000;

function getCairoTodayIso() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
}

/**
 * Instantly invalidates fast-track cache on any cash/invoice write (0ms overhead)
 */
function invalidateOwnerFastCache() {
  ownerFastCache.clear();
  ownerHistoricalHeavyCache.clear();
  ownerTrendsCache.clear();
}

/**
 * Debounced non-blocking background refresh for heavy cache when invoices/stock/debts change
 * Guarantees 0ms latency impact on operational writes (POS, invoices, cash)
 */
function scheduleOwnerCacheRefresh(broadcastFn) {
  if (typeof broadcastFn === "function") {
    lastBroadcastFn = broadcastFn;
  }
  ownerHeavyCache.isDirty = true;
  ownerFastCache.clear();
  ownerHistoricalHeavyCache.clear();
  ownerTrendsCache.clear();

  if (heavyRefreshTimer) clearTimeout(heavyRefreshTimer);
  heavyRefreshTimer = setTimeout(() => {
    heavyRefreshTimer = null;
    computeHeavyAggregates(lastBroadcastFn).catch((err) => {
      console.error("[Owner Cache] Background refresh error:", err.message);
    });
  }, 6000); // 6s debounce window coalesces bursts of invoices into 1 background refresh
}

/**
 * Pre-warms heavy cache shortly after server boot so first visit is instantaneous
 */
function warmOwnerCache(broadcastFn) {
  if (typeof broadcastFn === "function") {
    lastBroadcastFn = broadcastFn;
  }
  if (ownerHeavyCache.data || ownerHeavyCache.isFetching) return;
  computeHeavyAggregates(lastBroadcastFn)
    .then(() => {
      console.log("🛡️  [Owner Cockpit] Heavy cache pre-warmed successfully");
    })
    .catch((err) => {
      console.error("[Owner Cockpit] Pre-warm error:", err.message);
    });
}

/**
 * Checks if user is eligible for owner access
 */
function isOwnerAuthorized(user) {
  if (!user) return false;
  return (
    Number(user.id) === 7 ||
    user.role === "admin" ||
    user.username === "Mohamed" ||
    user.username === "خالد" ||
    user.username === "hady" ||
    user.username === "hadysa"
  );
}

/**
 * Resolves Date Range from predefined period or custom inputs
 */
function resolveDateRange(period, customFrom, customTo) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  if (customFrom && customTo) {
    return {
      period: "custom",
      from: customFrom,
      to: customTo,
      label: `مخصص (${customFrom} إلى ${customTo})`,
    };
  }

  const todayStr = fmt(now);

  if (period === "yesterday") {
    const y = new Date(now);
    y.setDate(y.getDate() - 1);
    const yStr = fmt(y);
    return { period: "yesterday", from: yStr, to: yStr, label: "أمس" };
  }

  if (period === "this_week") {
    const day = now.getDay(); // 6=Sat, 0=Sun, ...
    const daysSinceSat = (day + 1) % 7;
    const sat = new Date(now);
    sat.setDate(now.getDate() - daysSinceSat);
    return { period: "this_week", from: fmt(sat), to: todayStr, label: "هذا الأسبوع" };
  }

  if (period === "this_month") {
    const mStart = new Date(now.getFullYear(), now.getMonth(), 1);
    return { period: "this_month", from: fmt(mStart), to: todayStr, label: "هذا الشهر" };
  }

  if (period === "last_month") {
    const prevMStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prevMEnd = new Date(now.getFullYear(), now.getMonth(), 0);
    return { period: "last_month", from: fmt(prevMStart), to: fmt(prevMEnd), label: "الشهر السابق" };
  }

  // Default: today
  return { period: "today", from: todayStr, to: todayStr, label: "اليوم" };
}

/**
 * Unlock Owner Session via PIN
 * POST /api/owner/auth/unlock
 */
async function unlockOwnerSession(req, res) {
  try {
    const user = req.user;
    if (!isOwnerAuthorized(user)) {
      return res.status(403).json({ error: "غير مصرح - خاص بإدارة المالك فقط" });
    }

    const clientIp = req.ip || req.connection?.remoteAddress || "local";
    const now = Date.now();

    // Check rate limit
    const attempt = pinAttempts.get(clientIp) || { count: 0, lockedUntil: 0 };
    if (attempt.lockedUntil > now) {
      const waitMin = Math.ceil((attempt.lockedUntil - now) / 60000);
      return res.status(429).json({
        error: `تم تجاوز محاولات الدخول الخاطئة. برجاء الانتظار ${waitMin} دقيقة والمحاولة مرة أخرى.`,
      });
    }

    const { pin } = req.body;
    if (!pin) {
      return res.status(400).json({ error: "برجاء إدخال الرمز السري" });
    }

    if (String(pin).trim() !== String(OWNER_PIN).trim()) {
      attempt.count += 1;
      if (attempt.count >= 5) {
        attempt.lockedUntil = now + 15 * 60 * 1000; // 15 min lock
        pinAttempts.set(clientIp, attempt);
        return res.status(429).json({
          error: "تم إدخال الرمز السري بشكل خاطئ 5 مرات. تم قفل المحاولات لمدة 15 دقيقة لدواعي الأمان.",
        });
      }
      pinAttempts.set(clientIp, attempt);
      const remainingAttempts = 5 - attempt.count;
      return res.status(401).json({
        error: `الرمز السري غير صحيح. المتبقي: ${remainingAttempts} محاولة`,
        remainingAttempts,
      });
    }

    // Success -> reset attempts
    pinAttempts.delete(clientIp);

    // Trigger non-blocking background warm if needed while user unlocks
    const broadcast = req.app.get("broadcastRealtime");
    if (!ownerHeavyCache.data && !ownerHeavyCache.isFetching) {
      computeHeavyAggregates(broadcast).catch(() => {});
    }

    // Sign Ephemeral Owner Session Token (valid for 30 minutes)
    const ownerToken = jwt.sign(
      {
        userId: user.id,
        role: "owner_session",
        iat: Math.floor(Date.now() / 1000),
      },
      JWT_SECRET,
      { expiresIn: "30m" }
    );

    return res.json({
      ok: true,
      ownerToken,
      expiresIn: 1800,
      user: {
        id: user.id,
        name: user.full_name || user.username,
      },
    });
  } catch (err) {
    console.error("unlockOwnerSession error:", err);
    return res.status(500).json({ error: "فشل التحقق من رمز المالك" });
  }
}

/**
 * Middleware: Requires a valid Ephemeral Owner Session Token
 */
function requireOwnerSession(req, res, next) {
  const token = req.headers["x-owner-token"] || req.query.owner_token;
  if (!token) {
    return res.status(403).json({
      error: "مطلوب تصريح جلسة المالك (OWNER_SESSION_REQUIRED)",
      code: "OWNER_PIN_REQUIRED",
    });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== "owner_session") {
      return res.status(403).json({
        error: "رمز جلسة المالك غير صالح",
        code: "OWNER_PIN_REQUIRED",
      });
    }
    req.ownerSession = decoded;
    next();
  } catch (err) {
    return res.status(403).json({
      error: "انتهت جلسة المالك - برجاء إدخال رمز الـ PIN مجدداً",
      code: "OWNER_PIN_REQUIRED",
    });
  }
}

/**
 * Verify Session Status
 * GET /api/owner/auth/status
 */
async function checkOwnerSession(req, res) {
  return res.json({
    ok: true,
    active: true,
    sessionUser: req.ownerSession,
  });
}

/**
 * Heavy Aggregates Computation (Inventory Valuation & Market Debts)
 * Runs asynchronously in background, never blocking operational endpoints
 */
async function computeHeavyAggregates(broadcastFn) {
  if (ownerHeavyCache.isFetching) return;
  ownerHeavyCache.isFetching = true;

  try {
    // 1. Inventory Asset Valuation (Cost & Selling Values matching reports.controller.js)
    const stockQuery = `
      SELECT 
        s.warehouse_id,
        COUNT(DISTINCT s.product_id)::int AS unique_products_count,
        COALESCE(SUM(s.quantity), 0)::numeric AS total_quantity,
        COALESCE(
          SUM(
            s.quantity * CASE 
              WHEN s.warehouse_id = 1 THEN COALESCE(
                NULLIF(pv.retail_purchase_price, 0),
                NULLIF(p.retail_purchase_price, 0),
                NULLIF(pv.purchase_price, 0),
                NULLIF(p.purchase_price, 0),
                0
              )
              ELSE COALESCE(
                NULLIF(pv.purchase_price, 0),
                NULLIF(p.purchase_price, 0),
                NULLIF(pv.retail_purchase_price, 0),
                NULLIF(p.retail_purchase_price, 0),
                0
              )
            END
          ),
          0
        )::numeric AS total_purchase_value,
        COALESCE(
          SUM(
            s.quantity * CASE
              WHEN s.warehouse_id = 1 THEN COALESCE(
                NULLIF(pv.retail_price, 0),
                NULLIF(p.retail_price, 0),
                NULLIF(pv.wholesale_price, 0),
                NULLIF(p.wholesale_price, 0),
                0
              )
              ELSE COALESCE(
                NULLIF(pv.wholesale_price, 0),
                NULLIF(p.wholesale_price, 0),
                NULLIF(pv.retail_price, 0),
                NULLIF(p.retail_price, 0),
                0
              )
            END
          ),
          0
        )::numeric AS total_selling_value
      FROM stock s
      JOIN products p ON s.product_id = p.id
      LEFT JOIN product_variants pv ON s.variant_id = pv.id
      WHERE s.quantity > 0 AND p.is_active = true
      GROUP BY s.warehouse_id
    `;

    // Run Stock Valuation, Per-Branch Customer Balances, and Per-Branch Supplier Balances in PARALLEL
    // Matches /reports/customer-balances and /reports/supplier-balances 100% by passing warehouse_id=1 and warehouse_id=2
    const reportsController = require("../reports/reports.controller");
    const callReport = (fn, query) =>
      new Promise((resolve) => {
        fn(
          { query },
          {
            setHeader: () => {},
            json: resolve,
            status: () => ({ json: () => resolve([]) }),
          }
        );
      }).catch(() => []);

    const [stockRes, custB1Data, custB2Data, supB1Data, supB2Data] = await Promise.all([
      pool.query(stockQuery),
      callReport(reportsController.getCustomerBalances, { warehouse_id: "1" }),
      callReport(reportsController.getCustomerBalances, { warehouse_id: "2" }),
      callReport(reportsController.getSupplierBalances, { warehouse_id: "1" }),
      callReport(reportsController.getSupplierBalances, { warehouse_id: "2" }),
    ]);

    const inventoryByBranch = {
      1: { purchase_value: 0, selling_value: 0, items_count: 0, total_quantity: 0 },
      2: { purchase_value: 0, selling_value: 0, items_count: 0, total_quantity: 0 },
    };

    for (const r of stockRes.rows) {
      const bId = Number(r.warehouse_id) || 1;
      if (!inventoryByBranch[bId]) {
        inventoryByBranch[bId] = { purchase_value: 0, selling_value: 0, items_count: 0, total_quantity: 0 };
      }
      inventoryByBranch[bId].purchase_value = Number(r.total_purchase_value || 0);
      inventoryByBranch[bId].selling_value = Number(r.total_selling_value || 0);
      inventoryByBranch[bId].items_count = Number(r.unique_products_count || 0);
      inventoryByBranch[bId].total_quantity = Number(r.total_quantity || 0);
    }

    const extractRows = (payload, key) =>
      Array.isArray(payload) ? payload : (payload?.[key] || []);

    const sumBalanceDue = (rows) =>
      Math.round(rows.reduce((sum, item) => sum + Number(item.balance_due || 0), 0) * 100) / 100;

    const custB1Rows = extractRows(custB1Data, "customers");
    const custB2Rows = extractRows(custB2Data, "customers");
    const supB1Rows = extractRows(supB1Data, "suppliers");
    const supB2Rows = extractRows(supB2Data, "suppliers");

    const customerDebtsByBranch = {
      1: {
        total_remaining: sumBalanceDue(custB1Rows),
        count_customers: custB1Rows.length,
      },
      2: {
        total_remaining: sumBalanceDue(custB2Rows),
        count_customers: custB2Rows.length,
      },
    };

    const supplierPayablesByBranch = {
      1: {
        total_remaining: sumBalanceDue(supB1Rows),
        count_suppliers: supB1Rows.length,
      },
      2: {
        total_remaining: sumBalanceDue(supB2Rows),
        count_suppliers: supB2Rows.length,
      },
    };

    const supplierPayablesTotal =
      Math.round((supplierPayablesByBranch[1].total_remaining + supplierPayablesByBranch[2].total_remaining) * 100) / 100;

    ownerHeavyCache.data = {
      inventoryByBranch,
      customerDebtsByBranch,
      supplierPayablesByBranch,
      supplierPayablesTotal,
      computedAt: new Date().toISOString(),
    };
    ownerHeavyCache.lastUpdated = Date.now();
    ownerHeavyCache.isDirty = false;
    ownerFastCache.clear();

    // Notify connected owner dashboards in real time that heavy metrics refreshed
    const emit = typeof broadcastFn === "function" ? broadcastFn : lastBroadcastFn;
    if (typeof emit === "function") {
      emit("data:owner", {
        type: "heavy_cache_refreshed",
        computedAt: ownerHeavyCache.data.computedAt,
        ts: Date.now(),
      });
    }
  } catch (err) {
    console.error("computeHeavyAggregates error:", err);
  } finally {
    ownerHeavyCache.isFetching = false;
  }
}

/**
 * Historical As-Of-Date Heavy Aggregates (Inventory Valuation + Market Debts as of YYYY-MM-DD)
 * - Inventory: reconstructs exact historical quantities as of `asOfDate` by reversing post-date stock_movements.
 * - Customer Debts & Supplier Payables: computed cleanly via reportsController with `to = asOfDate`.
 */
async function computeHeavyAggregatesAsOf(asOfDate) {
  const now = Date.now();
  const cached = ownerHistoricalHeavyCache.get(asOfDate);
  if (cached && now - cached.ts < HISTORICAL_HEAVY_TTL_MS) {
    return cached.data;
  }

  const historicalStockQuery = `
    WITH future_deltas AS (
      SELECT
        sm.warehouse_id,
        sm.product_id,
        COALESCE(sm.variant_id, 0) AS variant_id,
        SUM(
          CASE
            WHEN sm.movement_type IN ('purchase', 'transfer_in', 'return_sale', 'adjustment_in', 'in', 'replace_in') THEN sm.quantity
            WHEN sm.movement_type IN ('sale', 'transfer_out', 'return_purchase', 'adjustment_out', 'replace_out') THEN -sm.quantity
            ELSE 0
          END
        )::numeric AS net_delta
      FROM stock_movements sm
      LEFT JOIN invoices i ON i.id = sm.invoice_id
      WHERE COALESCE(i.invoice_date, (sm.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Cairo')::date) > $1::date
        AND (i.id IS NULL OR i.is_void IS NOT TRUE)
      GROUP BY sm.warehouse_id, sm.product_id, COALESCE(sm.variant_id, 0)
    ),
    as_of_stock AS (
      SELECT
        COALESCE(s.warehouse_id, fd.warehouse_id) AS warehouse_id,
        COALESCE(s.product_id, fd.product_id) AS product_id,
        COALESCE(COALESCE(s.variant_id, 0), fd.variant_id) AS variant_id,
        (COALESCE(s.quantity, 0) - COALESCE(fd.net_delta, 0))::numeric AS qty
      FROM stock s
      FULL OUTER JOIN future_deltas fd
        ON s.warehouse_id = fd.warehouse_id
       AND s.product_id = fd.product_id
       AND COALESCE(s.variant_id, 0) = fd.variant_id
    )
    SELECT
      a.warehouse_id,
      COUNT(DISTINCT a.product_id)::int AS unique_products_count,
      COALESCE(SUM(a.qty), 0)::numeric AS total_quantity,
      COALESCE(
        SUM(
          a.qty * CASE
            WHEN a.warehouse_id = 1 THEN COALESCE(
              NULLIF(pv.retail_purchase_price, 0),
              NULLIF(p.retail_purchase_price, 0),
              NULLIF(pv.purchase_price, 0),
              NULLIF(p.purchase_price, 0),
              0
            )
            ELSE COALESCE(
              NULLIF(pv.purchase_price, 0),
              NULLIF(p.purchase_price, 0),
              NULLIF(pv.retail_purchase_price, 0),
              NULLIF(p.retail_purchase_price, 0),
              0
            )
          END
        ),
        0
      )::numeric AS total_purchase_value,
      COALESCE(
        SUM(
          a.qty * CASE
            WHEN a.warehouse_id = 1 THEN COALESCE(
              NULLIF(pv.retail_price, 0),
              NULLIF(p.retail_price, 0),
              NULLIF(pv.wholesale_price, 0),
              NULLIF(p.wholesale_price, 0),
              0
            )
            ELSE COALESCE(
              NULLIF(pv.wholesale_price, 0),
              NULLIF(p.wholesale_price, 0),
              NULLIF(pv.retail_price, 0),
              NULLIF(p.retail_price, 0),
              0
            )
          END
        ),
        0
      )::numeric AS total_selling_value
    FROM as_of_stock a
    JOIN products p ON a.product_id = p.id
    LEFT JOIN product_variants pv ON pv.id = NULLIF(a.variant_id, 0)
    WHERE a.qty > 0 AND p.is_active = true
    GROUP BY a.warehouse_id
  `;

  const reportsController = require("../reports/reports.controller");
  const callReport = (fn, query) =>
    new Promise((resolve) => {
      fn(
        { query },
        {
          setHeader: () => {},
          json: resolve,
          status: () => ({ json: () => resolve([]) }),
        }
      );
    }).catch(() => []);

  const [stockRes, custB1Data, custB2Data, supB1Data, supB2Data] = await Promise.all([
    pool.query(historicalStockQuery, [asOfDate]),
    callReport(reportsController.getCustomerBalances, { warehouse_id: "1", to: asOfDate }),
    callReport(reportsController.getCustomerBalances, { warehouse_id: "2", to: asOfDate }),
    callReport(reportsController.getSupplierBalances, { warehouse_id: "1", to: asOfDate }),
    callReport(reportsController.getSupplierBalances, { warehouse_id: "2", to: asOfDate }),
  ]);

  const inventoryByBranch = {
    1: { purchase_value: 0, selling_value: 0, items_count: 0, total_quantity: 0 },
    2: { purchase_value: 0, selling_value: 0, items_count: 0, total_quantity: 0 },
  };
  for (const r of stockRes.rows) {
    const bId = Number(r.warehouse_id) || 1;
    if (!inventoryByBranch[bId]) {
      inventoryByBranch[bId] = { purchase_value: 0, selling_value: 0, items_count: 0, total_quantity: 0 };
    }
    inventoryByBranch[bId].purchase_value = Number(r.total_purchase_value || 0);
    inventoryByBranch[bId].selling_value = Number(r.total_selling_value || 0);
    inventoryByBranch[bId].items_count = Number(r.unique_products_count || 0);
    inventoryByBranch[bId].total_quantity = Number(r.total_quantity || 0);
  }

  const extractRows = (payload, key) => (Array.isArray(payload) ? payload : payload?.[key] || []);
  const sumBalanceDue = (rows) =>
    Math.round(rows.reduce((sum, item) => sum + Number(item.balance_due || 0), 0) * 100) / 100;

  const custB1Rows = extractRows(custB1Data, "customers");
  const custB2Rows = extractRows(custB2Data, "customers");
  const supB1Rows = extractRows(supB1Data, "suppliers");
  const supB2Rows = extractRows(supB2Data, "suppliers");

  const customerDebtsByBranch = {
    1: { total_remaining: sumBalanceDue(custB1Rows), count_customers: custB1Rows.length },
    2: { total_remaining: sumBalanceDue(custB2Rows), count_customers: custB2Rows.length },
  };
  const supplierPayablesByBranch = {
    1: { total_remaining: sumBalanceDue(supB1Rows), count_suppliers: supB1Rows.length },
    2: { total_remaining: sumBalanceDue(supB2Rows), count_suppliers: supB2Rows.length },
  };
  const supplierPayablesTotal =
    Math.round((supplierPayablesByBranch[1].total_remaining + supplierPayablesByBranch[2].total_remaining) * 100) / 100;

  const data = {
    inventoryByBranch,
    customerDebtsByBranch,
    supplierPayablesByBranch,
    supplierPayablesTotal,
    asOfDate,
    computedAt: new Date().toISOString(),
  };

  if (ownerHistoricalHeavyCache.size > 15) {
    const firstKey = ownerHistoricalHeavyCache.keys().next().value;
    if (firstKey) ownerHistoricalHeavyCache.delete(firstKey);
  }
  ownerHistoricalHeavyCache.set(asOfDate, { ts: now, data });
  return data;
}

/**
 * Force Refresh Cache Endpoint
 * POST /api/owner/refresh-cache
 */
async function refreshOwnerCache(req, res) {
  try {
    const broadcast = req.app.get("broadcastRealtime");
    ownerFastCache.clear();
    ownerHistoricalHeavyCache.clear();
    ownerTrendsCache.clear();
    await computeHeavyAggregates(broadcast);
    return res.json({
      ok: true,
      message: "تم تحديث جرد المخزون والديون بنجاح",
      cachedData: ownerHeavyCache.data,
    });
  } catch (err) {
    return res.status(500).json({ error: "فشل تحديث البيانات المجمعة" });
  }
}

/**
 * Helper: Build a single branch's complete 4-pillar view from aggregated data
 */
function compileBranchPillars(branchKey, cashByBranch, periodSalesByBranch, periodExpensesByBranch, periodCashInByBranch, heavy) {
  const sumBreakdowns = (a, b) => ({
    expenses: Math.round((a.expenses + b.expenses) * 100) / 100,
    purchases: Math.round((a.purchases + b.purchases) * 100) / 100,
    supplierPayments: Math.round((a.supplierPayments + b.supplierPayments) * 100) / 100,
    warehouseSettlement: Math.round((a.warehouseSettlement + b.warehouseSettlement) * 100) / 100,
    showroomSettlement: Math.round((a.showroomSettlement + b.showroomSettlement) * 100) / 100,
  });

  // Branch 1 (Showroom / Retail): carries over opening balance daily (includeOpeningBalance = true)
  // Branch 2 (Warehouses / Wholesale): daily/period actual cash only, NO lifetime carryover (matches /cash/summary isWholesaleUser rule)
  const branch1ActualCash = cashByBranch[1].net;
  const branch2ActualPeriodCash = Math.round((periodCashInByBranch[2] - periodExpensesByBranch[2].total) * 100) / 100;

  let usesOpeningBalance = true;
  let cashBalance = 0;
  let lifetimeCashIn = 0;
  let lifetimeCashOut = 0;
  let openingIn = 0;
  let openingOut = 0;
  let openingBalance = 0;
  let lifetimeOutBreakdown;
  let periodSales = 0;
  let periodPaid = 0;
  let periodExpenses = 0;
  let periodOutBreakdown;
  let periodInvoicesCount = 0;
  let periodCashInTotal = 0;
  let periodCashOutTotal = 0;

  let inventoryCost = 0;
  let inventorySale = 0;
  let inventoryQty = 0;
  let customerDebts = 0;
  let customerCount = 0;
  let supplierPayables = 0;
  let supplierCount = 0;

  const supB1 = heavy.supplierPayablesByBranch?.[1]?.total_remaining || 0;
  const supB2 = heavy.supplierPayablesByBranch?.[2]?.total_remaining || 0;
  const supB1Count = heavy.supplierPayablesByBranch?.[1]?.count_suppliers || 0;
  const supB2Count = heavy.supplierPayablesByBranch?.[2]?.count_suppliers || 0;
  const custB1 = heavy.customerDebtsByBranch?.[1]?.total_remaining || 0;
  const custB2 = heavy.customerDebtsByBranch?.[2]?.total_remaining || 0;
  const custB1Count = heavy.customerDebtsByBranch?.[1]?.count_customers || 0;
  const custB2Count = heavy.customerDebtsByBranch?.[2]?.count_customers || 0;

  if (branchKey === "1") {
    usesOpeningBalance = true;
    cashBalance = branch1ActualCash;
    lifetimeCashIn = cashByBranch[1].in;
    lifetimeCashOut = cashByBranch[1].out;
    openingIn = cashByBranch[1].openingIn;
    openingOut = cashByBranch[1].openingOut;
    openingBalance = cashByBranch[1].openingNet;
    lifetimeOutBreakdown = cashByBranch[1].breakdown;
    periodSales = periodSalesByBranch[1].sales;
    periodPaid = periodSalesByBranch[1].paid;
    periodExpenses = periodExpensesByBranch[1].total;
    periodOutBreakdown = periodExpensesByBranch[1].breakdown;
    periodInvoicesCount = periodSalesByBranch[1].count;
    periodCashInTotal = periodCashInByBranch[1];
    periodCashOutTotal = periodExpensesByBranch[1].total;

    inventoryCost = heavy.inventoryByBranch?.[1]?.purchase_value || 0;
    inventorySale = heavy.inventoryByBranch?.[1]?.selling_value || 0;
    inventoryQty = heavy.inventoryByBranch?.[1]?.total_quantity || 0;
    customerDebts = custB1;
    customerCount = custB1Count;
    supplierPayables = supB1;
    supplierCount = supB1Count;
  } else if (branchKey === "2") {
    // Warehouse (Branch 2): Period-scoped actual cash drawer (NO ghost lifetime carryover!)
    usesOpeningBalance = false;
    cashBalance = branch2ActualPeriodCash;
    lifetimeCashIn = periodCashInByBranch[2];
    lifetimeCashOut = periodExpensesByBranch[2].total;
    openingIn = 0;
    openingOut = 0;
    openingBalance = 0;
    lifetimeOutBreakdown = periodExpensesByBranch[2].breakdown;
    periodSales = periodSalesByBranch[2].sales;
    periodPaid = periodSalesByBranch[2].paid;
    periodExpenses = periodExpensesByBranch[2].total;
    periodOutBreakdown = periodExpensesByBranch[2].breakdown;
    periodInvoicesCount = periodSalesByBranch[2].count;
    periodCashInTotal = periodCashInByBranch[2];
    periodCashOutTotal = periodExpensesByBranch[2].total;

    inventoryCost = heavy.inventoryByBranch?.[2]?.purchase_value || 0;
    inventorySale = heavy.inventoryByBranch?.[2]?.selling_value || 0;
    inventoryQty = heavy.inventoryByBranch?.[2]?.total_quantity || 0;
    customerDebts = custB2;
    customerCount = custB2Count;
    supplierPayables = supB2;
    supplierCount = supB2Count;
  } else {
    // Combined All Branches: Showroom cumulative + Warehouse period actual
    usesOpeningBalance = true;
    cashBalance = Math.round((branch1ActualCash + branch2ActualPeriodCash) * 100) / 100;
    lifetimeCashIn = Math.round((cashByBranch[1].in + periodCashInByBranch[2]) * 100) / 100;
    lifetimeCashOut = Math.round((cashByBranch[1].out + periodExpensesByBranch[2].total) * 100) / 100;
    openingIn = cashByBranch[1].openingIn;
    openingOut = cashByBranch[1].openingOut;
    openingBalance = cashByBranch[1].openingNet;
    lifetimeOutBreakdown = sumBreakdowns(cashByBranch[1].breakdown, periodExpensesByBranch[2].breakdown);
    periodSales = Math.round((periodSalesByBranch[1].sales + periodSalesByBranch[2].sales) * 100) / 100;
    periodPaid = Math.round((periodSalesByBranch[1].paid + periodSalesByBranch[2].paid) * 100) / 100;
    periodExpenses = Math.round((periodExpensesByBranch[1].total + periodExpensesByBranch[2].total) * 100) / 100;
    periodOutBreakdown = sumBreakdowns(periodExpensesByBranch[1].breakdown, periodExpensesByBranch[2].breakdown);
    periodInvoicesCount = periodSalesByBranch[1].count + periodSalesByBranch[2].count;
    periodCashInTotal = Math.round((periodCashInByBranch[1] + periodCashInByBranch[2]) * 100) / 100;
    periodCashOutTotal = Math.round((periodExpensesByBranch[1].total + periodExpensesByBranch[2].total) * 100) / 100;

    inventoryCost = Math.round(((heavy.inventoryByBranch?.[1]?.purchase_value || 0) + (heavy.inventoryByBranch?.[2]?.purchase_value || 0)) * 100) / 100;
    inventorySale = Math.round(((heavy.inventoryByBranch?.[1]?.selling_value || 0) + (heavy.inventoryByBranch?.[2]?.selling_value || 0)) * 100) / 100;
    inventoryQty = (heavy.inventoryByBranch?.[1]?.total_quantity || 0) + (heavy.inventoryByBranch?.[2]?.total_quantity || 0);
    customerDebts = Math.round((custB1 + custB2) * 100) / 100;
    customerCount = custB1Count + custB2Count;
    supplierPayables = Math.round((supB1 + supB2) * 100) / 100;
    supplierCount = supB1Count + supB2Count;
  }

  const totalInWithOpening = Math.round((openingBalance + periodCashInTotal) * 100) / 100;
  const periodNetCashFlow = Math.round((periodCashInTotal - periodCashOutTotal) * 100) / 100;
  const inventoryExpectedProfit = Math.max(0, Math.round((inventorySale - inventoryCost) * 100) / 100);
  const netMarketPosition = Math.round((customerDebts - supplierPayables) * 100) / 100;

  const operationsPayload = {
    salesTotal: periodSales,
    paidCash: periodCashInTotal,
    invoicePaidCash: periodPaid,
    expenses: periodExpenses,
    outBreakdown: periodOutBreakdown,
    netCashFlow: periodNetCashFlow,
    invoicesCount: periodInvoicesCount,
    mtdSales: periodSales,
  };

  return {
    treasury: {
      usesOpeningBalance,
      totalCash: cashBalance,
      openingIn,
      openingOut,
      openingBalance,
      totalInWithOpening,
      lifetimeCashIn,
      lifetimeCashOut,
      lifetimeOutBreakdown,
      periodOutBreakdown,
      branch1In: cashByBranch[1].in,
      branch2In: periodCashInByBranch[2],
      branch1Cash: branch1ActualCash,
      branch2Cash: branch2ActualPeriodCash,
      combinedBranchesCash: Math.round((branch1ActualCash + branch2ActualPeriodCash) * 100) / 100,
      periodCashIn: periodCashInTotal,
      periodCashOut: periodCashOutTotal,
      periodNetCash: periodNetCashFlow,
    },
    operations: operationsPayload,
    operationsToday: operationsPayload,
    market: {
      customerDebtsTotal: customerDebts,
      customerCount,
      supplierPayablesTotal: supplierPayables,
      supplierCount,
      netMarketPosition,
      branch1CustomerDebts: custB1,
      branch2CustomerDebts: custB2,
      branch1SupplierPayables: supB1,
      branch2SupplierPayables: supB2,
    },
    inventory: {
      costValue: inventoryCost,
      saleValue: inventorySale,
      expectedProfit: inventoryExpectedProfit,
      totalQuantity: inventoryQty,
      branch1Cost: heavy.inventoryByBranch[1]?.purchase_value || 0,
      branch2Cost: heavy.inventoryByBranch[2]?.purchase_value || 0,
    },
  };
}

/**
 * Main Owner Cockpit Metrics Endpoint
 * GET /api/owner/metrics?branch=all&period=today&from=YYYY-MM-DD&to=YYYY-MM-DD
 * Returns ALL 3 branch views ({ all, "1", "2" }) in 1 fast parallel call for 0ms instant branch switching!
 */
async function getOwnerMetrics(req, res) {
  try {
    const branchFilter = req.query.branch || "all";
    const periodParam = req.query.period || "today";
    const fromParam = req.query.from || null;
    const toParam = req.query.to || null;
    const forceRefresh = req.query.force_refresh === "true";
    const broadcast = req.app.get("broadcastRealtime");

    const dateRange = resolveDateRange(periodParam, fromParam, toParam);
    const todayIso = getCairoTodayIso();
    const isHistorical = Boolean(dateRange.to && dateRange.to < todayIso);
    const cacheKey = `${dateRange.from}_${dateRange.to}`;
    const now = Date.now();

    // 1. HEAVY AGGREGATES:
    // - Live (today / ending today+): Stale-While-Revalidate from RAM cache (0ms!)
    // - Historical (ending before today): As-of-date Inventory & Market Debts snapshot!
    if (forceRefresh) {
      ownerFastCache.clear();
      ownerHistoricalHeavyCache.clear();
      if (!isHistorical) {
        await computeHeavyAggregates(broadcast);
      }
    } else if (!isHistorical) {
      if (!ownerHeavyCache.data) {
        await computeHeavyAggregates(broadcast);
      } else if (ownerHeavyCache.isDirty || now - ownerHeavyCache.lastUpdated > ownerHeavyCache.ttlMs) {
        // Serve immediately from RAM & refresh silently in background!
        computeHeavyAggregates(broadcast).catch(() => {});
      }
    }

    const fallbackHeavy = {
      inventoryByBranch: {
        1: { purchase_value: 0, selling_value: 0, items_count: 0, total_quantity: 0 },
        2: { purchase_value: 0, selling_value: 0, items_count: 0, total_quantity: 0 },
      },
      customerDebtsByBranch: {
        1: { total_remaining: 0, count_customers: 0 },
        2: { total_remaining: 0, count_customers: 0 },
      },
      supplierPayablesByBranch: {
        1: { total_remaining: 0, count_suppliers: 0 },
        2: { total_remaining: 0, count_suppliers: 0 },
      },
      supplierPayablesTotal: 0,
      computedAt: new Date().toISOString(),
    };

    // 2. FAST-TRACK CACHE CHECK (15s RAM cache, instantly invalidated on writes)
    let pillarsByBranch = null;
    let fastCacheHit = false;
    const cachedFast = ownerFastCache.get(cacheKey);
    if (!forceRefresh && cachedFast && now - cachedFast.ts < FAST_CACHE_TTL_MS) {
      pillarsByBranch = cachedFast.pillarsByBranch;
      fastCacheHit = true;
    }

    if (!pillarsByBranch) {
      // Execute ALL lightweight SQL aggregations (+ historical heavy snapshot if needed) in PARALLEL
      const [
        cashInRes,
        cashOutRes,
        openingInRes,
        openingOutRes,
        periodSalesRes,
        periodExpensesRes,
        periodCashInRes,
        resolvedHeavy,
      ] = await Promise.all([
        pool.query(
          `
          SELECT 
            branch_id,
            COALESCE(SUM(
              CASE 
                WHEN source_type = 'invoice' THEN COALESCE(paid_amount, 0)
                ELSE COALESCE(amount, 0)
              END
            ), 0)::numeric AS total_in
          FROM cash_in
          WHERE COALESCE(transaction_date, created_at::date) <= $1::date
            AND (notes IS NULL OR notes NOT LIKE '%{{discount_diff}}%')
          GROUP BY branch_id
          `,
          [dateRange.to]
        ),
        pool.query(
          `
          SELECT branch_id, entry_type, COALESCE(SUM(amount), 0)::numeric AS total_out
          FROM cash_out
          WHERE COALESCE(transaction_date, created_at::date) <= $1::date
          GROUP BY branch_id, entry_type
          `,
          [dateRange.to]
        ),
        pool.query(
          `
          SELECT 
            branch_id,
            COALESCE(SUM(
              CASE 
                WHEN source_type = 'invoice' THEN COALESCE(paid_amount, 0)
                ELSE COALESCE(amount, 0)
              END
            ), 0)::numeric AS total_in
          FROM cash_in
          WHERE COALESCE(transaction_date, created_at::date) < $1::date
            AND (notes IS NULL OR notes NOT LIKE '%{{discount_diff}}%')
          GROUP BY branch_id
          `,
          [dateRange.from]
        ),
        pool.query(
          `
          SELECT branch_id, COALESCE(SUM(amount), 0)::numeric AS total_out
          FROM cash_out
          WHERE COALESCE(transaction_date, created_at::date) < $1::date
          GROUP BY branch_id
          `,
          [dateRange.from]
        ),
        pool.query(
          `
          SELECT 
            branch_id,
            COUNT(*)::int AS count_invoices,
            COALESCE(SUM(total), 0)::numeric AS total_sales,
            COALESCE(SUM(paid_amount), 0)::numeric AS total_paid,
            COALESCE(SUM(remaining_amount), 0)::numeric AS total_remaining
          FROM invoices
          WHERE invoice_date >= $1::date AND invoice_date <= $2::date
            AND movement_type = 'sale'
            AND (is_void IS NULL OR is_void = false)
          GROUP BY branch_id
          `,
          [dateRange.from, dateRange.to]
        ),
        pool.query(
          `
          SELECT branch_id, entry_type, COALESCE(SUM(amount), 0)::numeric AS total_expenses
          FROM cash_out
          WHERE COALESCE(transaction_date, created_at::date) >= $1::date
            AND COALESCE(transaction_date, created_at::date) <= $2::date
          GROUP BY branch_id, entry_type
          `,
          [dateRange.from, dateRange.to]
        ),
        pool.query(
          `
          SELECT 
            branch_id,
            COALESCE(SUM(
              CASE 
                WHEN source_type = 'invoice' THEN COALESCE(paid_amount, 0)
                ELSE COALESCE(amount, 0)
              END
            ), 0)::numeric AS total_in
          FROM cash_in
          WHERE COALESCE(transaction_date, created_at::date) >= $1::date
            AND COALESCE(transaction_date, created_at::date) <= $2::date
            AND (notes IS NULL OR notes NOT LIKE '%{{discount_diff}}%')
          GROUP BY branch_id
          `,
          [dateRange.from, dateRange.to]
        ),
        isHistorical
          ? computeHeavyAggregatesAsOf(dateRange.to)
          : Promise.resolve(ownerHeavyCache.data || fallbackHeavy),
      ]);

      const heavy = resolvedHeavy || fallbackHeavy;

      const makeBreakdown = () => ({
        expenses: 0,
        purchases: 0,
        supplierPayments: 0,
        warehouseSettlement: 0,
        showroomSettlement: 0,
      });

      const cashByBranch = {
        1: { in: 0, out: 0, net: 0, openingIn: 0, openingOut: 0, openingNet: 0, breakdown: makeBreakdown() },
        2: { in: 0, out: 0, net: 0, openingIn: 0, openingOut: 0, openingNet: 0, breakdown: makeBreakdown() },
      };

      for (const r of cashInRes.rows) {
        const bId = Number(r.branch_id);
        if (cashByBranch[bId]) cashByBranch[bId].in = Number(r.total_in || 0);
      }
      for (const r of openingInRes.rows) {
        const bId = Number(r.branch_id);
        if (cashByBranch[bId]) cashByBranch[bId].openingIn = Number(r.total_in || 0);
      }
      for (const r of openingOutRes.rows) {
        const bId = Number(r.branch_id);
        if (cashByBranch[bId]) cashByBranch[bId].openingOut = Number(r.total_out || 0);
      }
      for (const r of cashOutRes.rows) {
        const bId = Number(r.branch_id);
        const amt = Number(r.total_out || 0);
        if (cashByBranch[bId]) {
          cashByBranch[bId].out += amt;
          const t = r.entry_type;
          if (t === "purchase") cashByBranch[bId].breakdown.purchases += amt;
          else if (t === "supplier_payment") cashByBranch[bId].breakdown.supplierPayments += amt;
          else if (t === "warehouse_settlement") cashByBranch[bId].breakdown.warehouseSettlement += amt;
          else if (t === "showroom_settlement") cashByBranch[bId].breakdown.showroomSettlement += amt;
          else cashByBranch[bId].breakdown.expenses += amt;
        }
      }
      for (const bId of [1, 2]) {
        cashByBranch[bId].out = Math.round(cashByBranch[bId].out * 100) / 100;
        cashByBranch[bId].net = Math.round((cashByBranch[bId].in - cashByBranch[bId].out) * 100) / 100;
        cashByBranch[bId].openingNet = Math.round((cashByBranch[bId].openingIn - cashByBranch[bId].openingOut) * 100) / 100;
      }

      const periodSalesByBranch = {
        1: { count: 0, sales: 0, paid: 0, remaining: 0 },
        2: { count: 0, sales: 0, paid: 0, remaining: 0 },
      };
      for (const r of periodSalesRes.rows) {
        const bId = Number(r.branch_id);
        if (periodSalesByBranch[bId]) {
          periodSalesByBranch[bId].count = Number(r.count_invoices || 0);
          periodSalesByBranch[bId].sales = Number(r.total_sales || 0);
          periodSalesByBranch[bId].paid = Number(r.total_paid || 0);
          periodSalesByBranch[bId].remaining = Number(r.total_remaining || 0);
        }
      }

      const periodExpensesByBranch = {
        1: { total: 0, breakdown: makeBreakdown() },
        2: { total: 0, breakdown: makeBreakdown() },
      };
      for (const r of periodExpensesRes.rows) {
        const bId = Number(r.branch_id);
        const amt = Number(r.total_expenses || 0);
        if (periodExpensesByBranch[bId]) {
          periodExpensesByBranch[bId].total += amt;
          const t = r.entry_type;
          if (t === "purchase") periodExpensesByBranch[bId].breakdown.purchases += amt;
          else if (t === "supplier_payment") periodExpensesByBranch[bId].breakdown.supplierPayments += amt;
          else if (t === "warehouse_settlement") periodExpensesByBranch[bId].breakdown.warehouseSettlement += amt;
          else if (t === "showroom_settlement") periodExpensesByBranch[bId].breakdown.showroomSettlement += amt;
          else periodExpensesByBranch[bId].breakdown.expenses += amt;
        }
      }

      const periodCashInByBranch = { 1: 0, 2: 0 };
      for (const r of periodCashInRes.rows) {
        const bId = Number(r.branch_id);
        if (periodCashInByBranch[bId] !== undefined) {
          periodCashInByBranch[bId] = Number(r.total_in || 0);
        }
      }

      // Build ALL 3 branch views simultaneously for 0ms client-side switching!
      pillarsByBranch = {
        all: compileBranchPillars("all", cashByBranch, periodSalesByBranch, periodExpensesByBranch, periodCashInByBranch, heavy),
        "1": compileBranchPillars("1", cashByBranch, periodSalesByBranch, periodExpensesByBranch, periodCashInByBranch, heavy),
        "2": compileBranchPillars("2", cashByBranch, periodSalesByBranch, periodExpensesByBranch, periodCashInByBranch, heavy),
      };

      // Cache in RAM (evict oldest if > 20 periods stored)
      if (ownerFastCache.size > 20) {
        const firstKey = ownerFastCache.keys().next().value;
        if (firstKey) ownerFastCache.delete(firstKey);
      }
      ownerFastCache.set(cacheKey, { ts: now, pillarsByBranch });
    }

    const selectedPillars = pillarsByBranch[branchFilter] || pillarsByBranch.all;

    return res.json({
      ok: true,
      branch: branchFilter,
      dateRange: {
        period: dateRange.period,
        label: dateRange.label,
        from: dateRange.from,
        to: dateRange.to,
        isHistorical,
      },
      serverTime: new Date().toISOString(),
      cacheInfo: {
        lastUpdated: new Date(ownerHeavyCache.lastUpdated || Date.now()).toISOString(),
        ageSeconds: Math.round((Date.now() - (ownerHeavyCache.lastUpdated || Date.now())) / 1000),
        isRefreshing: ownerHeavyCache.isFetching,
        fastCacheHit,
      },
      pillars: selectedPillars,
      pillarsByBranch,
    });
  } catch (err) {
    console.error("getOwnerMetrics error:", err);
    return res.status(500).json({ error: "فشل تحميل مؤشرات لوحة المالك", details: err.message });
  }
}

// ============================================================================
// 5. EXECUTIVE TRENDS & CURVES ENDPOINT (GET /api/owner/trends)
//    Returns ALL 3 branch curves ({ all, "1", "2" }) in 1 parallel call for 0ms switching!
// ============================================================================
function shiftIsoDate(isoDate, deltaDays) {
  const [y, m, d] = String(isoDate).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  return dt.toISOString().slice(0, 10);
}

function diffIsoDays(startIso, endIso) {
  const [y1, m1, d1] = String(startIso).split("-").map(Number);
  const [y2, m2, d2] = String(endIso).split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function formatArabicBucketLabel(key, granularity) {
  if (granularity === "hour") return key; // "00:00" .. "23:00"
  if (granularity === "month") {
    const [y, m] = key.split("-");
    return `${m}/${y.slice(2)}`;
  }
  const parts = key.split("-");
  return parts.length === 3 ? `${parts[2]}/${parts[1]}` : key;
}

function generateBucketKeys(windowFrom, windowTo, granularity) {
  const keys = [];
  if (granularity === "hour") {
    for (let h = 0; h < 24; h++) {
      keys.push(`${String(h).padStart(2, "0")}:00`);
    }
    return keys;
  }
  if (granularity === "month") {
    let [y, m] = windowFrom.split("-").map(Number);
    const [ey, em] = windowTo.split("-").map(Number);
    let guard = 0;
    while ((y < ey || (y === ey && m <= em)) && guard < 48) {
      keys.push(`${y}-${String(m).padStart(2, "0")}`);
      m++;
      if (m > 12) {
        m = 1;
        y++;
      }
      guard++;
    }
    return keys;
  }
  // day or week (daily buckets for clean continuous curves; week buckets every 7 days)
  const step = granularity === "week" ? 7 : 1;
  const totalDays = Math.min(365, Math.max(0, diffIsoDays(windowFrom, windowTo)));
  for (let offset = 0; offset <= totalDays; offset += step) {
    keys.push(shiftIsoDate(windowFrom, offset));
  }
  if (keys[keys.length - 1] !== windowTo && step === 1) {
    keys.push(windowTo);
  }
  return keys;
}

async function getOwnerTrends(req, res) {
  try {
    const periodParam = req.query.period || "today";
    const fromParam = req.query.from || null;
    const toParam = req.query.to || null;
    const modeParam = req.query.mode === "hourly" ? "hourly" : "daily";
    const forceRefresh = req.query.force_refresh === "true";

    const dateRange = resolveDateRange(periodParam, fromParam, toParam);
    const todayIso = getCairoTodayIso();
    const isSingleDay = dateRange.from === dateRange.to;

    let granularity = "day";
    let windowFrom = dateRange.from;
    let windowTo = dateRange.to;

    if (isSingleDay) {
      if (modeParam === "hourly") {
        granularity = "hour";
      } else {
        granularity = "day";
        windowFrom = shiftIsoDate(dateRange.to, -13); // Trailing 14-day curve ending on selected day
        windowTo = dateRange.to;
      }
    } else {
      const spanDays = Math.max(1, diffIsoDays(dateRange.from, dateRange.to) + 1);
      if (spanDays > 180) granularity = "month";
      else if (spanDays > 65) granularity = "week";
      else granularity = "day";
    }

    const cacheKey = `${windowFrom}_${windowTo}_${granularity}_${dateRange.from}_${dateRange.to}`;
    const now = Date.now();
    if (!forceRefresh) {
      const cached = ownerTrendsCache.get(cacheKey);
      if (cached && now - cached.ts < TRENDS_CACHE_TTL_MS) {
        return res.json({ ...cached.payload, cacheHit: true });
      }
    }

    const isWindowEndHistorical = windowTo < todayIso;
    const spanForComparison = Math.max(1, diffIsoDays(windowFrom, windowTo) + 1);
    const prevFrom = shiftIsoDate(windowFrom, -spanForComparison);
    const prevTo = shiftIsoDate(windowFrom, -1);

    // Ensure baseline heavy data for windowTo is ready
    let endHeavyPromise;
    if (isWindowEndHistorical) {
      endHeavyPromise = computeHeavyAggregatesAsOf(windowTo);
    } else if (ownerHeavyCache.data) {
      endHeavyPromise = Promise.resolve(ownerHeavyCache.data);
    } else {
      endHeavyPromise = computeHeavyAggregates().then(() => ownerHeavyCache.data);
    }

    const bucketKeys = generateBucketKeys(windowFrom, windowTo, granularity);
    const isHourly = granularity === "hour";

    const invBucketExpr = isHourly
      ? `to_char((created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Cairo'), 'HH24') || ':00'`
      : granularity === "month"
      ? `to_char(invoice_date, 'YYYY-MM')`
      : `to_char(invoice_date, 'YYYY-MM-DD')`;

    const ciBucketExpr = isHourly
      ? `to_char((created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Cairo'), 'HH24') || ':00'`
      : granularity === "month"
      ? `to_char(COALESCE(transaction_date, created_at::date), 'YYYY-MM')`
      : `to_char(COALESCE(transaction_date, created_at::date), 'YYYY-MM-DD')`;

    const coBucketExpr = isHourly
      ? `to_char((created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Cairo'), 'HH24') || ':00'`
      : granularity === "month"
      ? `to_char(COALESCE(transaction_date, created_at::date), 'YYYY-MM')`
      : `to_char(COALESCE(transaction_date, created_at::date), 'YYYY-MM-DD')`;

    const smBucketExpr = granularity === "month"
      ? `to_char(COALESCE(i.invoice_date, (sm.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Cairo')::date), 'YYYY-MM')`
      : `to_char(COALESCE(i.invoice_date, (sm.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Cairo')::date), 'YYYY-MM-DD')`;

    const [
      openingInRes,
      openingOutRes,
      salesSeriesRes,
      cashInSeriesRes,
      cashOutSeriesRes,
      prevSalesRes,
      periodOutBreakdownRes,
      periodBranchSalesRes,
      stockDeltaRes,
      marketDeltaInvRes,
      marketDeltaCustPayRes,
      marketDeltaSupPayRes,
      marketDeltaSupAdjRes,
      endHeavy,
    ] = await Promise.all([
      // 1. Opening cash in before windowFrom
      pool.query(
        `SELECT branch_id,
                COALESCE(SUM(CASE WHEN source_type = 'invoice' THEN COALESCE(paid_amount, 0) ELSE COALESCE(amount, 0) END), 0)::numeric AS total_in
         FROM cash_in
         WHERE COALESCE(transaction_date, created_at::date) < $1::date
           AND (notes IS NULL OR notes NOT LIKE '%{{discount_diff}}%')
         GROUP BY branch_id`,
        [windowFrom]
      ),
      // 2. Opening cash out before windowFrom
      pool.query(
        `SELECT branch_id, COALESCE(SUM(amount), 0)::numeric AS total_out
         FROM cash_out
         WHERE COALESCE(transaction_date, created_at::date) < $1::date
         GROUP BY branch_id`,
        [windowFrom]
      ),
      // 3. Sales per bucket
      pool.query(
        `SELECT branch_id, ${invBucketExpr} AS bucket,
                COUNT(*)::int AS invoices_count,
                COALESCE(SUM(total), 0)::numeric AS sales
         FROM invoices
         WHERE movement_type = 'sale' AND is_void IS NOT TRUE AND is_return = false
           AND invoice_date >= $1::date AND invoice_date <= $2::date
         GROUP BY branch_id, bucket`,
        [windowFrom, windowTo]
      ),
      // 4. Cash In per bucket
      pool.query(
        `SELECT branch_id, ${ciBucketExpr} AS bucket,
                COALESCE(SUM(CASE WHEN source_type = 'invoice' THEN COALESCE(paid_amount, 0) ELSE COALESCE(amount, 0) END), 0)::numeric AS cash_in
         FROM cash_in
         WHERE COALESCE(transaction_date, created_at::date) >= $1::date
           AND COALESCE(transaction_date, created_at::date) <= $2::date
           AND (notes IS NULL OR notes NOT LIKE '%{{discount_diff}}%')
         GROUP BY branch_id, bucket`,
        [windowFrom, windowTo]
      ),
      // 5. Cash Out per bucket
      pool.query(
        `SELECT branch_id, ${coBucketExpr} AS bucket,
                COALESCE(SUM(amount), 0)::numeric AS cash_out
         FROM cash_out
         WHERE COALESCE(transaction_date, created_at::date) >= $1::date
           AND COALESCE(transaction_date, created_at::date) <= $2::date
         GROUP BY branch_id, bucket`,
        [windowFrom, windowTo]
      ),
      // 6. Previous window sales for period-over-period growth %
      pool.query(
        `SELECT branch_id, COALESCE(SUM(total), 0)::numeric AS prev_sales
         FROM invoices
         WHERE movement_type = 'sale' AND is_void IS NOT TRUE AND is_return = false
           AND invoice_date >= $1::date AND invoice_date <= $2::date
         GROUP BY branch_id`,
        [prevFrom, prevTo]
      ),
      // 7. Expense breakdown for the exact selected dateRange (for Donut Chart)
      pool.query(
        `SELECT branch_id, entry_type, COALESCE(SUM(amount), 0)::numeric AS total
         FROM cash_out
         WHERE COALESCE(transaction_date, created_at::date) >= $1::date
           AND COALESCE(transaction_date, created_at::date) <= $2::date
         GROUP BY branch_id, entry_type`,
        [dateRange.from, dateRange.to]
      ),
      // 8. Branch comparison totals for the exact selected dateRange
      pool.query(
        `SELECT branch_id,
                COALESCE(SUM(total), 0)::numeric AS sales,
                COALESCE(SUM(paid_amount), 0)::numeric AS paid
         FROM invoices
         WHERE movement_type = 'sale' AND is_void IS NOT TRUE AND is_return = false
           AND invoice_date >= $1::date AND invoice_date <= $2::date
         GROUP BY branch_id`,
        [dateRange.from, dateRange.to]
      ),
      // 9. Inventory cost delta per bucket (for fast O(1) backward-walk Assets Curve; skipped in hourly mode)
      isHourly
        ? Promise.resolve({ rows: [] })
        : pool.query(
            `SELECT
               sm.warehouse_id AS branch_id,
               ${smBucketExpr} AS bucket,
               COALESCE(SUM(
                 (CASE
                   WHEN sm.movement_type IN ('purchase', 'transfer_in', 'return_sale', 'adjustment_in', 'in', 'replace_in') THEN sm.quantity
                   WHEN sm.movement_type IN ('sale', 'transfer_out', 'return_purchase', 'adjustment_out', 'replace_out') THEN -sm.quantity
                   ELSE 0
                 END) * CASE
                   WHEN sm.warehouse_id = 1 THEN COALESCE(NULLIF(pv.retail_purchase_price, 0), NULLIF(p.retail_purchase_price, 0), NULLIF(pv.purchase_price, 0), NULLIF(p.purchase_price, 0), 0)
                   ELSE COALESCE(NULLIF(pv.purchase_price, 0), NULLIF(p.purchase_price, 0), NULLIF(pv.retail_purchase_price, 0), NULLIF(p.retail_purchase_price, 0), 0)
                 END
               ), 0)::numeric AS cost_delta
             FROM stock_movements sm
             JOIN products p ON p.id = sm.product_id
             LEFT JOIN product_variants pv ON pv.id = NULLIF(COALESCE(sm.variant_id, 0), 0)
             LEFT JOIN invoices i ON i.id = sm.invoice_id
             WHERE COALESCE(i.invoice_date, (sm.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Cairo')::date) >= $1::date
               AND COALESCE(i.invoice_date, (sm.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Cairo')::date) <= $2::date
               AND (i.id IS NULL OR i.is_void IS NOT TRUE)
               AND p.is_active = true
             GROUP BY sm.warehouse_id, bucket`,
            [windowFrom, windowTo]
          ),
      // 10. Daily net invoice delta for Customer Debts & Supplier Payables (for backward walk)
      isHourly
        ? Promise.resolve({ rows: [] })
        : pool.query(
            `SELECT branch_id, movement_type, ${invBucketExpr} AS bucket,
                    COALESCE(SUM(total - COALESCE(paid_amount, 0)), 0)::numeric AS net_unpaid
             FROM invoices
             WHERE is_void IS NOT TRUE
               AND movement_type IN ('sale', 'purchase')
               AND invoice_date >= $1::date AND invoice_date <= $2::date
             GROUP BY branch_id, movement_type, bucket`,
            [windowFrom, windowTo]
          ),
      // 11. Daily customer_payment cash_in delta
      isHourly
        ? Promise.resolve({ rows: [] })
        : pool.query(
            `SELECT branch_id, ${ciBucketExpr} AS bucket, COALESCE(SUM(amount), 0)::numeric AS cust_paid
             FROM cash_in
             WHERE source_type = 'customer_payment'
               AND COALESCE(transaction_date, created_at::date) >= $1::date
               AND COALESCE(transaction_date, created_at::date) <= $2::date
             GROUP BY branch_id, bucket`,
            [windowFrom, windowTo]
          ),
      // 12. Daily standalone supplier_payment cash_out delta (invoice_id IS NULL)
      isHourly
        ? Promise.resolve({ rows: [] })
        : pool.query(
            `SELECT branch_id, ${coBucketExpr} AS bucket, COALESCE(SUM(amount), 0)::numeric AS sup_paid
             FROM cash_out
             WHERE entry_type = 'supplier_payment' AND invoice_id IS NULL
               AND COALESCE(transaction_date, created_at::date) >= $1::date
               AND COALESCE(transaction_date, created_at::date) <= $2::date
             GROUP BY branch_id, bucket`,
            [windowFrom, windowTo]
          ),
      // 13. Daily supplier adjustments delta
      isHourly
        ? Promise.resolve({ rows: [] })
        : pool
            .query(
              `SELECT branch_id,
                      ${granularity === "month" ? `to_char(adjustment_date, 'YYYY-MM')` : `to_char(adjustment_date, 'YYYY-MM-DD')`} AS bucket,
                      COALESCE(SUM(amount), 0)::numeric AS sup_adj
               FROM supplier_adjustments
               WHERE adjustment_date >= $1::date AND adjustment_date <= $2::date
               GROUP BY branch_id, bucket`,
              [windowFrom, windowTo]
            )
            .catch(() => ({ rows: [] })),
      endHeavyPromise,
    ]);

    // Helper: snap date key into week bucket if granularity === 'week'
    const resolveBucketKey = (rawKey) => {
      if (granularity !== "week") return rawKey;
      const d = diffIsoDays(windowFrom, rawKey);
      if (d < 0) return bucketKeys[0];
      const idx = Math.min(bucketKeys.length - 1, Math.floor(d / 7));
      return bucketKeys[idx];
    };

    const openingNet = { 1: 0, 2: 0 };
    for (const r of openingInRes.rows) {
      const b = Number(r.branch_id);
      if (openingNet[b] !== undefined) openingNet[b] += Number(r.total_in || 0);
    }
    for (const r of openingOutRes.rows) {
      const b = Number(r.branch_id);
      if (openingNet[b] !== undefined) openingNet[b] -= Number(r.total_out || 0);
    }

    // Initialize per-branch bucket maps
    const initMap = () => {
      const m = new Map();
      for (const k of bucketKeys) {
        m.set(k, {
          key: k,
          label: formatArabicBucketLabel(k, granularity),
          sales: 0,
          invoicesCount: 0,
          cashIn: 0,
          cashOut: 0,
          netFlow: 0,
          cashBalance: 0,
          inventoryCost: 0,
          customerDebts: 0,
          supplierPayables: 0,
          _costDelta: 0,
          _custDelta: 0,
          _supDelta: 0,
        });
      }
      return m;
    };

    const maps = { 1: initMap(), 2: initMap() };

    for (const r of salesSeriesRes.rows) {
      const b = Number(r.branch_id);
      const entry = maps[b]?.get(resolveBucketKey(r.bucket));
      if (entry) {
        entry.sales += Number(r.sales || 0);
        entry.invoicesCount += Number(r.invoices_count || 0);
      }
    }
    for (const r of cashInSeriesRes.rows) {
      const b = Number(r.branch_id);
      const entry = maps[b]?.get(resolveBucketKey(r.bucket));
      if (entry) entry.cashIn += Number(r.cash_in || 0);
    }
    for (const r of cashOutSeriesRes.rows) {
      const b = Number(r.branch_id);
      const entry = maps[b]?.get(resolveBucketKey(r.bucket));
      if (entry) entry.cashOut += Number(r.cash_out || 0);
    }
    for (const r of stockDeltaRes.rows) {
      const b = Number(r.branch_id);
      const entry = maps[b]?.get(resolveBucketKey(r.bucket));
      if (entry) entry._costDelta += Number(r.cost_delta || 0);
    }
    for (const r of marketDeltaInvRes.rows) {
      const b = Number(r.branch_id);
      const entry = maps[b]?.get(resolveBucketKey(r.bucket));
      if (!entry) continue;
      if (r.movement_type === "sale") entry._custDelta += Number(r.net_unpaid || 0);
      else if (r.movement_type === "purchase") entry._supDelta += Number(r.net_unpaid || 0);
    }
    for (const r of marketDeltaCustPayRes.rows) {
      const b = Number(r.branch_id);
      const entry = maps[b]?.get(resolveBucketKey(r.bucket));
      if (entry) entry._custDelta -= Number(r.cust_paid || 0);
    }
    for (const r of marketDeltaSupPayRes.rows) {
      const b = Number(r.branch_id);
      const entry = maps[b]?.get(resolveBucketKey(r.bucket));
      if (entry) entry._supDelta -= Number(r.sup_paid || 0);
    }
    for (const r of marketDeltaSupAdjRes.rows) {
      const b = Number(r.branch_id);
      const entry = maps[b]?.get(resolveBucketKey(r.bucket));
      if (entry) entry._supDelta += Number(r.sup_adj || 0);
    }

    // Forward walk for cumulative cashBalance + Backward walk for exact Assets & Market Debts curves
    const heavyRef = endHeavy || {
      inventoryByBranch: { 1: { purchase_value: 0 }, 2: { purchase_value: 0 } },
      customerDebtsByBranch: { 1: { total_remaining: 0 }, 2: { total_remaining: 0 } },
      supplierPayablesByBranch: { 1: { total_remaining: 0 }, 2: { total_remaining: 0 } },
    };

    const finalizeBranchSeries = (bId) => {
      const rows = bucketKeys.map((k) => maps[bId].get(k));
      let runningCash = openingNet[bId];
      for (const row of rows) {
        row.sales = round2(row.sales);
        row.cashIn = round2(row.cashIn);
        row.cashOut = round2(row.cashOut);
        row.netFlow = round2(row.cashIn - row.cashOut);
        runningCash = round2(runningCash + row.netFlow);
        row.cashBalance = runningCash;
      }

      if (!isHourly) {
        let invVal = Number(heavyRef.inventoryByBranch?.[bId]?.purchase_value || 0);
        let custVal = Number(heavyRef.customerDebtsByBranch?.[bId]?.total_remaining || 0);
        let supVal = Number(heavyRef.supplierPayablesByBranch?.[bId]?.total_remaining || 0);

        for (let i = rows.length - 1; i >= 0; i--) {
          rows[i].inventoryCost = Math.max(0, round2(invVal));
          rows[i].customerDebts = Math.max(0, round2(custVal));
          rows[i].supplierPayables = Math.max(0, round2(supVal));
          invVal -= rows[i]._costDelta;
          custVal -= rows[i]._custDelta;
          supVal -= rows[i]._supDelta;
        }
      }

      return rows.map(({ _costDelta, _custDelta, _supDelta, ...clean }) => clean);
    };

    const series1 = finalizeBranchSeries(1);
    const series2 = finalizeBranchSeries(2);
    const seriesAll = bucketKeys.map((k, idx) => ({
      key: k,
      label: series1[idx].label,
      sales: round2(series1[idx].sales + series2[idx].sales),
      invoicesCount: series1[idx].invoicesCount + series2[idx].invoicesCount,
      cashIn: round2(series1[idx].cashIn + series2[idx].cashIn),
      cashOut: round2(series1[idx].cashOut + series2[idx].cashOut),
      netFlow: round2(series1[idx].netFlow + series2[idx].netFlow),
      cashBalance: round2(series1[idx].cashBalance + series2[idx].cashBalance),
      inventoryCost: round2(series1[idx].inventoryCost + series2[idx].inventoryCost),
      customerDebts: round2(series1[idx].customerDebts + series2[idx].customerDebts),
      supplierPayables: round2(series1[idx].supplierPayables + series2[idx].supplierPayables),
    }));

    const prevSalesByBranch = { 1: 0, 2: 0 };
    for (const r of prevSalesRes.rows) {
      const b = Number(r.branch_id);
      if (prevSalesByBranch[b] !== undefined) prevSalesByBranch[b] = Number(r.prev_sales || 0);
    }
    const prevSalesAll = round2(prevSalesByBranch[1] + prevSalesByBranch[2]);

    const buildStats = (rows, prevSales) => {
      const totalSales = round2(rows.reduce((s, r) => s + r.sales, 0));
      const totalCashIn = round2(rows.reduce((s, r) => s + r.cashIn, 0));
      const totalCashOut = round2(rows.reduce((s, r) => s + r.cashOut, 0));
      const avgSales = rows.length ? round2(totalSales / rows.length) : 0;
      let peakPoint = rows[0] || null;
      let minCash = rows[0] || null;
      let maxCash = rows[0] || null;
      for (const r of rows) {
        if (!peakPoint || r.sales > peakPoint.sales) peakPoint = r;
        if (!minCash || r.cashBalance < minCash.cashBalance) minCash = r;
        if (!maxCash || r.cashBalance > maxCash.cashBalance) maxCash = r;
      }
      const salesGrowthPct =
        prevSales > 0 ? round2(((totalSales - prevSales) / prevSales) * 100) : null;
      return {
        totalSales,
        totalCashIn,
        totalCashOut,
        avgSales,
        prevSales: round2(prevSales),
        salesGrowthPct,
        peakSalesLabel: peakPoint?.label || "-",
        peakSalesValue: peakPoint?.sales || 0,
        minCashLabel: minCash?.label || "-",
        minCashValue: minCash?.cashBalance || 0,
        maxCashLabel: maxCash?.label || "-",
        maxCashValue: maxCash?.cashBalance || 0,
      };
    };

    // Expense breakdown for Donut Chart (per branch + combined)
    const initBreakdown = () => ({
      supplierPayments: 0,
      expenses: 0,
      purchases: 0,
      settlements: 0,
      debtPayments: 0,
    });
    const expBk = { 1: initBreakdown(), 2: initBreakdown(), all: initBreakdown() };
    for (const r of periodOutBreakdownRes.rows) {
      const b = Number(r.branch_id);
      const amt = Number(r.total || 0);
      const key =
        r.entry_type === "supplier_payment"
          ? "supplierPayments"
          : r.entry_type === "purchase"
          ? "purchases"
          : r.entry_type === "debt_payment"
          ? "debtPayments"
          : r.entry_type === "warehouse_settlement" || r.entry_type === "showroom_settlement"
          ? "settlements"
          : "expenses";
      if (expBk[b]) expBk[b][key] = round2(expBk[b][key] + amt);
      expBk.all[key] = round2(expBk.all[key] + amt);
    }

    // Branch Comparison totals (for selected dateRange)
    const compSales = { 1: 0, 2: 0 };
    for (const r of periodBranchSalesRes.rows) {
      const b = Number(r.branch_id);
      if (compSales[b] !== undefined) compSales[b] = round2(r.sales);
    }
    const compIn = { 1: 0, 2: 0 };
    const compOut = { 1: 0, 2: 0 };
    if (isSingleDay && !isHourly) {
      const targetKey = dateRange.to;
      const p1 = series1.find((r) => r.key === targetKey);
      const p2 = series2.find((r) => r.key === targetKey);
      compIn[1] = p1?.cashIn || 0;
      compIn[2] = p2?.cashIn || 0;
      compOut[1] = p1?.cashOut || 0;
      compOut[2] = p2?.cashOut || 0;
    } else {
      compIn[1] = round2(series1.reduce((s, r) => s + r.cashIn, 0));
      compIn[2] = round2(series2.reduce((s, r) => s + r.cashIn, 0));
      compOut[1] = round2(series1.reduce((s, r) => s + r.cashOut, 0));
      compOut[2] = round2(series2.reduce((s, r) => s + r.cashOut, 0));
    }

    const branchComparison = [
      { branch: "المعرض (القطاعي)", branchId: "1", sales: compSales[1], cashIn: compIn[1], cashOut: compOut[1] },
      { branch: "المخازن (الجملة)", branchId: "2", sales: compSales[2], cashIn: compIn[2], cashOut: compOut[2] },
    ];

    const payload = {
      ok: true,
      granularity,
      isSingleDay,
      selectedDayKey: isSingleDay ? dateRange.to : null,
      window: { from: windowFrom, to: windowTo },
      dateRange,
      seriesByBranch: { all: seriesAll, "1": series1, "2": series2 },
      statsByBranch: {
        all: buildStats(seriesAll, prevSalesAll),
        "1": buildStats(series1, prevSalesByBranch[1]),
        "2": buildStats(series2, prevSalesByBranch[2]),
      },
      expenseBreakdownByBranch: { all: expBk.all, "1": expBk[1], "2": expBk[2] },
      branchComparison,
    };

    if (ownerTrendsCache.size > 20) {
      const firstKey = ownerTrendsCache.keys().next().value;
      if (firstKey) ownerTrendsCache.delete(firstKey);
    }
    ownerTrendsCache.set(cacheKey, { ts: now, payload });

    return res.json({ ...payload, cacheHit: false });
  } catch (err) {
    console.error("getOwnerTrends error:", err);
    return res.status(500).json({ error: "فشل تحميل منحنيات لوحة المالك", details: err.message });
  }
}

module.exports = {
  unlockOwnerSession,
  requireOwnerSession,
  checkOwnerSession,
  getOwnerMetrics,
  getOwnerTrends,
  refreshOwnerCache,
  invalidateOwnerFastCache,
  scheduleOwnerCacheRefresh,
  warmOwnerCache,
};
