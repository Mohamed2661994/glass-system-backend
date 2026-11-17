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
const ownerFastCache = new Map(); // `${from}_${to}` -> { ts: number, baseData: object }
const FAST_CACHE_TTL_MS = 15 * 1000; // 15 seconds

/**
 * Instantly invalidates fast-track cache on any cash/invoice write (0ms overhead)
 */
function invalidateOwnerFastCache() {
  ownerFastCache.clear();
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

    // Run Stock Valuation, Customer Balances, and Supplier Balances in PARALLEL
    const reportsController = require("../reports/reports.controller");

    const [stockRes, custData, supData] = await Promise.all([
      pool.query(stockQuery),
      new Promise((resolve) => {
        reportsController.getCustomerBalances(
          { query: { show_all: "1" } },
          {
            setHeader: () => {},
            json: resolve,
            status: () => ({ json: () => resolve([]) }),
          }
        );
      }).catch(() => []),
      new Promise((resolve) => {
        reportsController.getSupplierBalances(
          { query: {} },
          {
            setHeader: () => {},
            json: resolve,
            status: () => ({ json: () => resolve([]) }),
          }
        );
      }).catch(() => []),
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

    const customerDebtsByBranch = {
      1: { total_remaining: 0, count_customers: 0 },
      2: { total_remaining: 0, count_customers: 0 },
    };

    const custRows = custData?.customers || (Array.isArray(custData) ? custData : []);
    let b1Rem = 0, b1Count = 0, b2Rem = 0, b2Count = 0;
    for (const c of custRows) {
      const bal = Number(c.balance_due || 0);
      if (bal > 0) {
        if (c.is_market_customer) {
          b2Rem += bal;
          b2Count++;
        } else {
          b1Rem += bal;
          b1Count++;
        }
      }
    }
    customerDebtsByBranch[1] = {
      total_remaining: Math.round(b1Rem * 100) / 100,
      count_customers: b1Count,
    };
    customerDebtsByBranch[2] = {
      total_remaining: Math.round(b2Rem * 100) / 100,
      count_customers: b2Count,
    };

    const supRows = Array.isArray(supData) ? supData : (supData?.suppliers || []);
    let totalSup = 0;
    for (const s of supRows) {
      const bal = Number(s.balance_due || 0);
      if (bal > 0) totalSup += bal;
    }
    const supplierPayablesTotal = Math.round(totalSup * 100) / 100;

    ownerHeavyCache.data = {
      inventoryByBranch,
      customerDebtsByBranch,
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
 * Force Refresh Cache Endpoint
 * POST /api/owner/refresh-cache
 */
async function refreshOwnerCache(req, res) {
  try {
    const broadcast = req.app.get("broadcastRealtime");
    ownerFastCache.clear();
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
  const supplierPayables = heavy.supplierPayablesTotal || 0;

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

    inventoryCost = heavy.inventoryByBranch[1]?.purchase_value || 0;
    inventorySale = heavy.inventoryByBranch[1]?.selling_value || 0;
    inventoryQty = heavy.inventoryByBranch[1]?.total_quantity || 0;
    customerDebts = heavy.customerDebtsByBranch[1]?.total_remaining || 0;
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

    inventoryCost = heavy.inventoryByBranch[2]?.purchase_value || 0;
    inventorySale = heavy.inventoryByBranch[2]?.selling_value || 0;
    inventoryQty = heavy.inventoryByBranch[2]?.total_quantity || 0;
    customerDebts = heavy.customerDebtsByBranch[2]?.total_remaining || 0;
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

    inventoryCost = Math.round(((heavy.inventoryByBranch[1]?.purchase_value || 0) + (heavy.inventoryByBranch[2]?.purchase_value || 0)) * 100) / 100;
    inventorySale = Math.round(((heavy.inventoryByBranch[1]?.selling_value || 0) + (heavy.inventoryByBranch[2]?.selling_value || 0)) * 100) / 100;
    inventoryQty = (heavy.inventoryByBranch[1]?.total_quantity || 0) + (heavy.inventoryByBranch[2]?.total_quantity || 0);
    customerDebts = Math.round(((heavy.customerDebtsByBranch[1]?.total_remaining || 0) + (heavy.customerDebtsByBranch[2]?.total_remaining || 0)) * 100) / 100;
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
      supplierPayablesTotal: supplierPayables,
      netMarketPosition,
      branch1CustomerDebts: heavy.customerDebtsByBranch[1]?.total_remaining || 0,
      branch2CustomerDebts: heavy.customerDebtsByBranch[2]?.total_remaining || 0,
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
    const cacheKey = `${dateRange.from}_${dateRange.to}`;
    const now = Date.now();

    // 1. HEAVY AGGREGATES: Stale-While-Revalidate (NEVER blocks once warmed!)
    if (forceRefresh) {
      ownerFastCache.clear();
      await computeHeavyAggregates(broadcast);
    } else if (!ownerHeavyCache.data) {
      await computeHeavyAggregates(broadcast);
    } else if (ownerHeavyCache.isDirty || now - ownerHeavyCache.lastUpdated > ownerHeavyCache.ttlMs) {
      // Serve immediately from RAM & refresh silently in background!
      computeHeavyAggregates(broadcast).catch(() => {});
    }

    const heavy = ownerHeavyCache.data || {
      inventoryByBranch: {
        1: { purchase_value: 0, selling_value: 0, items_count: 0, total_quantity: 0 },
        2: { purchase_value: 0, selling_value: 0, items_count: 0, total_quantity: 0 },
      },
      customerDebtsByBranch: {
        1: { total_remaining: 0, count_customers: 0 },
        2: { total_remaining: 0, count_customers: 0 },
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
      // Execute ALL 7 lightweight SQL aggregations in PARALLEL for minimal latency
      const [
        cashInRes,
        cashOutRes,
        openingInRes,
        openingOutRes,
        periodSalesRes,
        periodExpensesRes,
        periodCashInRes,
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
      ]);

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

module.exports = {
  unlockOwnerSession,
  requireOwnerSession,
  checkOwnerSession,
  getOwnerMetrics,
  refreshOwnerCache,
  invalidateOwnerFastCache,
  scheduleOwnerCacheRefresh,
  warmOwnerCache,
};
