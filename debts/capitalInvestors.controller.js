const pool = require("../db");

// ==========================================
// Helpers: Cairo Dates, Validation & Formatting
// ==========================================
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function getCairoToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(
    new Date(),
  );
}

function isValidIsoDate(val) {
  if (typeof val !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(val)) return false;
  const [y, m, d] = val.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() + 1 === m &&
    dt.getUTCDate() === d
  );
}

function toIsoDateOnly(val) {
  if (!val) return null;
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  const s = String(val).slice(0, 10);
  return isValidIsoDate(s) ? s : null;
}

function diffDays(fromIso, toIso) {
  if (!fromIso || !toIso) return null;
  const [y1, m1, d1] = fromIso.split("-").map(Number);
  const [y2, m2, d2] = toIso.split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

function advanceDateByCycle(dateIso, frequency) {
  const base = isValidIsoDate(dateIso) ? dateIso : getCairoToday();
  const [y, m, d] = base.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));

  if (frequency === "weekly") {
    dt.setUTCDate(dt.getUTCDate() + 7);
  } else if (frequency === "biweekly") {
    dt.setUTCDate(dt.getUTCDate() + 14);
  } else if (frequency === "quarterly") {
    dt.setUTCMonth(dt.getUTCMonth() + 3);
  } else if (frequency === "daily") {
    dt.setUTCDate(dt.getUTCDate() + 1);
  } else {
    // monthly default
    dt.setUTCMonth(dt.getUTCMonth() + 1);
  }
  return dt.toISOString().slice(0, 10);
}

function calculateInstallmentDueDate(startDateStr, index, frequency) {
  const base = isValidIsoDate(startDateStr) ? startDateStr : getCairoToday();
  const [y, m, d] = base.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (frequency === "daily") {
    dt.setUTCDate(dt.getUTCDate() + index);
  } else if (frequency === "weekly") {
    dt.setUTCDate(dt.getUTCDate() + index * 7);
  } else {
    dt.setUTCMonth(dt.getUTCMonth() + index);
  }
  return dt.toISOString().slice(0, 10);
}

function parseStrictId(raw) {
  if (raw == null || typeof raw === "boolean") return null;
  const str = String(raw).trim();
  if (!/^\d+$/.test(str)) return null;
  const n = Number(str);
  return Number.isSafeInteger(n) && n >= 1 && n <= 2147483647 ? n : null;
}

function parsePositiveFinite(raw) {
  if (raw == null || raw === "" || typeof raw === "boolean") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? round2(n) : null;
}

function parseNonNegativeFinite(raw) {
  if (raw == null || raw === "" || typeof raw === "boolean") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? round2(n) : null;
}

function parseTreasuryBranchId(raw) {
  const n = Number(raw);
  return n === 2 ? 2 : 1; // 1 = المعرض, 2 = المخازن
}

function getBranchLabel(branchId) {
  return Number(branchId) === 2 ? "خزنة المخازن" : "خزنة المعرض";
}

function generatePermissionNumber(dateStr) {
  const safe = isValidIsoDate(dateStr) ? dateStr : getCairoToday();
  const datePart = safe.replace(/-/g, "").slice(2);
  const randomPart = Math.floor(1000 + Math.random() * 9000);
  return `${datePart}-${randomPart}`;
}

// ==========================================
// Schema Initialization (Lazy & Retry-Safe)
// ==========================================
let tablesReadyPromise = null;

async function ensureCapitalInvestorsTables() {
  if (tablesReadyPromise) return tablesReadyPromise;

  tablesReadyPromise = (async () => {
    const checkRes = await pool.query(`
      SELECT
        to_regclass('public.capital_investors') AS t1,
        to_regclass('public.capital_investor_transactions') AS t2
    `);
    const existing = checkRes.rows[0] || {};
    if (existing.t1 && existing.t2) {
      return;
    }

    const sql = `
      CREATE TABLE IF NOT EXISTS capital_investors (
        id SERIAL PRIMARY KEY,
        investor_name VARCHAR(255) NOT NULL,
        investor_phone VARCHAR(50) DEFAULT '',
        initial_principal NUMERIC(14, 2) NOT NULL DEFAULT 0,
        current_principal NUMERIC(14, 2) NOT NULL DEFAULT 0,
        profit_mode VARCHAR(30) NOT NULL DEFAULT 'fixed_percent'
          CHECK (profit_mode IN ('fixed_percent', 'fixed_amount', 'variable')),
        profit_rate NUMERIC(10, 4) NOT NULL DEFAULT 0,
        fixed_profit_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
        cycle_frequency VARCHAR(30) NOT NULL DEFAULT 'monthly'
          CHECK (cycle_frequency IN ('weekly', 'biweekly', 'monthly', 'quarterly', 'custom')),
        start_date DATE NOT NULL DEFAULT CURRENT_DATE,
        next_payout_date DATE,
        status VARCHAR(30) NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'paused', 'settled')),
        notes TEXT DEFAULT '',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_capital_investors_status ON capital_investors(status);

      CREATE TABLE IF NOT EXISTS capital_investor_transactions (
        id SERIAL PRIMARY KEY,
        investor_id INTEGER NOT NULL REFERENCES capital_investors(id) ON DELETE CASCADE,
        tx_type VARCHAR(40) NOT NULL
          CHECK (tx_type IN (
            'initial_deposit',
            'deposit',
            'profit_payout',
            'profit_reinvest',
            'withdrawal_to_debt',
            'withdrawal_instant'
          )),
        amount NUMERIC(14, 2) NOT NULL,
        tx_date DATE NOT NULL DEFAULT CURRENT_DATE,
        payment_method VARCHAR(100) DEFAULT 'كاش',
        source_type VARCHAR(30) NOT NULL DEFAULT 'personal'
          CHECK (source_type IN ('personal', 'treasury', 'internal')),
        treasury_branch_id INTEGER,
        cash_in_id INTEGER REFERENCES cash_in(id) ON DELETE SET NULL,
        cash_out_id INTEGER REFERENCES cash_out(id) ON DELETE SET NULL,
        converted_debt_id INTEGER REFERENCES external_debts(id) ON DELETE SET NULL,
        permission_number VARCHAR(100) DEFAULT '',
        notes TEXT DEFAULT '',
        created_by INTEGER,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_cit_investor_id ON capital_investor_transactions(investor_id);
      CREATE INDEX IF NOT EXISTS idx_cit_tx_date ON capital_investor_transactions(tx_date);
      CREATE INDEX IF NOT EXISTS idx_cit_converted_debt ON capital_investor_transactions(converted_debt_id);
    `;
    await pool.query(sql);
    console.log("✅ capital_investors & capital_investor_transactions tables ready");
  })().catch((err) => {
    tablesReadyPromise = null;
    throw err;
  });

  return tablesReadyPromise;
}

// ==========================================
// Computation Engine & Shared Summary Builder
// ==========================================
function computeInvestorRow(rawInv, txs = [], linkedDebtsMap = new Map(), todayIso = getCairoToday()) {
  const currentPrincipal = round2(rawInv.current_principal || 0);
  const initialPrincipal = round2(rawInv.initial_principal || 0);
  const profitMode = rawInv.profit_mode || "fixed_percent";
  const profitRate = round2(rawInv.profit_rate || 0);
  const fixedProfitAmount = round2(rawInv.fixed_profit_amount || 0);

  let totalDeposited = 0;
  let totalProfitPaid = 0;
  let totalReinvested = 0;
  let totalWithdrawnToDebt = 0;
  let totalWithdrawnInstant = 0;

  const formattedTxs = txs.map((t) => {
    const amt = round2(t.amount || 0);
    if (t.tx_type === "initial_deposit" || t.tx_type === "deposit") {
      totalDeposited = round2(totalDeposited + amt);
    } else if (t.tx_type === "profit_payout") {
      totalProfitPaid = round2(totalProfitPaid + amt);
    } else if (t.tx_type === "profit_reinvest") {
      totalReinvested = round2(totalReinvested + amt);
      totalProfitPaid = round2(totalProfitPaid + amt);
    } else if (t.tx_type === "withdrawal_to_debt") {
      totalWithdrawnToDebt = round2(totalWithdrawnToDebt + amt);
    } else if (t.tx_type === "withdrawal_instant") {
      totalWithdrawnInstant = round2(totalWithdrawnInstant + amt);
    }

    const debtInfo = t.converted_debt_id ? linkedDebtsMap.get(Number(t.converted_debt_id)) : null;

    return {
      id: Number(t.id),
      investor_id: Number(t.investor_id),
      tx_type: t.tx_type,
      amount: amt,
      tx_date: toIsoDateOnly(t.tx_date) || todayIso,
      payment_method: t.payment_method || "كاش",
      source_type: t.source_type || "personal",
      treasury_branch_id: t.treasury_branch_id ? Number(t.treasury_branch_id) : null,
      cash_in_id: t.cash_in_id ? Number(t.cash_in_id) : null,
      cash_out_id: t.cash_out_id ? Number(t.cash_out_id) : null,
      converted_debt_id: t.converted_debt_id ? Number(t.converted_debt_id) : null,
      converted_debt_status: debtInfo?.status || null,
      converted_debt_remaining: debtInfo ? round2(debtInfo.remaining_amount || 0) : null,
      permission_number: t.permission_number || "",
      notes: t.notes || "",
      created_at: t.created_at,
    };
  });

  // Suggested expected profit for next cycle based on investor's configured model
  let suggestedCycleProfit = 0;
  if (rawInv.status === "active" && currentPrincipal > 0) {
    if (profitMode === "fixed_percent" && profitRate > 0) {
      suggestedCycleProfit = round2((currentPrincipal * profitRate) / 100);
    } else if (profitMode === "fixed_amount" && fixedProfitAmount > 0) {
      suggestedCycleProfit = fixedProfitAmount;
    }
  }

  const nextPayoutDate = toIsoDateOnly(rawInv.next_payout_date);
  const daysUntilPayout =
    rawInv.status === "active" && nextPayoutDate ? diffDays(todayIso, nextPayoutDate) : null;

  const isPayoutOverdue =
    rawInv.status === "active" && daysUntilPayout !== null && daysUntilPayout < 0;
  const isPayoutDueSoon =
    rawInv.status === "active" && daysUntilPayout !== null && daysUntilPayout >= 0 && daysUntilPayout <= 5;

  return {
    id: Number(rawInv.id),
    investor_name: rawInv.investor_name,
    investor_phone: rawInv.investor_phone || "",
    initial_principal: initialPrincipal,
    current_principal: currentPrincipal,
    profit_mode: profitMode,
    profit_rate: profitRate,
    fixed_profit_amount: fixedProfitAmount,
    cycle_frequency: rawInv.cycle_frequency || "monthly",
    start_date: toIsoDateOnly(rawInv.start_date) || todayIso,
    next_payout_date: nextPayoutDate,
    days_until_payout: daysUntilPayout,
    is_payout_overdue: isPayoutOverdue,
    is_payout_due_soon: isPayoutDueSoon,
    status: rawInv.status || "active",
    notes: rawInv.notes || "",
    created_at: rawInv.created_at,
    updated_at: rawInv.updated_at,
    // Computed totals
    suggested_cycle_profit: suggestedCycleProfit,
    total_deposited: totalDeposited,
    total_profit_paid: totalProfitPaid,
    total_reinvested: totalReinvested,
    total_withdrawn_to_debt: totalWithdrawnToDebt,
    total_withdrawn_instant: totalWithdrawnInstant,
    total_withdrawn: round2(totalWithdrawnToDebt + totalWithdrawnInstant),
    transactions_count: formattedTxs.length,
    transactions: formattedTxs,
  };
}

async function fetchAllComputedInvestors(todayIso = getCairoToday()) {
  await ensureCapitalInvestorsTables();

  const [invRes, txRes] = await Promise.all([
    pool.query(`
      SELECT * FROM capital_investors
      ORDER BY
        CASE WHEN status = 'active' THEN 1 WHEN status = 'paused' THEN 2 ELSE 3 END,
        id DESC
    `),
    pool.query(`
      SELECT * FROM capital_investor_transactions
      ORDER BY tx_date DESC, id DESC
    `),
  ]);

  const convertedDebtIds = [
    ...new Set(
      txRes.rows
        .map((t) => (t.converted_debt_id ? Number(t.converted_debt_id) : null))
        .filter(Boolean),
    ),
  ];

  const linkedDebtsMap = new Map();
  if (convertedDebtIds.length > 0) {
    try {
      const dRes = await pool.query(
        `SELECT id, status, total_amount, paid_amount, remaining_amount FROM external_debts WHERE id = ANY($1::int[])`,
        [convertedDebtIds],
      );
      for (const d of dRes.rows) {
        linkedDebtsMap.set(Number(d.id), d);
      }
    } catch (_) {
      // non-fatal
    }
  }

  const txMap = new Map();
  for (const t of txRes.rows) {
    const arr = txMap.get(Number(t.investor_id)) || [];
    arr.push(t);
    txMap.set(Number(t.investor_id), arr);
  }

  return invRes.rows.map((r) =>
    computeInvestorRow(r, txMap.get(Number(r.id)) || [], linkedDebtsMap, todayIso),
  );
}

function buildInvestorsSummaryFromComputed(investors = []) {
  const active = investors.filter((i) => i.status === "active");
  const paused = investors.filter((i) => i.status === "paused");
  const settled = investors.filter((i) => i.status === "settled");

  const totalActivePrincipal = round2(
    active.reduce((s, i) => s + Number(i.current_principal || 0), 0),
  );
  const totalProfitPaid = round2(
    investors.reduce((s, i) => s + Number(i.total_profit_paid || 0), 0),
  );
  const totalReinvested = round2(
    investors.reduce((s, i) => s + Number(i.total_reinvested || 0), 0),
  );
  const totalWithdrawnToDebt = round2(
    investors.reduce((s, i) => s + Number(i.total_withdrawn_to_debt || 0), 0),
  );
  const expectedCyclePayoutTotal = round2(
    active.reduce((s, i) => s + Number(i.suggested_cycle_profit || 0), 0),
  );
  const dueSoonOrOverdueCount = active.filter(
    (i) => i.is_payout_overdue || i.is_payout_due_soon,
  ).length;

  return {
    total_investors: investors.length,
    active_investors_count: active.length,
    paused_investors_count: paused.length,
    settled_investors_count: settled.length,
    total_active_principal: totalActivePrincipal,
    total_profit_paid: totalProfitPaid,
    total_reinvested: totalReinvested,
    total_withdrawn_to_debt: totalWithdrawnToDebt,
    expected_cycle_payout_total: expectedCyclePayoutTotal,
    due_soon_count: dueSoonOrOverdueCount,
  };
}

// ==========================================
// Endpoints
// ==========================================

// 1. Summary KPIs
exports.getSummary = async (req, res) => {
  try {
    const investors = await fetchAllComputedInvestors(getCairoToday());
    return res.json(buildInvestorsSummaryFromComputed(investors));
  } catch (err) {
    console.error("capitalInvestors.getSummary error:", err);
    return res.status(500).json({ error: "فشل تحميل ملخص رأس المال المُشغّل" });
  }
};

// 2. List All Investors
exports.getInvestors = async (req, res) => {
  try {
    let investors = await fetchAllComputedInvestors(getCairoToday());
    const { status, search } = req.query;
    if (status && status !== "all") {
      investors = investors.filter((i) => i.status === status);
    }
    if (search && String(search).trim()) {
      const q = String(search).trim().toLowerCase();
      investors = investors.filter(
        (i) =>
          i.investor_name.toLowerCase().includes(q) ||
          (i.investor_phone || "").includes(q) ||
          (i.notes || "").toLowerCase().includes(q),
      );
    }
    return res.json(investors);
  } catch (err) {
    console.error("capitalInvestors.getInvestors error:", err);
    return res.status(500).json({ error: "فشل تحميل قائمة المستثمرين" });
  }
};

// 3. Create New Investor / Working Capital Entry
exports.createInvestor = async (req, res) => {
  let client = null;
  let txStarted = false;
  try {
    await ensureCapitalInvestorsTables();
    const {
      investor_name,
      investor_phone = "",
      initial_principal,
      profit_mode = "fixed_percent",
      profit_rate = 0,
      fixed_profit_amount = 0,
      cycle_frequency = "monthly",
      start_date,
      next_payout_date,
      source_type = "personal",
      treasury_branch_id = 1,
      payment_method = "كاش",
      notes = "",
    } = req.body || {};

    const cleanName = String(investor_name || "").trim();
    if (!cleanName) {
      return res.status(400).json({ error: "برجاء إدخال اسم المستثمر / الشريك" });
    }
    const principal = parsePositiveFinite(initial_principal);
    if (!principal) {
      return res.status(400).json({ error: "برجاء إدخال مبلغ رأس مال صحيح أكبر من الصفر" });
    }

    const safeProfitMode = ["fixed_percent", "fixed_amount", "variable"].includes(profit_mode)
      ? profit_mode
      : "fixed_percent";
    const safeProfitRate = safeProfitMode === "fixed_percent" ? (parseNonNegativeFinite(profit_rate) ?? 0) : 0;
    const safeFixedProfit = safeProfitMode === "fixed_amount" ? (parseNonNegativeFinite(fixed_profit_amount) ?? 0) : 0;
    const safeCycle = ["weekly", "biweekly", "monthly", "quarterly", "custom"].includes(cycle_frequency)
      ? cycle_frequency
      : "monthly";
    const safeStartDate = isValidIsoDate(start_date) ? start_date : getCairoToday();
    const safeNextPayout = isValidIsoDate(next_payout_date)
      ? next_payout_date
      : safeCycle === "custom"
      ? null
      : advanceDateByCycle(safeStartDate, safeCycle);
    const safeSource = source_type === "treasury" ? "treasury" : "personal";
    const safeBranch = safeSource === "treasury" ? parseTreasuryBranchId(treasury_branch_id) : null;
    const safeNotes = String(notes || "").trim();

    client = await pool.connect();
    await client.query("BEGIN");
    txStarted = true;

    const invRes = await client.query(
      `INSERT INTO capital_investors
        (investor_name, investor_phone, initial_principal, current_principal,
         profit_mode, profit_rate, fixed_profit_amount, cycle_frequency,
         start_date, next_payout_date, status, notes)
       VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8::date, $9::date, 'active', $10)
       RETURNING *`,
      [
        cleanName,
        String(investor_phone || "").trim(),
        principal,
        safeProfitMode,
        safeProfitRate,
        safeFixedProfit,
        safeCycle,
        safeStartDate,
        safeNextPayout,
        safeNotes,
      ],
    );
    const investor = invRes.rows[0];

    let cashInId = null;
    let permissionNumber = "";
    if (safeSource === "treasury") {
      permissionNumber = generatePermissionNumber(safeStartDate);
      const ciRes = await client.query(
        `INSERT INTO cash_in
          (branch_id, transaction_date, source_type, customer_name, description, amount, paid_amount, remaining_amount, permission_number, notes)
         VALUES ($1, $2::date, 'manual', $3, $4, $5, $5, 0, $6, $7)
         RETURNING id`,
        [
          safeBranch,
          safeStartDate,
          cleanName,
          `ضخ رأس مال مُشغّل: ${cleanName}`,
          principal,
          permissionNumber,
          `استلام رأس مال مُشغّل من المستثمر «${cleanName}» (${getBranchLabel(safeBranch)})${safeNotes ? ` - ${safeNotes}` : ""}`,
        ],
      );
      cashInId = ciRes.rows[0].id;
    }

    await client.query(
      `INSERT INTO capital_investor_transactions
        (investor_id, tx_type, amount, tx_date, payment_method, source_type, treasury_branch_id, cash_in_id, permission_number, notes, created_by)
       VALUES ($1, 'initial_deposit', $2, $3::date, $4, $5, $6, $7, $8, $9, $10)`,
      [
        investor.id,
        principal,
        safeStartDate,
        safeSource === "treasury" ? getBranchLabel(safeBranch) : String(payment_method || "كاش").trim(),
        safeSource,
        safeBranch,
        cashInId,
        permissionNumber,
        safeNotes || "رأس مال افتتاحي مُشغّل",
        req.user?.id || null,
      ],
    );

    await client.query("COMMIT");
    txStarted = false;

    return res.status(201).json({
      success: true,
      id: investor.id,
      message: `تم تسجيل المستثمر «${cleanName}» برأس مال ${principal.toLocaleString()} ج.م بنجاح`,
    });
  } catch (err) {
    if (txStarted && client) await client.query("ROLLBACK").catch(() => {});
    console.error("capitalInvestors.createInvestor error:", err);
    return res.status(500).json({ error: "فشل تسجيل المستثمر الجديد" });
  } finally {
    if (client) client.release();
  }
};

// 4. Update Investor Details
exports.updateInvestor = async (req, res) => {
  try {
    await ensureCapitalInvestorsTables();
    const id = parseStrictId(req.params.id);
    if (!id) return res.status(400).json({ error: "معرف المستثمر غير صالح" });

    const existingRes = await pool.query(`SELECT * FROM capital_investors WHERE id = $1`, [id]);
    if (existingRes.rows.length === 0) {
      return res.status(404).json({ error: "المستثمر غير موجود" });
    }
    const prev = existingRes.rows[0];
    const body = req.body || {};

    const cleanName = body.investor_name !== undefined ? String(body.investor_name).trim() : prev.investor_name;
    if (!cleanName) return res.status(400).json({ error: "اسم المستثمر مطلوب" });

    const safeProfitMode =
      body.profit_mode && ["fixed_percent", "fixed_amount", "variable"].includes(body.profit_mode)
        ? body.profit_mode
        : prev.profit_mode;
    const safeProfitRate =
      safeProfitMode === "fixed_percent"
        ? (body.profit_rate !== undefined ? (parseNonNegativeFinite(body.profit_rate) ?? 0) : Number(prev.profit_rate || 0))
        : 0;
    const safeFixedProfit =
      safeProfitMode === "fixed_amount"
        ? (body.fixed_profit_amount !== undefined ? (parseNonNegativeFinite(body.fixed_profit_amount) ?? 0) : Number(prev.fixed_profit_amount || 0))
        : 0;
    const safeCycle =
      body.cycle_frequency && ["weekly", "biweekly", "monthly", "quarterly", "custom"].includes(body.cycle_frequency)
        ? body.cycle_frequency
        : prev.cycle_frequency;
    const safeStatus =
      body.status && ["active", "paused", "settled"].includes(body.status)
        ? body.status
        : prev.status;
    const safeNextPayout =
      body.next_payout_date === "" || body.next_payout_date === null
        ? null
        : isValidIsoDate(body.next_payout_date)
        ? body.next_payout_date
        : prev.next_payout_date;

    await pool.query(
      `UPDATE capital_investors
       SET investor_name = $1,
           investor_phone = $2,
           profit_mode = $3,
           profit_rate = $4,
           fixed_profit_amount = $5,
           cycle_frequency = $6,
           next_payout_date = $7::date,
           status = $8,
           notes = $9,
           updated_at = NOW()
       WHERE id = $10`,
      [
        cleanName,
        body.investor_phone !== undefined ? String(body.investor_phone).trim() : prev.investor_phone,
        safeProfitMode,
        safeProfitRate,
        safeFixedProfit,
        safeCycle,
        safeNextPayout,
        safeStatus,
        body.notes !== undefined ? String(body.notes).trim() : prev.notes,
        id,
      ],
    );

    return res.json({ success: true, message: "تم تحديث بيانات المستثمر بنجاح" });
  } catch (err) {
    console.error("capitalInvestors.updateInvestor error:", err);
    return res.status(500).json({ error: "فشل تحديث بيانات المستثمر" });
  }
};

// 5. Additional Capital Deposit (ضخ رأس مال إضافي)
exports.depositCapital = async (req, res) => {
  let client = null;
  let txStarted = false;
  try {
    await ensureCapitalInvestorsTables();
    const id = parseStrictId(req.params.id);
    if (!id) return res.status(400).json({ error: "معرف المستثمر غير صالح" });

    const {
      amount,
      tx_date,
      source_type = "personal",
      treasury_branch_id = 1,
      payment_method = "كاش",
      notes = "",
    } = req.body || {};

    const depositAmt = parsePositiveFinite(amount);
    if (!depositAmt) return res.status(400).json({ error: "برجاء إدخال مبلغ ضخ صحيح أكبر من الصفر" });

    const safeDate = isValidIsoDate(tx_date) ? tx_date : getCairoToday();
    const safeSource = source_type === "treasury" ? "treasury" : "personal";
    const safeBranch = safeSource === "treasury" ? parseTreasuryBranchId(treasury_branch_id) : null;
    const safeNotes = String(notes || "").trim();

    client = await pool.connect();
    await client.query("BEGIN");
    txStarted = true;

    const invRes = await client.query(`SELECT * FROM capital_investors WHERE id = $1 FOR UPDATE`, [id]);
    if (invRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "المستثمر غير موجود" });
    }
    const investor = invRes.rows[0];
    const newPrincipal = round2(Number(investor.current_principal || 0) + depositAmt);

    let cashInId = null;
    let permissionNumber = "";
    if (safeSource === "treasury") {
      permissionNumber = generatePermissionNumber(safeDate);
      const ciRes = await client.query(
        `INSERT INTO cash_in
          (branch_id, transaction_date, source_type, customer_name, description, amount, paid_amount, remaining_amount, permission_number, notes)
         VALUES ($1, $2::date, 'manual', $3, $4, $5, $5, 0, $6, $7)
         RETURNING id`,
        [
          safeBranch,
          safeDate,
          investor.investor_name,
          `ضخ رأس مال إضافي: ${investor.investor_name}`,
          depositAmt,
          permissionNumber,
          `ضخ رأس مال إضافي للمستثمر «${investor.investor_name}» (${getBranchLabel(safeBranch)})${safeNotes ? ` - ${safeNotes}` : ""}`,
        ],
      );
      cashInId = ciRes.rows[0].id;
    }

    await client.query(
      `INSERT INTO capital_investor_transactions
        (investor_id, tx_type, amount, tx_date, payment_method, source_type, treasury_branch_id, cash_in_id, permission_number, notes, created_by)
       VALUES ($1, 'deposit', $2, $3::date, $4, $5, $6, $7, $8, $9, $10)`,
      [
        id,
        depositAmt,
        safeDate,
        safeSource === "treasury" ? getBranchLabel(safeBranch) : String(payment_method || "كاش").trim(),
        safeSource,
        safeBranch,
        cashInId,
        permissionNumber,
        safeNotes || "ضخ رأس مال إضافي",
        req.user?.id || null,
      ],
    );

    await client.query(
      `UPDATE capital_investors
       SET current_principal = $1,
           status = 'active',
           updated_at = NOW()
       WHERE id = $2`,
      [newPrincipal, id],
    );

    await client.query("COMMIT");
    txStarted = false;

    return res.json({
      success: true,
      new_principal: newPrincipal,
      message: `تم ضخ ${depositAmt.toLocaleString()} ج.م بنجاح — رأس المال الحالي ${newPrincipal.toLocaleString()} ج.م`,
    });
  } catch (err) {
    if (txStarted && client) await client.query("ROLLBACK").catch(() => {});
    console.error("capitalInvestors.depositCapital error:", err);
    return res.status(500).json({ error: "فشل تسجيل ضخ رأس المال" });
  } finally {
    if (client) client.release();
  }
};

// 6. Profit Payout OR Reinvest (صرف أرباح أو إعادة استثمارها في الأصل)
exports.recordProfit = async (req, res) => {
  let client = null;
  let txStarted = false;
  try {
    await ensureCapitalInvestorsTables();
    const id = parseStrictId(req.params.id);
    if (!id) return res.status(400).json({ error: "معرف المستثمر غير صالح" });

    const {
      action = "payout", // 'payout' | 'reinvest'
      amount,
      tx_date,
      source_type = "personal",
      treasury_branch_id = 1,
      payment_method = "كاش",
      advance_next_payout = true,
      notes = "",
    } = req.body || {};

    const profitAmt = parsePositiveFinite(amount);
    if (!profitAmt) return res.status(400).json({ error: "برجاء إدخال مبلغ ربح صحيح أكبر من الصفر" });

    const isReinvest = action === "reinvest";
    const safeDate = isValidIsoDate(tx_date) ? tx_date : getCairoToday();
    const safeSource = isReinvest ? "internal" : source_type === "treasury" ? "treasury" : "personal";
    const safeBranch = safeSource === "treasury" ? parseTreasuryBranchId(treasury_branch_id) : null;
    const safeNotes = String(notes || "").trim();

    client = await pool.connect();
    await client.query("BEGIN");
    txStarted = true;

    const invRes = await client.query(`SELECT * FROM capital_investors WHERE id = $1 FOR UPDATE`, [id]);
    if (invRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "المستثمر غير موجود" });
    }
    const investor = invRes.rows[0];

    let cashOutId = null;
    let permissionNumber = "";

    if (!isReinvest && safeSource === "treasury") {
      permissionNumber = generatePermissionNumber(safeDate);
      const coRes = await client.query(
        `INSERT INTO cash_out
          (branch_id, name, amount, notes, transaction_date, permission_number, entry_type)
         VALUES ($1, $2, $3, $4, $5::date, $6, 'expense')
         RETURNING id`,
        [
          safeBranch,
          `أرباح تشغيل مستثمر: ${investor.investor_name}`,
          profitAmt,
          `صرف أرباح تشغيل للمستثمر «${investor.investor_name}» (${getBranchLabel(safeBranch)})${safeNotes ? ` - ${safeNotes}` : ""}`,
          safeDate,
          permissionNumber,
        ],
      );
      cashOutId = coRes.rows[0].id;
    }

    await client.query(
      `INSERT INTO capital_investor_transactions
        (investor_id, tx_type, amount, tx_date, payment_method, source_type, treasury_branch_id, cash_out_id, permission_number, notes, created_by)
       VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8, $9, $10, $11)`,
      [
        id,
        isReinvest ? "profit_reinvest" : "profit_payout",
        profitAmt,
        safeDate,
        isReinvest
          ? "إعادة استثمار بالأصل"
          : safeSource === "treasury"
          ? getBranchLabel(safeBranch)
          : String(payment_method || "كاش").trim(),
        safeSource,
        safeBranch,
        cashOutId,
        permissionNumber,
        safeNotes || (isReinvest ? "إعادة استثمار الأرباح ضمن رأس المال" : "صرف أرباح دورة التشغيل"),
        req.user?.id || null,
      ],
    );

    const newPrincipal = isReinvest
      ? round2(Number(investor.current_principal || 0) + profitAmt)
      : round2(Number(investor.current_principal || 0));

    let nextPayoutDate = toIsoDateOnly(investor.next_payout_date);
    if (advance_next_payout && investor.cycle_frequency !== "custom") {
      const baseForNext = nextPayoutDate && nextPayoutDate >= safeDate ? nextPayoutDate : safeDate;
      nextPayoutDate = advanceDateByCycle(baseForNext, investor.cycle_frequency);
    }

    await client.query(
      `UPDATE capital_investors
       SET current_principal = $1,
           next_payout_date = $2::date,
           updated_at = NOW()
       WHERE id = $3`,
      [newPrincipal, nextPayoutDate, id],
    );

    await client.query("COMMIT");
    txStarted = false;

    return res.json({
      success: true,
      new_principal: newPrincipal,
      next_payout_date: nextPayoutDate,
      message: isReinvest
        ? `تمت إعادة استثمار ${profitAmt.toLocaleString()} ج.م — رأس المال الحالي ${newPrincipal.toLocaleString()} ج.م`
        : `تم صرف أرباح ${profitAmt.toLocaleString()} ج.م للمستثمر «${investor.investor_name}» بنجاح`,
    });
  } catch (err) {
    if (txStarted && client) await client.query("ROLLBACK").catch(() => {});
    console.error("capitalInvestors.recordProfit error:", err);
    return res.status(500).json({ error: "فشل تسجيل حركة الأرباح" });
  } finally {
    if (client) client.release();
  }
};

// 7. Withdraw / Liquidate Principal (سحب / تصفية الأصل -> تحويل فوري لمديونية مجدولة أو صرف فوري)
exports.withdrawPrincipal = async (req, res) => {
  let client = null;
  let txStarted = false;
  try {
    await ensureCapitalInvestorsTables();
    const id = parseStrictId(req.params.id);
    if (!id) return res.status(400).json({ error: "معرف المستثمر غير صالح" });

    const {
      amount,
      mode = "convert_to_debt", // 'convert_to_debt' (default) | 'instant_payout'
      // For convert_to_debt:
      installment_count = 1,
      frequency = "monthly",
      start_date,
      debt_title,
      // For instant_payout:
      tx_date,
      source_type = "personal",
      treasury_branch_id = 1,
      payment_method = "كاش",
      notes = "",
    } = req.body || {};

    const withdrawAmt = parsePositiveFinite(amount);
    if (!withdrawAmt) {
      return res.status(400).json({ error: "برجاء إدخال مبلغ السحب المطلوب بشكل صحيح" });
    }

    const safeMode = mode === "instant_payout" ? "instant_payout" : "convert_to_debt";
    const safeDate = isValidIsoDate(tx_date) ? tx_date : getCairoToday();
    const safeStartDate = isValidIsoDate(start_date) ? start_date : getCairoToday();
    const safeNotes = String(notes || "").trim();

    client = await pool.connect();
    await client.query("BEGIN");
    txStarted = true;

    const invRes = await client.query(`SELECT * FROM capital_investors WHERE id = $1 FOR UPDATE`, [id]);
    if (invRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "المستثمر غير موجود" });
    }
    const investor = invRes.rows[0];
    const currentPrincipal = round2(investor.current_principal || 0);

    if (withdrawAmt > currentPrincipal + 0.01) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: `مبلغ السحب (${withdrawAmt.toLocaleString()}) أكبر من رأس المال القائم حالياً (${currentPrincipal.toLocaleString()} ج.م)`,
      });
    }

    const newPrincipal = Math.max(0, round2(currentPrincipal - withdrawAmt));
    const isFullLiquidation = newPrincipal <= 0.01;
    const newStatus = isFullLiquidation ? "settled" : investor.status;

    let convertedDebtId = null;
    let cashOutId = null;
    let permissionNumber = "";

    if (safeMode === "convert_to_debt") {
      const count = Math.max(1, Math.min(120, parseInt(installment_count, 10) || 1));
      const safeFreq = ["daily", "weekly", "monthly"].includes(frequency) ? frequency : "monthly";
      const baseInstallment = Math.round((withdrawAmt / count) * 100) / 100;
      const finalTitle =
        String(debt_title || "").trim() ||
        `${isFullLiquidation ? "تصفية رأس مال مُشغّل" : "سحب جزئي من رأس مال مُشغّل"}: ${investor.investor_name}`;

      // 1. Create official scheduled debt in external_debts
      const debtRes = await client.query(
        `INSERT INTO external_debts
          (title, creditor_name, creditor_phone, total_amount, paid_amount, remaining_amount,
           installment_count, installment_amount, frequency, start_date, status, category, notes)
         VALUES ($1, $2, $3, $4, 0, $4, $5, $6, $7, $8::date, 'active', 'تصفية رأس مال مستثمر', $9)
         RETURNING id`,
        [
          finalTitle,
          investor.investor_name,
          investor.investor_phone || "",
          withdrawAmt,
          count,
          baseInstallment,
          safeFreq,
          safeStartDate,
          `محوّلة تلقائياً من طلب سحب رأس مال مُشغّل (مستثمر #${investor.id})${safeNotes ? ` - ${safeNotes}` : ""}`,
        ],
      );
      convertedDebtId = debtRes.rows[0].id;

      // 2. Generate exact installment schedule (adjusting last installment for rounding penny)
      let allocated = 0;
      for (let i = 0; i < count; i++) {
        const instAmt =
          i === count - 1 ? round2(withdrawAmt - allocated) : baseInstallment;
        allocated = round2(allocated + instAmt);
        const dueDate = calculateInstallmentDueDate(safeStartDate, i, safeFreq);
        await client.query(
          `INSERT INTO debt_installments
            (debt_id, installment_number, due_date, amount, paid_amount, status, notes)
           VALUES ($1, $2, $3::date, $4, 0, 'pending', $5)`,
          [
            convertedDebtId,
            i + 1,
            dueDate,
            instAmt,
            `قسط سحب رأس مال #${i + 1} للمستثمر ${investor.investor_name}`,
          ],
        );
      }

      // 3. Log withdrawal_to_debt on investor ledger
      await client.query(
        `INSERT INTO capital_investor_transactions
          (investor_id, tx_type, amount, tx_date, payment_method, source_type, converted_debt_id, notes, created_by)
         VALUES ($1, 'withdrawal_to_debt', $2, $3::date, $4, 'internal', $5, $6, $7)`,
        [
          id,
          withdrawAmt,
          safeDate,
          `تحويل لمديونية (${count} ${count === 1 ? "قسط" : "أقساط"})`,
          convertedDebtId,
          safeNotes ||
            `تم خصم ${withdrawAmt.toLocaleString()} ج.م من رأس المال وتحويلها لمديونية #${convertedDebtId} (${count} أقساط)`,
          req.user?.id || null,
        ],
      );
    } else {
      // Instant payout mode
      const safeSource = source_type === "treasury" ? "treasury" : "personal";
      const safeBranch = safeSource === "treasury" ? parseTreasuryBranchId(treasury_branch_id) : null;

      if (safeSource === "treasury") {
        permissionNumber = generatePermissionNumber(safeDate);
        const coRes = await client.query(
          `INSERT INTO cash_out
            (branch_id, name, amount, notes, transaction_date, permission_number, entry_type)
           VALUES ($1, $2, $3, $4, $5::date, $6, 'debt_payment')
           RETURNING id`,
          [
            safeBranch,
            `تصفية رأس مال مستثمر: ${investor.investor_name}`,
            withdrawAmt,
            `سحب فوري من رأس مال المستثمر «${investor.investor_name}» (${getBranchLabel(safeBranch)})${safeNotes ? ` - ${safeNotes}` : ""}`,
            safeDate,
            permissionNumber,
          ],
        );
        cashOutId = coRes.rows[0].id;
      }

      await client.query(
        `INSERT INTO capital_investor_transactions
          (investor_id, tx_type, amount, tx_date, payment_method, source_type, treasury_branch_id, cash_out_id, permission_number, notes, created_by)
         VALUES ($1, 'withdrawal_instant', $2, $3::date, $4, $5, $6, $7, $8, $9, $10)`,
        [
          id,
          withdrawAmt,
          safeDate,
          safeSource === "treasury" ? getBranchLabel(safeBranch) : String(payment_method || "كاش").trim(),
          safeSource,
          safeBranch,
          cashOutId,
          permissionNumber,
          safeNotes || "سحب / تصفية فورية من رأس المال",
          req.user?.id || null,
        ],
      );
    }

    // 4. Immediately deduct principal from investor card
    await client.query(
      `UPDATE capital_investors
       SET current_principal = $1,
           status = $2,
           next_payout_date = CASE WHEN $2 = 'settled' THEN NULL ELSE next_payout_date END,
           updated_at = NOW()
       WHERE id = $3`,
      [newPrincipal, newStatus, id],
    );

    await client.query("COMMIT");
    txStarted = false;

    return res.json({
      success: true,
      new_principal: newPrincipal,
      status: newStatus,
      converted_debt_id: convertedDebtId,
      message:
        safeMode === "convert_to_debt"
          ? `تم خصم ${withdrawAmt.toLocaleString()} ج.م من رأس المال وتحويلها فوراً إلى مديونية مجدولة (#${convertedDebtId})`
          : `تم صرف ${withdrawAmt.toLocaleString()} ج.م وتحديث رأس المال إلى ${newPrincipal.toLocaleString()} ج.م`,
    });
  } catch (err) {
    if (txStarted && client) await client.query("ROLLBACK").catch(() => {});
    console.error("capitalInvestors.withdrawPrincipal error:", err);
    return res.status(500).json({ error: "فشل تنفيذ طلب السحب والتصفية" });
  } finally {
    if (client) client.release();
  }
};

// 8. Delete / Reverse Transaction safely
exports.deleteTransaction = async (req, res) => {
  let client = null;
  let txStarted = false;
  try {
    await ensureCapitalInvestorsTables();
    const txId = parseStrictId(req.params.txId);
    if (!txId) return res.status(400).json({ error: "معرف الحركة غير صالح" });

    client = await pool.connect();
    await client.query("BEGIN");
    txStarted = true;

    const txRes = await client.query(
      `SELECT * FROM capital_investor_transactions WHERE id = $1 FOR UPDATE`,
      [txId],
    );
    if (txRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "الحركة غير موجودة" });
    }
    const tx = txRes.rows[0];
    if (tx.tx_type === "initial_deposit") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "لا يمكن حذف الإيداع الافتتاحي مباشرة — يمكنك حذف المستثمر بالكامل أو تسجيل سحب" });
    }

    const invRes = await client.query(
      `SELECT * FROM capital_investors WHERE id = $1 FOR UPDATE`,
      [tx.investor_id],
    );
    const investor = invRes.rows[0];
    let principal = round2(investor?.current_principal || 0);
    const amt = round2(tx.amount || 0);

    // If withdrawal_to_debt, verify debt has no payments before deleting it
    if (tx.tx_type === "withdrawal_to_debt" && tx.converted_debt_id) {
      const dRes = await client.query(
        `SELECT id, paid_amount FROM external_debts WHERE id = $1`,
        [tx.converted_debt_id],
      );
      if (dRes.rows.length > 0 && Number(dRes.rows[0].paid_amount || 0) > 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "لا يمكن التراجع عن طلب السحب بعد سداد أقساط من المديونية المحوّلة — قم بإلغاء سداد الأقساط أولاً",
        });
      }
      await client.query(`DELETE FROM external_debts WHERE id = $1`, [tx.converted_debt_id]);
      principal = round2(principal + amt);
    } else if (tx.tx_type === "deposit" || tx.tx_type === "profit_reinvest") {
      principal = Math.max(0, round2(principal - amt));
    } else if (tx.tx_type === "withdrawal_instant") {
      principal = round2(principal + amt);
    }

    if (tx.cash_in_id) {
      await client.query(`DELETE FROM cash_in WHERE id = $1`, [tx.cash_in_id]);
    }
    if (tx.cash_out_id) {
      await client.query(`DELETE FROM cash_out WHERE id = $1`, [tx.cash_out_id]);
    }

    await client.query(`DELETE FROM capital_investor_transactions WHERE id = $1`, [txId]);

    if (investor) {
      const nextStatus = principal > 0.01 ? "active" : "settled";
      await client.query(
        `UPDATE capital_investors SET current_principal = $1, status = $2, updated_at = NOW() WHERE id = $3`,
        [principal, nextStatus, investor.id],
      );
    }

    await client.query("COMMIT");
    txStarted = false;

    return res.json({ success: true, message: "تم التراجع عن الحركة وتحديث رأس المال بنجاح" });
  } catch (err) {
    if (txStarted && client) await client.query("ROLLBACK").catch(() => {});
    console.error("capitalInvestors.deleteTransaction error:", err);
    return res.status(500).json({ error: "فشل حذف الحركة" });
  } finally {
    if (client) client.release();
  }
};

// 9. Delete Investor
exports.deleteInvestor = async (req, res) => {
  let client = null;
  let txStarted = false;
  try {
    await ensureCapitalInvestorsTables();
    const id = parseStrictId(req.params.id);
    if (!id) return res.status(400).json({ error: "معرف المستثمر غير صالح" });

    client = await pool.connect();
    await client.query("BEGIN");
    txStarted = true;

    const txRows = await client.query(
      `SELECT cash_in_id, cash_out_id FROM capital_investor_transactions WHERE investor_id = $1`,
      [id],
    );
    const cashInIds = txRows.rows.map((r) => r.cash_in_id).filter(Boolean);
    const cashOutIds = txRows.rows.map((r) => r.cash_out_id).filter(Boolean);

    const delRes = await client.query(`DELETE FROM capital_investors WHERE id = $1 RETURNING id`, [id]);
    if (delRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "المستثمر غير موجود" });
    }

    if (cashInIds.length > 0) {
      await client.query(`DELETE FROM cash_in WHERE id = ANY($1::int[])`, [cashInIds]);
    }
    if (cashOutIds.length > 0) {
      await client.query(`DELETE FROM cash_out WHERE id = ANY($1::int[])`, [cashOutIds]);
    }

    await client.query("COMMIT");
    txStarted = false;

    return res.json({ success: true, message: "تم حذف سجل المستثمر بنجاح" });
  } catch (err) {
    if (txStarted && client) await client.query("ROLLBACK").catch(() => {});
    console.error("capitalInvestors.deleteInvestor error:", err);
    return res.status(500).json({ error: "فشل حذف المستثمر" });
  } finally {
    if (client) client.release();
  }
};

exports.ensureCapitalInvestorsTables = ensureCapitalInvestorsTables;
exports.fetchAllComputedInvestors = fetchAllComputedInvestors;
exports.buildInvestorsSummaryFromComputed = buildInvestorsSummaryFromComputed;
