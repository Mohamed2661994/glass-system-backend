const pool = require("../db");

// ==========================================
// Helpers: Cairo Dates, Validation & Formatting
// ==========================================
const ARABIC_MONTHS = [
  "يناير",
  "فبراير",
  "مارس",
  "أبريل",
  "مايو",
  "يونيو",
  "يوليو",
  "أغسطس",
  "سبتمبر",
  "أكتوبر",
  "نوفمبر",
  "ديسمبر",
];

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

function isValidBillingMonth(val) {
  return typeof val === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(val);
}

function getMonthKey(dateIso) {
  return String(dateIso || getCairoToday()).slice(0, 7);
}

function addMonths(monthStr, delta) {
  const [y, m] = monthStr.split("-").map(Number);
  const total = y * 12 + (m - 1) + delta;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, "0")}`;
}

function clampDueDateForMonth(monthStr, dueDay) {
  const [y, m] = monthStr.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const safeDay = Math.max(1, Math.min(Number(dueDay) || 1, daysInMonth));
  return `${y}-${String(m).padStart(2, "0")}-${String(safeDay).padStart(2, "0")}`;
}

function addOneYearIso(dateIso) {
  const [y, m, d] = dateIso.split("-").map(Number);
  const ny = y + 1;
  const daysInTargetMonth = new Date(Date.UTC(ny, m, 0)).getUTCDate();
  const safeDay = Math.min(d, daysInTargetMonth);
  return `${ny}-${String(m).padStart(2, "0")}-${String(safeDay).padStart(2, "0")}`;
}

function diffDays(fromIso, toIso) {
  const [y1, m1, d1] = fromIso.split("-").map(Number);
  const [y2, m2, d2] = toIso.split("-").map(Number);
  const t1 = Date.UTC(y1, m1 - 1, d1);
  const t2 = Date.UTC(y2, m2 - 1, d2);
  return Math.round((t2 - t1) / 86400000);
}

function formatMonthArabic(monthStr) {
  if (!isValidBillingMonth(monthStr)) return monthStr;
  const [y, m] = monthStr.split("-").map(Number);
  return `${ARABIC_MONTHS[m - 1]} ${y}`;
}

function parseStrictId(raw) {
  if (raw == null || typeof raw === "boolean") return null;
  const str = String(raw).trim();
  if (!/^\d+$/.test(str)) return null;
  const n = Number(str);
  return Number.isSafeInteger(n) && n >= 1 && n <= 2147483647 ? n : null;
}

function parseStrictIntRange(raw, min, max) {
  if (raw == null || raw === "" || typeof raw === "boolean") return null;
  const str = String(raw).trim();
  if (!/^-?\d+$/.test(str)) return null;
  const n = Number(str);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
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

function generatePermissionNumber(dateStr) {
  const safe = isValidIsoDate(dateStr) ? dateStr : getCairoToday();
  const datePart = safe.replace(/-/g, "").slice(2);
  const randomPart = Math.floor(1000 + Math.random() * 9000);
  return `${datePart}-${randomPart}`;
}

function toIsoDateOnly(val) {
  if (!val) return null;
  if (val instanceof Date) {
    return val.toISOString().slice(0, 10);
  }
  const s = String(val).slice(0, 10);
  return isValidIsoDate(s) ? s : null;
}

// ==========================================
// Schema Initialization (Lazy & Retry-Safe)
// ==========================================
let tablesReadyPromise = null;

async function ensureWarehouseRentsTables() {
  if (tablesReadyPromise) return tablesReadyPromise;

  tablesReadyPromise = (async () => {
    const sql = `
      CREATE TABLE IF NOT EXISTS warehouse_rents (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        location VARCHAR(255) DEFAULT '',
        landlord_name VARCHAR(255) DEFAULT '',
        landlord_phone VARCHAR(50) DEFAULT '',
        monthly_rent NUMERIC(12, 2) NOT NULL CHECK (monthly_rent > 0),
        due_day INTEGER NOT NULL CHECK (due_day BETWEEN 1 AND 31),
        reminder_days_before INTEGER NOT NULL DEFAULT 3 CHECK (reminder_days_before BETWEEN 0 AND 15),
        contract_start_date DATE NOT NULL DEFAULT CURRENT_DATE,
        tracking_start_month VARCHAR(7) NOT NULL DEFAULT to_char(CURRENT_DATE, 'YYYY-MM'),
        branch_id INTEGER DEFAULT 1,
        status VARCHAR(30) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'ended')),
        annual_increase_enabled BOOLEAN NOT NULL DEFAULT false,
        annual_increase_type VARCHAR(20) NOT NULL DEFAULT 'percent' CHECK (annual_increase_type IN ('percent', 'amount')),
        annual_increase_value NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (annual_increase_value >= 0),
        next_increase_date DATE,
        notes TEXT DEFAULT '',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_warehouse_rents_status ON warehouse_rents(status);

      CREATE TABLE IF NOT EXISTS warehouse_rent_payments (
        id SERIAL PRIMARY KEY,
        rent_id INTEGER NOT NULL REFERENCES warehouse_rents(id) ON DELETE CASCADE,
        billing_month VARCHAR(7) NOT NULL,
        expected_rent NUMERIC(12, 2) NOT NULL,
        amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
        payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
        payment_method VARCHAR(100) DEFAULT 'كاش',
        source_type VARCHAR(30) NOT NULL DEFAULT 'personal' CHECK (source_type IN ('personal', 'treasury')),
        treasury_branch_id INTEGER DEFAULT 1,
        cash_out_id INTEGER REFERENCES cash_out(id) ON DELETE SET NULL,
        permission_number VARCHAR(100) DEFAULT '',
        notes TEXT DEFAULT '',
        created_by INTEGER,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_wrp_rent_month ON warehouse_rent_payments(rent_id, billing_month);
      CREATE INDEX IF NOT EXISTS idx_wrp_cash_out ON warehouse_rent_payments(cash_out_id);

      CREATE TABLE IF NOT EXISTS warehouse_rent_adjustments (
        id SERIAL PRIMARY KEY,
        rent_id INTEGER NOT NULL REFERENCES warehouse_rents(id) ON DELETE CASCADE,
        previous_rent NUMERIC(12, 2) NOT NULL,
        new_rent NUMERIC(12, 2) NOT NULL,
        increase_type VARCHAR(20) NOT NULL DEFAULT 'manual',
        increase_value NUMERIC(12, 2) NOT NULL DEFAULT 0,
        effective_date DATE NOT NULL DEFAULT CURRENT_DATE,
        applied_by INTEGER,
        applied_by_name VARCHAR(150) DEFAULT '',
        notes TEXT DEFAULT '',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_wra_rent_id ON warehouse_rent_adjustments(rent_id);

      ALTER TABLE notifications ADD COLUMN IF NOT EXISTS to_user_id INTEGER;
      ALTER TABLE notifications ADD COLUMN IF NOT EXISTS reminder_key VARCHAR(160);
      ALTER TABLE notifications ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
      CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_reminder_key
        ON notifications(reminder_key)
        WHERE reminder_key IS NOT NULL;
    `;
    await pool.query(sql);
    console.log("✅ warehouse_rents, payments, adjustments & notification reminder index ready");
  })().catch((err) => {
    tablesReadyPromise = null;
    throw err;
  });

  return tablesReadyPromise;
}

// ==========================================
// Core Rent Calculation & Cycle Engine
// ==========================================
function computeAnnualIncreaseState(rent, todayIso) {
  const enabled = Boolean(rent.annual_increase_enabled);
  const type = rent.annual_increase_type === "amount" ? "amount" : "percent";
  const value = round2(rent.annual_increase_value || 0);
  const currentRent = round2(rent.monthly_rent || 0);
  const contractStart =
    toIsoDateOnly(rent.contract_start_date) || todayIso;

  let nextIncreaseDate = toIsoDateOnly(rent.next_increase_date);
  if (enabled && !nextIncreaseDate) {
    nextIncreaseDate = addOneYearIso(contractStart);
  }

  let increaseDelta = 0;
  let suggestedNewRent = currentRent;
  if (enabled && value > 0) {
    if (type === "percent") {
      increaseDelta = round2((currentRent * value) / 100);
      suggestedNewRent = round2(currentRent + increaseDelta);
    } else {
      increaseDelta = round2(value);
      suggestedNewRent = round2(currentRent + increaseDelta);
    }
  }

  const daysUntilIncrease =
    enabled && nextIncreaseDate ? diffDays(todayIso, nextIncreaseDate) : null;
  const isActive = rent.status === "active";

  return {
    enabled,
    type,
    value,
    next_increase_date: nextIncreaseDate,
    days_until_increase: daysUntilIncrease,
    increase_delta: increaseDelta,
    suggested_new_rent: suggestedNewRent,
    is_due_soon:
      isActive &&
      enabled &&
      daysUntilIncrease !== null &&
      daysUntilIncrease > 0 &&
      daysUntilIncrease <= 14,
    is_ready_to_apply:
      isActive &&
      enabled &&
      daysUntilIncrease !== null &&
      daysUntilIncrease <= 0 &&
      increaseDelta > 0,
  };
}

function computeWarehouseRentComputed(
  rawRent,
  rentPayments = [],
  rentAdjustments = [],
  todayIso = getCairoToday(),
) {
  const monthlyRent = round2(rawRent.monthly_rent);
  const dueDay = Number(rawRent.due_day) || 1;
  const reminderDaysBefore =
    rawRent.reminder_days_before != null
      ? Number(rawRent.reminder_days_before)
      : 3;
  const contractStartDate =
    toIsoDateOnly(rawRent.contract_start_date) || todayIso;
  const currentMonth = getMonthKey(todayIso);
  const rawTrackMonth = isValidBillingMonth(rawRent.tracking_start_month)
    ? rawRent.tracking_start_month
    : getMonthKey(contractStartDate);

  // Guard scan window to avoid pathological centuries if bad legacy data
  const earliestAllowedMonth = addMonths(currentMonth, -36);
  const trackingStartMonth =
    rawTrackMonth < earliestAllowedMonth ? earliestAllowedMonth : rawTrackMonth;
  const scanEndMonth = addMonths(
    currentMonth > trackingStartMonth ? currentMonth : trackingStartMonth,
    3,
  );

  // Group payments by billing_month
  const paymentsByMonth = new Map();
  let totalPaidAllTime = 0;
  for (const p of rentPayments) {
    const normalizedPayment = {
      ...p,
      amount: round2(p.amount),
      expected_rent: round2(p.expected_rent),
      payment_date: toIsoDateOnly(p.payment_date) || todayIso,
    };
    totalPaidAllTime = round2(totalPaidAllTime + normalizedPayment.amount);
    const list = paymentsByMonth.get(normalizedPayment.billing_month) || [];
    list.push(normalizedPayment);
    paymentsByMonth.set(normalizedPayment.billing_month, list);
  }

  // Collect ordered billing months set (trackingStartMonth..scanEndMonth + any paid months outside window)
  const monthSet = new Set();
  let cursor = trackingStartMonth;
  let guard = 0;
  while (cursor <= scanEndMonth && guard < 72) {
    monthSet.add(cursor);
    cursor = addMonths(cursor, 1);
    guard++;
  }
  for (const m of paymentsByMonth.keys()) {
    if (isValidBillingMonth(m)) monthSet.add(m);
  }
  const orderedMonths = Array.from(monthSet).sort();

  const cycles = [];
  for (const m of orderedMonths) {
    const mPayments = paymentsByMonth.get(m) || [];
    const dueDate = clampDueDateForMonth(m, dueDay);
    const paidAmount = round2(mPayments.reduce((s, p) => s + p.amount, 0));
    const expectedRent =
      mPayments.length > 0
        ? round2(Math.max(...mPayments.map((p) => p.expected_rent || monthlyRent)))
        : monthlyRent;
    const remainingAmount = Math.max(0, round2(expectedRent - paidAmount));
    const isPaid = remainingAmount <= 0.01;
    const daysUntilDue = diffDays(todayIso, dueDate);

    let cycleStatus = "upcoming";
    if (isPaid) {
      cycleStatus = "paid";
    } else if (dueDate < todayIso) {
      cycleStatus = "overdue";
    } else if (daysUntilDue === 0) {
      cycleStatus = "due_today";
    } else if (daysUntilDue <= reminderDaysBefore) {
      cycleStatus = "due_soon";
    } else if (paidAmount > 0) {
      cycleStatus = "partially_paid";
    }

    cycles.push({
      billing_month: m,
      billing_month_label: formatMonthArabic(m),
      due_date: dueDate,
      expected_rent: expectedRent,
      paid_amount: paidAmount,
      remaining_amount: remainingAmount,
      is_paid: isPaid,
      days_until_due: daysUntilDue,
      status: cycleStatus,
      payments: mPayments,
    });
  }

  const activeCycle =
    cycles.find((c) => c.billing_month >= trackingStartMonth && !c.is_paid) ||
    cycles[cycles.length - 1];

  const overdueCycles =
    rawRent.status === "active"
      ? cycles.filter(
          (c) =>
            c.billing_month >= trackingStartMonth &&
            !c.is_paid &&
            c.due_date < todayIso,
        )
      : [];
  const overdueAmount = round2(
    overdueCycles.reduce((s, c) => s + c.remaining_amount, 0),
  );

  const currentMonthCycle = cycles.find(
    (c) => c.billing_month === currentMonth,
  ) || {
    billing_month: currentMonth,
    billing_month_label: formatMonthArabic(currentMonth),
    due_date: clampDueDateForMonth(currentMonth, dueDay),
    expected_rent:
      trackingStartMonth <= currentMonth && rawRent.status === "active"
        ? monthlyRent
        : 0,
    paid_amount: 0,
    remaining_amount:
      trackingStartMonth <= currentMonth && rawRent.status === "active"
        ? monthlyRent
        : 0,
    is_paid: trackingStartMonth > currentMonth || rawRent.status !== "active",
    days_until_due: diffDays(
      todayIso,
      clampDueDateForMonth(currentMonth, dueDay),
    ),
    status: trackingStartMonth > currentMonth ? "upcoming" : "upcoming",
    payments: [],
  };

  const daysUntilDue = activeCycle ? activeCycle.days_until_due : null;
  let reminderState = "ok";
  if (rawRent.status === "paused") {
    reminderState = "paused";
  } else if (rawRent.status === "ended") {
    reminderState = "ended";
  } else if (overdueCycles.length > 0) {
    reminderState = "overdue";
  } else if (daysUntilDue === 0) {
    reminderState = "due_today";
  } else if (daysUntilDue !== null && daysUntilDue <= reminderDaysBefore) {
    reminderState = "due_soon";
  } else if (currentMonthCycle.is_paid && currentMonth >= trackingStartMonth) {
    reminderState = "paid_current";
  }

  const isReminderActive =
    rawRent.status === "active" &&
    (overdueCycles.length > 0 ||
      (daysUntilDue !== null && daysUntilDue <= reminderDaysBefore));

  const annualIncrease = computeAnnualIncreaseState(rawRent, todayIso);

  return {
    id: Number(rawRent.id),
    name: rawRent.name,
    location: rawRent.location || "",
    landlord_name: rawRent.landlord_name || "",
    landlord_phone: rawRent.landlord_phone || "",
    monthly_rent: monthlyRent,
    due_day: dueDay,
    reminder_days_before: reminderDaysBefore,
    contract_start_date: contractStartDate,
    tracking_start_month: trackingStartMonth,
    branch_id: Number(rawRent.branch_id || 1),
    status: rawRent.status || "active",
    annual_increase_enabled: Boolean(rawRent.annual_increase_enabled),
    annual_increase_type: rawRent.annual_increase_type || "percent",
    annual_increase_value: round2(rawRent.annual_increase_value || 0),
    next_increase_date: annualIncrease.next_increase_date,
    notes: rawRent.notes || "",
    created_at: rawRent.created_at,
    updated_at: rawRent.updated_at,
    // Computed state
    current_month: currentMonth,
    current_month_label: formatMonthArabic(currentMonth),
    current_month_paid: currentMonthCycle.paid_amount,
    current_month_expected:
      trackingStartMonth <= currentMonth ? currentMonthCycle.expected_rent : 0,
    current_month_remaining:
      trackingStartMonth <= currentMonth ? currentMonthCycle.remaining_amount : 0,
    current_month_is_paid:
      trackingStartMonth > currentMonth ? true : currentMonthCycle.is_paid,
    upcoming_billing_month: activeCycle?.billing_month || currentMonth,
    upcoming_billing_month_label:
      activeCycle?.billing_month_label || formatMonthArabic(currentMonth),
    upcoming_due_date: activeCycle?.due_date || clampDueDateForMonth(currentMonth, dueDay),
    upcoming_remaining: activeCycle?.remaining_amount ?? monthlyRent,
    days_until_due: daysUntilDue,
    overdue_count: overdueCycles.length,
    overdue_amount: overdueAmount,
    is_reminder_active: isReminderActive,
    reminder_state: reminderState,
    annual_increase: annualIncrease,
    total_paid_all_time: totalPaidAllTime,
    payments_count: rentPayments.length,
    cycles,
    payments: rentPayments
      .map((p) => ({
        ...p,
        amount: round2(p.amount),
        expected_rent: round2(p.expected_rent),
        payment_date: toIsoDateOnly(p.payment_date) || todayIso,
        billing_month_label: formatMonthArabic(p.billing_month),
      }))
      .sort((a, b) => (b.payment_date || "").localeCompare(a.payment_date || "") || b.id - a.id),
    adjustments: rentAdjustments.map((a) => ({
      ...a,
      previous_rent: round2(a.previous_rent),
      new_rent: round2(a.new_rent),
      increase_value: round2(a.increase_value),
      effective_date: toIsoDateOnly(a.effective_date),
    })),
  };
}

async function fetchAllComputedRents(todayIso = getCairoToday()) {
  await ensureWarehouseRentsTables();

  const [rentsRes, paymentsRes, adjRes] = await Promise.all([
    pool.query(`SELECT * FROM warehouse_rents ORDER BY CASE WHEN status = 'active' THEN 1 WHEN status = 'paused' THEN 2 ELSE 3 END, id DESC`),
    pool.query(`SELECT * FROM warehouse_rent_payments ORDER BY billing_month ASC, payment_date DESC, id DESC`),
    pool.query(`SELECT * FROM warehouse_rent_adjustments ORDER BY effective_date DESC, id DESC`),
  ]);

  const payMap = new Map();
  for (const p of paymentsRes.rows) {
    const arr = payMap.get(Number(p.rent_id)) || [];
    arr.push(p);
    payMap.set(Number(p.rent_id), arr);
  }

  const adjMap = new Map();
  for (const a of adjRes.rows) {
    const arr = adjMap.get(Number(a.rent_id)) || [];
    arr.push(a);
    adjMap.set(Number(a.rent_id), arr);
  }

  return rentsRes.rows.map((r) =>
    computeWarehouseRentComputed(
      r,
      payMap.get(Number(r.id)) || [],
      adjMap.get(Number(r.id)) || [],
      todayIso,
    ),
  );
}

// ==========================================
// Automatic 3-Day & Annual Increase Notification Sync
// ==========================================
let reminderSyncInFlight = null;

async function syncWarehouseRentReminders({ broadcastRealtime = null, sendPushToUser = null } = {}) {
  if (reminderSyncInFlight) return reminderSyncInFlight;

  reminderSyncInFlight = (async () => {
    try {
      await ensureWarehouseRentsTables();
      const todayIso = getCairoToday();
      const rents = await fetchAllComputedRents(todayIso);
      const activeRents = rents.filter((r) => r.status === "active");
      if (activeRents.length === 0) return { created: 0 };

      const adminsRes = await pool.query(
        `SELECT id, branch_id, full_name, username FROM users
         WHERE is_active IS NOT FALSE AND (role = 'admin' OR id IN (7, 11) OR username = 'خالد')`,
      );
      const admins = adminsRes.rows;
      if (admins.length === 0) return { created: 0 };

      let created = 0;

      for (const rent of activeRents) {
        const candidates = [];

        // 1. Overdue rent reminder
        if (rent.overdue_count > 0) {
          const oldestOverdue = rent.cycles.find(
            (c) => c.billing_month >= rent.tracking_start_month && !c.is_paid && c.due_date < todayIso,
          );
          if (oldestOverdue) {
            candidates.push({
              title: `⚠️ إيجار مخزن متأخر: ${rent.name}`,
              message: `إيجار مخزن «${rent.name}» لشهر ${oldestOverdue.billing_month_label} متأخر (استحقاق ${oldestOverdue.due_date}) — المستحق ${rent.overdue_amount.toLocaleString()} ج.م`,
              keyPrefix: `rent_over:${rent.id}:${oldestOverdue.billing_month}`,
            });
          }
        } else if (
          rent.days_until_due !== null &&
          rent.days_until_due >= 0 &&
          rent.days_until_due <= rent.reminder_days_before
        ) {
          // 2. 3-day pre-due reminder
          const whenText =
            rent.days_until_due === 0
              ? "اليوم"
              : rent.days_until_due === 1
              ? "غداً (متبقي يوم واحد)"
              : `بعد ${rent.days_until_due} أيام`;
          candidates.push({
            title:
              rent.days_until_due === 0
                ? `🔔 استحقاق إيجار مخزن اليوم: ${rent.name}`
                : `🔔 تذكير إيجار مخزن: ${rent.name}`,
            message: `إيجار مخزن «${rent.name}» (${rent.upcoming_billing_month_label}) مستحق ${whenText} بتاريخ ${rent.upcoming_due_date} بقيمة ${rent.upcoming_remaining.toLocaleString()} ج.م`,
            keyPrefix: `rent_due:${rent.id}:${rent.upcoming_billing_month}`,
          });
        }

        // 3. Annual increase reminder (within 7 days before or past due date)
        if (
          rent.annual_increase?.enabled &&
          rent.annual_increase.increase_delta > 0 &&
          rent.annual_increase.days_until_increase !== null &&
          rent.annual_increase.days_until_increase <= 7
        ) {
          candidates.push({
            title: `📈 موعد الزيادة السنوية: ${rent.name}`,
            message: `حان موعد مراجعة الزيادة السنوية لإيجار مخزن «${rent.name}» (${rent.annual_increase.next_increase_date}) — الإيجار المقترح ${rent.annual_increase.suggested_new_rent.toLocaleString()} ج.م`,
            keyPrefix: `rent_inc:${rent.id}:${rent.annual_increase.next_increase_date}`,
          });
        }

        for (const c of candidates) {
          for (const admin of admins) {
            const reminderKey = `${c.keyPrefix}:u:${admin.id}`;
            const targetBranch = Number(admin.branch_id) || 1;
            const ins = await pool.query(
              `
              INSERT INTO notifications (title, message, from_user_id, to_branch_id, to_user_id, type, reference_id, reminder_key)
              VALUES ($1, $2, NULL, $3, $4, 'warehouse_rent_reminder', $5, $6)
              ON CONFLICT (reminder_key) WHERE reminder_key IS NOT NULL DO NOTHING
              RETURNING id, title, message, type, reference_id, is_read, created_at
              `,
              [c.title, c.message, targetBranch, admin.id, rent.id, reminderKey],
            );

            if (ins.rowCount > 0) {
              created++;
              const row = ins.rows[0];
              if (typeof broadcastRealtime === "function") {
                broadcastRealtime(
                  "new_notification",
                  {
                    id: row.id,
                    title: row.title,
                    message: row.message,
                    type: row.type,
                    reference_id: row.reference_id,
                    is_read: false,
                    created_at: row.created_at,
                  },
                  `user_${admin.id}`,
                );
              }
              if (typeof sendPushToUser === "function") {
                sendPushToUser(admin.id, row.title, row.message, null, {
                  url: "/debts?tab=rents",
                  type: "warehouse_rent_reminder",
                  rent_id: rent.id,
                }).catch(() => {});
              }
            }
          }
        }
      }

      return { created };
    } catch (err) {
      console.error("syncWarehouseRentReminders error:", err.message);
      return { created: 0, error: err.message };
    } finally {
      reminderSyncInFlight = null;
    }
  })();

  return reminderSyncInFlight;
}

// ==========================================
// Controller Endpoints
// ==========================================

// 1. Summary KPIs for Warehouse Rents Band
exports.getSummary = async (req, res) => {
  try {
    const todayIso = getCairoToday();
    const rents = await fetchAllComputedRents(todayIso);

    // Fire reminder sync asynchronously so new due windows reflect in bell too
    void syncWarehouseRentReminders({
      broadcastRealtime: req.app?.get("broadcastRealtime"),
      sendPushToUser: req.app?.get("sendPushToUser"),
    });

    const activeRents = rents.filter((r) => r.status === "active");
    const pausedRents = rents.filter((r) => r.status === "paused");
    const endedRents = rents.filter((r) => r.status === "ended");

    const totalMonthlyRent = round2(
      activeRents.reduce((s, r) => s + r.monthly_rent, 0),
    );
    const currentMonth = getMonthKey(todayIso);

    // Include payments recorded toward the current calendar month (across all warehouses)
    let totalPaidThisMonth = 0;
    let remainingThisMonth = 0;
    for (const r of rents) {
      const mPay = r.payments
        .filter((p) => p.billing_month === currentMonth)
        .reduce((s, p) => s + Number(p.amount || 0), 0);
      totalPaidThisMonth = round2(totalPaidThisMonth + mPay);
      if (r.status === "active") {
        remainingThisMonth = round2(
          remainingThisMonth + Number(r.current_month_remaining || 0),
        );
      }
    }

    const overdueRents = activeRents.filter((r) => r.overdue_count > 0);
    const overdueAmount = round2(
      overdueRents.reduce((s, r) => s + r.overdue_amount, 0),
    );
    const dueSoonRents = activeRents.filter(
      (r) =>
        r.overdue_count === 0 &&
        r.days_until_due !== null &&
        r.days_until_due >= 0 &&
        r.days_until_due <= r.reminder_days_before,
    );
    const annualIncreaseReadyCount = activeRents.filter(
      (r) => r.annual_increase?.is_ready_to_apply || r.annual_increase?.is_due_soon,
    ).length;

    return res.json({
      current_month: currentMonth,
      current_month_label: formatMonthArabic(currentMonth),
      total_warehouses: rents.length,
      active_warehouses_count: activeRents.length,
      paused_warehouses_count: pausedRents.length,
      ended_warehouses_count: endedRents.length,
      total_monthly_rent: totalMonthlyRent,
      total_paid_this_month: totalPaidThisMonth,
      remaining_this_month: remainingThisMonth,
      overdue_count: overdueRents.length,
      overdue_amount: overdueAmount,
      due_soon_count: dueSoonRents.length,
      alerts_count: overdueRents.length + dueSoonRents.length,
      annual_increase_due_count: annualIncreaseReadyCount,
    });
  } catch (err) {
    console.error("getWarehouseRentsSummary error:", err);
    return res.status(500).json({ error: "فشل تحميل ملخص إيجار المخازن" });
  }
};

// 2. List All Rented Warehouses with Computed Reminders & Cycles
exports.getRents = async (req, res) => {
  try {
    const todayIso = getCairoToday();
    let rents = await fetchAllComputedRents(todayIso);

    void syncWarehouseRentReminders({
      broadcastRealtime: req.app?.get("broadcastRealtime"),
      sendPushToUser: req.app?.get("sendPushToUser"),
    });

    const { status, search } = req.query;
    if (status && status !== "all") {
      rents = rents.filter((r) => r.status === status);
    }
    if (search && String(search).trim()) {
      const q = String(search).trim().toLowerCase();
      rents = rents.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.landlord_name.toLowerCase().includes(q) ||
          r.location.toLowerCase().includes(q) ||
          r.landlord_phone.includes(q),
      );
    }

    return res.json(rents);
  } catch (err) {
    console.error("getWarehouseRents error:", err);
    return res.status(500).json({ error: "فشل تحميل قائمة إيجار المخازن" });
  }
};

// 3. Get Single Rented Warehouse Details
exports.getRentById = async (req, res) => {
  const rentId = parseStrictId(req.params.id);
  if (!rentId) {
    return res.status(400).json({ error: "معرف المخزن غير صالح" });
  }

  try {
    await ensureWarehouseRentsTables();
    const todayIso = getCairoToday();
    const [rentRes, payRes, adjRes] = await Promise.all([
      pool.query(`SELECT * FROM warehouse_rents WHERE id = $1`, [rentId]),
      pool.query(
        `SELECT * FROM warehouse_rent_payments WHERE rent_id = $1 ORDER BY billing_month ASC, payment_date DESC, id DESC`,
        [rentId],
      ),
      pool.query(
        `SELECT * FROM warehouse_rent_adjustments WHERE rent_id = $1 ORDER BY effective_date DESC, id DESC`,
        [rentId],
      ),
    ]);

    if (rentRes.rows.length === 0) {
      return res.status(404).json({ error: "المخزن غير موجود" });
    }

    return res.json(
      computeWarehouseRentComputed(
        rentRes.rows[0],
        payRes.rows,
        adjRes.rows,
        todayIso,
      ),
    );
  } catch (err) {
    console.error("getWarehouseRentById error:", err);
    return res.status(500).json({ error: "فشل جلب بيانات إيجار المخزن" });
  }
};

// 4. Create Rented Warehouse
exports.createRent = async (req, res) => {
  try {
    await ensureWarehouseRentsTables();
    const todayIso = getCairoToday();
    const currentMonth = getMonthKey(todayIso);

    const {
      name,
      location = "",
      landlord_name = "",
      landlord_phone = "",
      monthly_rent,
      due_day = 1,
      reminder_days_before = 3,
      contract_start_date,
      tracking_start_month,
      current_month_already_paid = false,
      branch_id = 1,
      annual_increase_enabled = false,
      annual_increase_type = "percent",
      annual_increase_value = 0,
      next_increase_date,
      notes = "",
    } = req.body;

    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "يرجى إدخال اسم المخزن المؤجر" });
    }

    const safeRent = parsePositiveFinite(monthly_rent);
    if (!safeRent) {
      return res.status(400).json({ error: "قيمة الإيجار الشهري يجب أن تكون أكبر من صفر" });
    }

    const safeDueDay = parseStrictIntRange(due_day, 1, 31);
    if (!safeDueDay) {
      return res.status(400).json({ error: "يوم الاستحقاق الشهري يجب أن يكون بين 1 و 31" });
    }

    const safeReminderDays = parseStrictIntRange(reminder_days_before ?? 3, 0, 15);
    if (safeReminderDays === null) {
      return res.status(400).json({ error: "عدد أيام التذكير يجب أن يكون بين 0 و 15 يوم" });
    }

    const safeContractStart = isValidIsoDate(contract_start_date)
      ? contract_start_date
      : todayIso;

    let safeTrackMonth = isValidBillingMonth(tracking_start_month)
      ? tracking_start_month
      : currentMonth;
    if (current_month_already_paid === true && !isValidBillingMonth(tracking_start_month)) {
      safeTrackMonth = addMonths(currentMonth, 1);
    }

    const safeBranchId = Number(branch_id) === 2 ? 2 : 1;
    const safeIncEnabled = Boolean(annual_increase_enabled);
    const safeIncType = annual_increase_type === "amount" ? "amount" : "percent";
    let safeIncValue = 0;
    let safeNextIncDate = null;

    if (safeIncEnabled) {
      const parsedVal = parsePositiveFinite(annual_increase_value);
      if (!parsedVal) {
        return res.status(400).json({
          error: "يرجى إدخال قيمة الزيادة السنوية (أكبر من صفر) أو إلغاء تفعيلها",
        });
      }
      if (safeIncType === "percent" && parsedVal > 500) {
        return res.status(400).json({ error: "نسبة الزيادة السنوية غير منطقية" });
      }
      safeIncValue = parsedVal;
      if (isValidIsoDate(next_increase_date)) {
        safeNextIncDate = next_increase_date;
      } else {
        // First future annual anniversary from contract_start_date (>= today or contractStart + 1 year)
        let candidate = addOneYearIso(safeContractStart);
        let guard = 0;
        while (candidate < todayIso && guard < 30) {
          candidate = addOneYearIso(candidate);
          guard++;
        }
        safeNextIncDate = candidate;
      }
    }

    const insertRes = await pool.query(
      `
      INSERT INTO warehouse_rents (
        name, location, landlord_name, landlord_phone, monthly_rent, due_day,
        reminder_days_before, contract_start_date, tracking_start_month, branch_id,
        status, annual_increase_enabled, annual_increase_type, annual_increase_value,
        next_increase_date, notes
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10,
        'active', $11, $12, $13,
        $14, $15
      )
      RETURNING *
      `,
      [
        name.trim(),
        String(location || "").trim(),
        String(landlord_name || "").trim(),
        String(landlord_phone || "").trim(),
        safeRent,
        safeDueDay,
        safeReminderDays,
        safeContractStart,
        safeTrackMonth,
        safeBranchId,
        safeIncEnabled,
        safeIncType,
        safeIncValue,
        safeNextIncDate,
        String(notes || "").trim(),
      ],
    );

    const created = insertRes.rows[0];
    void syncWarehouseRentReminders({
      broadcastRealtime: req.app?.get("broadcastRealtime"),
      sendPushToUser: req.app?.get("sendPushToUser"),
    });

    return res.status(201).json({
      success: true,
      rent: computeWarehouseRentComputed(created, [], [], todayIso),
    });
  } catch (err) {
    console.error("createWarehouseRent error:", err);
    return res.status(500).json({ error: "فشل إضافة المخزن المؤجر" });
  }
};

// 5. Update Rented Warehouse
exports.updateRent = async (req, res) => {
  const rentId = parseStrictId(req.params.id);
  if (!rentId) {
    return res.status(400).json({ error: "معرف المخزن غير صالح" });
  }

  let client;
  let txStarted = false;
  try {
    await ensureWarehouseRentsTables();
    client = await pool.connect();
    await client.query("BEGIN");
    txStarted = true;

    const existingRes = await client.query(
      `SELECT * FROM warehouse_rents WHERE id = $1 FOR UPDATE`,
      [rentId],
    );
    if (existingRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "المخزن غير موجود" });
    }
    const current = existingRes.rows[0];
    const todayIso = getCairoToday();

    const {
      name,
      location,
      landlord_name,
      landlord_phone,
      monthly_rent,
      due_day,
      reminder_days_before,
      contract_start_date,
      tracking_start_month,
      branch_id,
      status,
      annual_increase_enabled,
      annual_increase_type,
      annual_increase_value,
      next_increase_date,
      notes,
    } = req.body;

    const safeName =
      name !== undefined
        ? String(name || "").trim()
        : current.name;
    if (!safeName) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "اسم المخزن مطلوب" });
    }

    const oldRent = round2(current.monthly_rent);
    const safeRent =
      monthly_rent !== undefined
        ? parsePositiveFinite(monthly_rent)
        : oldRent;
    if (!safeRent) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "قيمة الإيجار الشهري يجب أن تكون أكبر من صفر" });
    }

    const safeDueDay =
      due_day !== undefined
        ? parseStrictIntRange(due_day, 1, 31)
        : Number(current.due_day);
    if (!safeDueDay) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "يوم الاستحقاق الشهري يجب أن يكون بين 1 و 31" });
    }

    const safeReminderDays =
      reminder_days_before !== undefined
        ? parseStrictIntRange(reminder_days_before, 0, 15)
        : Number(current.reminder_days_before);
    if (safeReminderDays === null) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "أيام التذكير يجب أن تكون بين 0 و 15 يوم" });
    }

    const safeContractStart =
      contract_start_date !== undefined
        ? isValidIsoDate(contract_start_date)
          ? contract_start_date
          : null
        : toIsoDateOnly(current.contract_start_date) || todayIso;
    if (!safeContractStart) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "تاريخ بداية العقد غير صالح" });
    }

    const safeTrackMonth =
      tracking_start_month !== undefined
        ? isValidBillingMonth(tracking_start_month)
          ? tracking_start_month
          : null
        : current.tracking_start_month;
    if (!safeTrackMonth) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "شهر بداية المتابعة غير صالح (YYYY-MM)" });
    }

    const allowedStatuses = new Set(["active", "paused", "ended"]);
    const safeStatus =
      status !== undefined
        ? allowedStatuses.has(status)
          ? status
          : null
        : current.status;
    if (!safeStatus) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "حالة المخزن غير صالحة" });
    }

    const safeBranchId =
      branch_id !== undefined
        ? Number(branch_id) === 2
          ? 2
          : 1
        : Number(current.branch_id || 1);

    const safeIncEnabled =
      annual_increase_enabled !== undefined
        ? Boolean(annual_increase_enabled)
        : Boolean(current.annual_increase_enabled);
    const safeIncType =
      annual_increase_type !== undefined
        ? annual_increase_type === "amount"
          ? "amount"
          : "percent"
        : current.annual_increase_type || "percent";

    let safeIncValue = round2(current.annual_increase_value || 0);
    let safeNextIncDate = toIsoDateOnly(current.next_increase_date);

    if (safeIncEnabled) {
      if (annual_increase_value !== undefined) {
        const parsedVal = parsePositiveFinite(annual_increase_value);
        if (!parsedVal) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "قيمة الزيادة السنوية يجب أن تكون أكبر من صفر" });
        }
        safeIncValue = parsedVal;
      } else if (safeIncValue <= 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "يرجى إدخال قيمة الزيادة السنوية" });
      }
      if (safeIncType === "percent" && safeIncValue > 500) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "نسبة الزيادة السنوية غير منطقية" });
      }
      if (next_increase_date !== undefined) {
        safeNextIncDate = isValidIsoDate(next_increase_date)
          ? next_increase_date
          : addOneYearIso(safeContractStart);
      } else if (!safeNextIncDate) {
        let candidate = addOneYearIso(safeContractStart);
        let guard = 0;
        while (candidate < todayIso && guard < 30) {
          candidate = addOneYearIso(candidate);
          guard++;
        }
        safeNextIncDate = candidate;
      }
    } else {
      safeIncValue = 0;
      safeNextIncDate = null;
    }

    const updRes = await client.query(
      `
      UPDATE warehouse_rents
      SET
        name = $1,
        location = $2,
        landlord_name = $3,
        landlord_phone = $4,
        monthly_rent = $5,
        due_day = $6,
        reminder_days_before = $7,
        contract_start_date = $8,
        tracking_start_month = $9,
        branch_id = $10,
        status = $11,
        annual_increase_enabled = $12,
        annual_increase_type = $13,
        annual_increase_value = $14,
        next_increase_date = $15,
        notes = $16,
        updated_at = NOW()
      WHERE id = $17
      RETURNING *
      `,
      [
        safeName,
        location !== undefined ? String(location || "").trim() : current.location,
        landlord_name !== undefined ? String(landlord_name || "").trim() : current.landlord_name,
        landlord_phone !== undefined ? String(landlord_phone || "").trim() : current.landlord_phone,
        safeRent,
        safeDueDay,
        safeReminderDays,
        safeContractStart,
        safeTrackMonth,
        safeBranchId,
        safeStatus,
        safeIncEnabled,
        safeIncType,
        safeIncValue,
        safeNextIncDate,
        notes !== undefined ? String(notes || "").trim() : current.notes,
        rentId,
      ],
    );

    // Log manual rent adjustment cleanly if monthly_rent changed
    if (safeRent !== oldRent) {
      await client.query(
        `
        INSERT INTO warehouse_rent_adjustments (
          rent_id, previous_rent, new_rent, increase_type, increase_value,
          effective_date, applied_by, applied_by_name, notes
        ) VALUES ($1, $2, $3, 'manual', $4, $5, $6, $7, $8)
        `,
        [
          rentId,
          oldRent,
          safeRent,
          round2(safeRent - oldRent),
          todayIso,
          req.user?.id || null,
          req.user?.full_name || req.user?.username || "الإدارة",
          "تعديل يدوي لقيمة الإيجار الشهري",
        ],
      );
    }

    await client.query("COMMIT");
    txStarted = false;

    void syncWarehouseRentReminders({
      broadcastRealtime: req.app?.get("broadcastRealtime"),
      sendPushToUser: req.app?.get("sendPushToUser"),
    });

    return res.json({ success: true, rent: updRes.rows[0] });
  } catch (err) {
    if (txStarted && client) await client.query("ROLLBACK").catch(() => {});
    console.error("updateWarehouseRent error:", err);
    return res.status(500).json({ error: "فشل تعديل بيانات المخزن المؤجر" });
  } finally {
    if (client) client.release();
  }
};

// 6. Delete Rented Warehouse
exports.deleteRent = async (req, res) => {
  const rentId = parseStrictId(req.params.id);
  if (!rentId) {
    return res.status(400).json({ error: "معرف المخزن غير صالح" });
  }

  let client;
  let txStarted = false;
  try {
    await ensureWarehouseRentsTables();
    client = await pool.connect();
    await client.query("BEGIN");
    txStarted = true;

    const del = await client.query(
      `DELETE FROM warehouse_rents WHERE id = $1 RETURNING id, name`,
      [rentId],
    );
    if (del.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "المخزن غير موجود" });
    }

    await client.query(
      `DELETE FROM notifications WHERE type = 'warehouse_rent_reminder' AND reference_id = $1`,
      [rentId],
    );

    await client.query("COMMIT");
    txStarted = false;
    return res.json({ success: true, message: "تم حذف المخزن المؤجر بنجاح" });
  } catch (err) {
    if (txStarted && client) await client.query("ROLLBACK").catch(() => {});
    console.error("deleteWarehouseRent error:", err);
    return res.status(500).json({ error: "فشل حذف المخزن المؤجر" });
  } finally {
    if (client) client.release();
  }
};

// 7. Pay Rent for a Warehouse Billing Month (Personal or Treasury cash_out)
exports.payRent = async (req, res) => {
  const rentId = parseStrictId(req.params.id);
  if (!rentId) {
    return res.status(400).json({ error: "معرف المخزن غير صالح" });
  }

  let client;
  let txStarted = false;
  try {
    await ensureWarehouseRentsTables();
    const todayIso = getCairoToday();

    const {
      billing_month,
      amount,
      payment_date = todayIso,
      payment_method = "كاش",
      source_type = "personal",
      treasury_branch_id,
      notes = "",
    } = req.body;

    const safeMonth = isValidBillingMonth(billing_month)
      ? billing_month
      : getMonthKey(todayIso);
    const safePayDate = isValidIsoDate(payment_date) ? payment_date : todayIso;
    const safeSource = source_type === "treasury" ? "treasury" : "personal";
    const safeMethod = String(payment_method || "كاش").trim() || "كاش";
    const safeNotes = String(notes || "").trim();

    client = await pool.connect();
    await client.query("BEGIN");
    txStarted = true;

    const rentRes = await client.query(
      `SELECT * FROM warehouse_rents WHERE id = $1 FOR UPDATE`,
      [rentId],
    );
    if (rentRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "المخزن غير موجود" });
    }
    const rent = rentRes.rows[0];

    const monthPayRes = await client.query(
      `SELECT COALESCE(MAX(expected_rent), 0) AS prev_expected, COALESCE(SUM(amount), 0) AS prev_paid
       FROM warehouse_rent_payments
       WHERE rent_id = $1 AND billing_month = $2`,
      [rentId, safeMonth],
    );
    const prevExpected = Number(monthPayRes.rows[0]?.prev_expected || 0);
    const expectedRent =
      prevExpected > 0 ? round2(prevExpected) : round2(rent.monthly_rent);
    const alreadyPaid = round2(monthPayRes.rows[0]?.prev_paid || 0);
    const dueRemaining = Math.max(0, round2(expectedRent - alreadyPaid));
    if (dueRemaining <= 0.01) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: `تم سداد إيجار شهر ${formatMonthArabic(safeMonth)} بالكامل مسبقاً`,
      });
    }

    const payAmount =
      amount !== undefined && amount !== "" && amount !== null
        ? parsePositiveFinite(amount)
        : dueRemaining;

    if (!payAmount) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "قيمة السداد يجب أن تكون أكبر من صفر" });
    }

    const safeTreasuryBranch =
      Number(treasury_branch_id) === 2
        ? 2
        : Number(treasury_branch_id) === 1
        ? 1
        : Number(rent.branch_id) === 2
        ? 2
        : 1;

    let cashOutId = null;
    let permissionNumber = "";

    if (safeSource === "treasury") {
      permissionNumber = generatePermissionNumber(safePayDate);
      const monthLabel = formatMonthArabic(safeMonth);
      const cashOutRes = await client.query(
        `
        INSERT INTO cash_out
          (branch_id, name, amount, notes, transaction_date, permission_number, entry_type)
        VALUES ($1, $2, $3, $4, $5, $6, 'expense')
        RETURNING id
        `,
        [
          safeTreasuryBranch,
          `إيجار مخزن: ${rent.name} (${monthLabel})`,
          payAmount,
          `سداد إيجار مخزن «${rent.name}» عن شهر ${monthLabel}${safeNotes ? ` - ${safeNotes}` : ""}`,
          safePayDate,
          permissionNumber,
        ],
      );
      cashOutId = cashOutRes.rows[0].id;
    }

    const payIns = await client.query(
      `
      INSERT INTO warehouse_rent_payments (
        rent_id, billing_month, expected_rent, amount, payment_date,
        payment_method, source_type, treasury_branch_id, cash_out_id,
        permission_number, notes, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *
      `,
      [
        rentId,
        safeMonth,
        expectedRent,
        payAmount,
        safePayDate,
        safeMethod,
        safeSource,
        safeSource === "treasury" ? safeTreasuryBranch : null,
        cashOutId,
        permissionNumber,
        safeNotes || `سداد إيجار شهر ${formatMonthArabic(safeMonth)}`,
        req.user?.id || null,
      ],
    );

    // Clear unread reminder notification for this specific warehouse + billing month if month is now settled
    const newPaidTotal = round2(alreadyPaid + payAmount);
    if (newPaidTotal >= expectedRent - 0.01) {
      await client.query(
        `UPDATE notifications
         SET is_read = true, updated_at = NOW()
         WHERE type = 'warehouse_rent_reminder'
           AND reference_id = $1
           AND (
             reminder_key LIKE $2 ESCAPE '\\'
             OR reminder_key LIKE $3 ESCAPE '\\'
           )`,
        [
          rentId,
          `rent\\_due:${rentId}:${safeMonth}:%`,
          `rent\\_over:${rentId}:${safeMonth}:%`,
        ],
      );
    }

    await client.query("COMMIT");
    txStarted = false;

    const broadcast = req.app?.get("broadcastRealtime");
    if (typeof broadcast === "function" && safeSource === "treasury") {
      broadcast("data:cash", {
        action: "cash_out_created",
        id: cashOutId,
        branch_id: safeTreasuryBranch,
        ts: Date.now(),
      });
    }

    return res.json({
      success: true,
      message: "تم تسجيل سداد الإيجار بنجاح",
      payment: payIns.rows[0],
      cash_out_id: cashOutId,
      permission_number: permissionNumber,
    });
  } catch (err) {
    if (txStarted && client) await client.query("ROLLBACK").catch(() => {});
    console.error("payWarehouseRent error:", err);
    return res.status(500).json({ error: "فشل تسجيل سداد الإيجار" });
  } finally {
    if (client) client.release();
  }
};

// 8. Delete / Revert Single Rent Payment Transaction
exports.deleteRentPayment = async (req, res) => {
  const paymentId = parseStrictId(req.params.paymentId);
  if (!paymentId) {
    return res.status(400).json({ error: "معرف دفعة الإيجار غير صالح" });
  }

  let client;
  let txStarted = false;
  try {
    await ensureWarehouseRentsTables();
    client = await pool.connect();
    await client.query("BEGIN");
    txStarted = true;

    const pRes = await client.query(
      `SELECT * FROM warehouse_rent_payments WHERE id = $1 FOR UPDATE`,
      [paymentId],
    );
    if (pRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "دفعة الإيجار غير موجودة" });
    }
    const payment = pRes.rows[0];

    await client.query(`DELETE FROM warehouse_rent_payments WHERE id = $1`, [
      paymentId,
    ]);

    if (payment.cash_out_id) {
      await client.query(`DELETE FROM cash_out WHERE id = $1`, [
        payment.cash_out_id,
      ]);
    }

    await client.query("COMMIT");
    txStarted = false;

    if (payment.cash_out_id) {
      const broadcast = req.app?.get("broadcastRealtime");
      if (typeof broadcast === "function") {
        broadcast("data:cash", {
          action: "cash_out_deleted",
          id: payment.cash_out_id,
          branch_id: payment.treasury_branch_id || 1,
          ts: Date.now(),
        });
      }
    }

    return res.json({
      success: true,
      message: "تم إلغاء دفعة الإيجار بنجاح",
    });
  } catch (err) {
    if (txStarted && client) await client.query("ROLLBACK").catch(() => {});
    console.error("deleteWarehouseRentPayment error:", err);
    return res.status(500).json({ error: "فشل حذف دفعة الإيجار" });
  } finally {
    if (client) client.release();
  }
};

// 9. Apply or Skip Annual Rent Increase (Confirmation Flow)
exports.applyAnnualIncrease = async (req, res) => {
  const rentId = parseStrictId(req.params.id);
  if (!rentId) {
    return res.status(400).json({ error: "معرف المخزن غير صالح" });
  }

  let client;
  let txStarted = false;
  try {
    await ensureWarehouseRentsTables();
    const todayIso = getCairoToday();
    const {
      action = "apply", // 'apply' | 'skip'
      new_rent,
      effective_date = todayIso,
      notes = "",
    } = req.body || {};

    const safeEffectiveDate = isValidIsoDate(effective_date)
      ? effective_date
      : todayIso;

    client = await pool.connect();
    await client.query("BEGIN");
    txStarted = true;

    const rentRes = await client.query(
      `SELECT * FROM warehouse_rents WHERE id = $1 FOR UPDATE`,
      [rentId],
    );
    if (rentRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "المخزن غير موجود" });
    }

    const current = rentRes.rows[0];
    const annual = computeAnnualIncreaseState(current, todayIso);
    const oldNextDate =
      annual.next_increase_date || addOneYearIso(toIsoDateOnly(current.contract_start_date) || todayIso);
    let nextYearDate = addOneYearIso(oldNextDate);
    if (nextYearDate <= safeEffectiveDate) {
      nextYearDate = addOneYearIso(safeEffectiveDate);
    }

    if (action === "skip") {
      await client.query(
        `UPDATE warehouse_rents SET next_increase_date = $1, updated_at = NOW() WHERE id = $2`,
        [nextYearDate, rentId],
      );
      await client.query(
        `
        INSERT INTO warehouse_rent_adjustments (
          rent_id, previous_rent, new_rent, increase_type, increase_value,
          effective_date, applied_by, applied_by_name, notes
        ) VALUES ($1, $2, $2, 'skipped', 0, $3, $4, $5, $6)
        `,
        [
          rentId,
          round2(current.monthly_rent),
          safeEffectiveDate,
          req.user?.id || null,
          req.user?.full_name || req.user?.username || "الإدارة",
          String(notes || "").trim() || "تأجيل الزيادة السنوية للعام القادم",
        ],
      );
    } else {
      const targetNewRent =
        new_rent !== undefined && new_rent !== "" && new_rent !== null
          ? parsePositiveFinite(new_rent)
          : annual.suggested_new_rent;

      if (!targetNewRent) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "قيمة الإيجار الجديد يجب أن تكون أكبر من صفر" });
      }

      const oldRent = round2(current.monthly_rent);
      const delta = round2(targetNewRent - oldRent);

      await client.query(
        `UPDATE warehouse_rents SET monthly_rent = $1, next_increase_date = $2, updated_at = NOW() WHERE id = $3`,
        [targetNewRent, nextYearDate, rentId],
      );

      await client.query(
        `
        INSERT INTO warehouse_rent_adjustments (
          rent_id, previous_rent, new_rent, increase_type, increase_value,
          effective_date, applied_by, applied_by_name, notes
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `,
        [
          rentId,
          oldRent,
          targetNewRent,
          annual.enabled ? annual.type : "manual",
          annual.enabled && targetNewRent === annual.suggested_new_rent
            ? annual.value
            : delta,
          safeEffectiveDate,
          req.user?.id || null,
          req.user?.full_name || req.user?.username || "الإدارة",
          String(notes || "").trim() || "تطبيق الزيادة السنوية للإيجار",
        ],
      );
    }

    // Mark current increase reminder notifications as read
    await client.query(
      `UPDATE notifications
       SET is_read = true, updated_at = NOW()
       WHERE type = 'warehouse_rent_reminder'
         AND reference_id = $1
         AND reminder_key LIKE $2 ESCAPE '\\'`,
      [rentId, `rent\\_inc:${rentId}:%`],
    );

    await client.query("COMMIT");
    txStarted = false;

    return res.json({
      success: true,
      message:
        action === "skip"
          ? "تم تأجيل الزيادة السنوية للعام القادم"
          : "تم تطبيق الزيادة السنوية وتحديث قيمة الإيجار بنجاح",
    });
  } catch (err) {
    if (txStarted && client) await client.query("ROLLBACK").catch(() => {});
    console.error("applyAnnualIncrease error:", err);
    return res.status(500).json({ error: "فشل تحديث الزيادة السنوية" });
  } finally {
    if (client) client.release();
  }
};

exports.syncWarehouseRentReminders = syncWarehouseRentReminders;
exports.ensureWarehouseRentsTables = ensureWarehouseRentsTables;
exports.getCairoToday = getCairoToday;
