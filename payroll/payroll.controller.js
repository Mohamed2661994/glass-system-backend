const pool = require("../db");

/**
 * Generate a consistent permission number matching cash_out standards
 */
function generatePermissionNumber(dateStr) {
  const datePart = (dateStr || new Date().toISOString().slice(0, 10))
    .replace(/-/g, "")
    .slice(2);
  const randomPart = Math.floor(1000 + Math.random() * 9000);
  return `${datePart}-${randomPart}`;
}

/**
 * Format job title with appropriate Arabic prefix for receipts and vouchers
 * e.g., 'مدير' -> 'للمدير', 'عامل' -> 'للعامل', 'سائق' -> 'للسائق', 'Marketing Manager' -> 'لـ (Marketing Manager)'
 */
function formatJobTitleWithPrefix(jobTitle) {
  if (!jobTitle || !String(jobTitle).trim()) return "للموظف";
  const title = String(jobTitle).trim();

  const map = {
    "مدير": "للمدير",
    "المدير": "للمدير",
    "عامل": "للعامل",
    "العامل": "للعامل",
    "سائق": "للسائق",
    "السائق": "للسائق",
    "سواق": "للسائق",
    "محاسب": "للمحاسب",
    "المحاسب": "للمحاسب",
    "مشرف": "للمشرف",
    "المشرف": "للمشرف",
    "مندوب": "للمندوب",
    "المندوب": "للمندوب",
    "كاشير": "للكاشير",
    "الكاشير": "للكاشير",
    "مسؤول": "للمسؤول",
    "المسؤول": "للمسؤول",
    "أمين مخزن": "لأمين المخزن",
    "امين مخزن": "لأمين المخزن",
    "فني": "للفني",
    "الفني": "للفني",
    "عامل مخزن": "لعامل المخزن",
    "عامل معرض": "لعامل المعرض",
  };

  if (map[title]) {
    return map[title];
  }

  if (title.startsWith("لـ") || title.startsWith("لل")) {
    return title;
  }

  if (title.startsWith("ال")) {
    return `لل${title.slice(2)}`;
  }

  if (/^[\u0600-\u06FF\s]+$/.test(title)) {
    return `لـ ${title}`;
  }

  return `لـ (${title})`;
}

/* ==========================================================================
   1. EMPLOYEES MANAGEMENT (PER BRANCH)
   ========================================================================== */

/**
 * GET /payroll/employees?branch_id=1
 */
async function getEmployees(req, res) {
  try {
    const branchId = Number(req.query.branch_id) || 1;
    const status = req.query.status || "all";

    let query = `
      SELECT 
        e.*,
        COALESCE(SUM(a.amount) FILTER (WHERE a.status = 'pending'), 0)::numeric AS pending_advances
      FROM payroll_employees e
      LEFT JOIN payroll_advances a ON a.employee_id = e.id
      WHERE e.branch_id = $1
    `;
    const params = [branchId];

    if (status !== "all") {
      params.push(status);
      query += ` AND e.status = $2`;
    }

    query += ` GROUP BY e.id ORDER BY e.id ASC`;

    const result = await pool.query(query, params);
    res.json({ success: true, employees: result.rows });
  } catch (err) {
    console.error("getEmployees error:", err);
    res.status(500).json({ error: "فشل في جلب بيانات العمال", details: err.message });
  }
}

/**
 * POST /payroll/employees
 */
async function createEmployee(req, res) {
  try {
    const {
      branch_id,
      name,
      phone,
      national_id,
      job_title,
      salary_type = "weekly",
      base_salary = 0,
      hire_date,
      notes,
    } = req.body;

    if (!branch_id || !name || !String(name).trim()) {
      return res.status(400).json({ error: "اسم العامل والفرع مطلوبان" });
    }

    const safeBranchId = Number(branch_id);
    const safeSalary = Math.max(0, Number(base_salary) || 0);
    const safeSalaryType = ["weekly", "monthly", "daily"].includes(salary_type)
      ? salary_type
      : "weekly";

    const result = await pool.query(
      `
      INSERT INTO payroll_employees 
        (branch_id, name, phone, national_id, job_title, salary_type, base_salary, hire_date, notes, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::date, CURRENT_DATE), $9, 'active')
      RETURNING *
      `,
      [
        safeBranchId,
        String(name).trim(),
        phone || null,
        national_id || null,
        job_title || null,
        safeSalaryType,
        safeSalary,
        hire_date || null,
        notes || null,
      ],
    );

    res.json({ success: true, employee: result.rows[0] });
  } catch (err) {
    console.error("createEmployee error:", err);
    res.status(500).json({ error: "فشل في إضافة العامل", details: err.message });
  }
}

/**
 * PUT /payroll/employees/:id
 */
async function updateEmployee(req, res) {
  try {
    const empId = Number(req.params.id);
    const {
      branch_id,
      name,
      phone,
      national_id,
      job_title,
      salary_type,
      base_salary,
      status,
      hire_date,
      notes,
    } = req.body;

    if (!empId) {
      return res.status(400).json({ error: "معرف العامل غير صحيح" });
    }

    const result = await pool.query(
      `
      UPDATE payroll_employees
      SET 
        branch_id = COALESCE($1, branch_id),
        name = COALESCE($2, name),
        phone = COALESCE($3, phone),
        national_id = COALESCE($4, national_id),
        job_title = COALESCE($5, job_title),
        salary_type = COALESCE($6, salary_type),
        base_salary = COALESCE($7, base_salary),
        status = COALESCE($8, status),
        hire_date = COALESCE($9::date, hire_date),
        notes = COALESCE($10, notes),
        updated_at = NOW()
      WHERE id = $11
      RETURNING *
      `,
      [
        branch_id ? Number(branch_id) : null,
        name ? String(name).trim() : null,
        phone !== undefined ? phone : null,
        national_id !== undefined ? national_id : null,
        job_title !== undefined ? job_title : null,
        salary_type || null,
        base_salary !== undefined ? Math.max(0, Number(base_salary)) : null,
        status || null,
        hire_date || null,
        notes !== undefined ? notes : null,
        empId,
      ],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "العامل غير موجود" });
    }

    res.json({ success: true, employee: result.rows[0] });
  } catch (err) {
    console.error("updateEmployee error:", err);
    res.status(500).json({ error: "فشل في تعديل بيانات العامل", details: err.message });
  }
}

/* ==========================================================================
   2. ADVANCES MANAGEMENT (السُلف والمسحوبات)
   ========================================================================== */

/**
 * GET /payroll/advances?branch_id=1&status=pending
 */
async function getAdvances(req, res) {
  try {
    const branchId = Number(req.query.branch_id) || 1;
    const status = req.query.status || "all";
    const employeeId = req.query.employee_id ? Number(req.query.employee_id) : null;

    let query = `
      SELECT 
        a.*,
        e.name AS employee_name,
        e.job_title,
        e.salary_type
      FROM payroll_advances a
      JOIN payroll_employees e ON e.id = a.employee_id
      WHERE a.branch_id = $1
    `;
    const params = [branchId];
    let idx = 2;

    if (status !== "all") {
      query += ` AND a.status = $${idx++}`;
      params.push(status);
    }

    if (employeeId) {
      query += ` AND a.employee_id = $${idx++}`;
      params.push(employeeId);
    }

    query += ` ORDER BY a.advance_date DESC, a.id DESC`;

    const result = await pool.query(query, params);
    res.json({ success: true, advances: result.rows });
  } catch (err) {
    console.error("getAdvances error:", err);
    res.status(500).json({ error: "فشل في جلب السلف", details: err.message });
  }
}

/**
 * POST /payroll/advances
 * Records an advance and optionally inserts cash_out into treasury
 */
async function createAdvance(req, res) {
  const client = await pool.connect();
  try {
    const {
      branch_id,
      employee_id,
      amount,
      advance_date,
      notes,
      record_cash_out = true,
    } = req.body;

    if (!branch_id || !employee_id || !amount || Number(amount) <= 0) {
      return res.status(400).json({ error: "بيانات السلفة غير مكتملة (المبلغ مطلوب ويجب أن يكون أكبر من الصفر)" });
    }

    const safeBranchId = Number(branch_id);
    const safeEmpId = Number(employee_id);
    const safeAmount = Number(amount);
    const safeDate = advance_date || new Date().toISOString().slice(0, 10);
    const user = req.user || {};

    await client.query("BEGIN");

    // 1. Verify employee exists and belongs to branch
    const empRes = await client.query(
      "SELECT id, name, branch_id FROM payroll_employees WHERE id = $1 AND branch_id = $2",
      [safeEmpId, safeBranchId],
    );
    if (empRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "العامل غير موجود في هذا الفرع" });
    }
    const emp = empRes.rows[0];

    // 2. Optionally insert into cash_out if paid out of branch treasury
    let cashOutId = null;
    let permissionNumber = null;
    if (record_cash_out) {
      permissionNumber = generatePermissionNumber(safeDate);
      const rolePrefix = formatJobTitleWithPrefix(emp.job_title);
      const cashOutRes = await client.query(
        `
        INSERT INTO cash_out 
          (branch_id, name, amount, notes, transaction_date, permission_number, entry_type)
        VALUES ($1, $2, $3, $4, $5, $6, 'expense')
        RETURNING id
        `,
        [
          safeBranchId,
          `سلفة مرتب: ${emp.name}`,
          safeAmount,
          `سلفة نقدية ${rolePrefix}: ${emp.name}${notes ? ` - ${notes}` : ""}`,
          safeDate,
          permissionNumber,
        ],
      );
      cashOutId = cashOutRes.rows[0].id;
    }

    // 3. Insert into payroll_advances
    const advRes = await client.query(
      `
      INSERT INTO payroll_advances 
        (branch_id, employee_id, amount, advance_date, status, cash_out_id, notes, created_by, created_by_name)
      VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8)
      RETURNING *
      `,
      [
        safeBranchId,
        safeEmpId,
        safeAmount,
        safeDate,
        cashOutId,
        notes || null,
        user.id || null,
        user.full_name || user.username || "الإدارة",
      ],
    );

    await client.query("COMMIT");

    // Real-time broadcast notification
    const broadcast = req.app?.get("broadcastRealtime");
    if (typeof broadcast === "function") {
      broadcast("data:payroll", { action: "advance_created", branch_id: safeBranchId, ts: Date.now() });
      if (record_cash_out) {
        broadcast("data:cash", { action: "cash_out_created", branch_id: safeBranchId, ts: Date.now() });
      }
    }

    res.json({
      success: true,
      advance: advRes.rows[0],
      cash_out_id: cashOutId,
      permission_number: permissionNumber,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("createAdvance error:", err);
    res.status(500).json({ error: "فشل في تسجيل السلفة", details: err.message });
  } finally {
    client.release();
  }
}

/**
 * DELETE /payroll/advances/:id
 */
async function deleteAdvance(req, res) {
  const client = await pool.connect();
  try {
    const advId = Number(req.params.id);
    const { delete_linked_cash_out = true } = req.body;

    await client.query("BEGIN");

    const advRes = await client.query("SELECT * FROM payroll_advances WHERE id = $1 FOR UPDATE", [advId]);
    if (advRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "السلفة غير موجودة" });
    }

    const adv = advRes.rows[0];
    if (adv.status === "deducted") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "لا يمكن حذف سلفة تم خصمها بالفعل في مسير قبض معتمد" });
    }

    // Delete linked cash_out row if requested
    if (delete_linked_cash_out && adv.cash_out_id) {
      await client.query("DELETE FROM cash_out WHERE id = $1", [adv.cash_out_id]);
    }

    await client.query("DELETE FROM payroll_advances WHERE id = $1", [advId]);
    await client.query("COMMIT");

    const broadcast = req.app?.get("broadcastRealtime");
    if (typeof broadcast === "function") {
      broadcast("data:payroll", { action: "advance_deleted", branch_id: adv.branch_id, ts: Date.now() });
      if (adv.cash_out_id) {
        broadcast("data:cash", { action: "cash_out_deleted", branch_id: adv.branch_id, ts: Date.now() });
      }
    }

    res.json({ success: true, message: "تم حذف السلفة بنجاح" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("deleteAdvance error:", err);
    res.status(500).json({ error: "فشل في حذف السلفة", details: err.message });
  } finally {
    client.release();
  }
}

/* ==========================================================================
   2.b PAYROLL ADJUSTMENTS (الحوافز، المكافآت، الخصومات، وساعات الإضافي)
   ========================================================================== */

/**
 * GET /payroll/adjustments?branch_id=1&employee_id=...&status=pending
 */
async function getAdjustments(req, res) {
  try {
    const branchId = Number(req.query.branch_id || req.user?.branch_id || 1);
    const employeeId = req.query.employee_id ? Number(req.query.employee_id) : null;
    const status = req.query.status || "pending";
    const periodStart = req.query.period_start;
    const periodEnd = req.query.period_end;

    let whereAdj = "pa.branch_id = $1";
    let whereRet = "rd.branch_id = $1";
    const params = [branchId];

    if (employeeId) {
      params.push(employeeId);
      whereAdj += ` AND pa.employee_id = $${params.length}`;
      whereRet += ` AND rd.employee_id = $${params.length}`;
    }

    if (status !== "all") {
      params.push(status);
      whereAdj += ` AND pa.status = $${params.length}`;
      whereRet += ` AND rd.status = $${params.length}`;
    }

    if (periodStart && periodEnd) {
      params.push(periodStart, periodEnd);
      whereAdj += ` AND pa.adjustment_date >= $${params.length - 1} AND pa.adjustment_date <= $${params.length}`;
      whereRet += ` AND rd.due_date >= $${params.length - 1} AND rd.due_date <= $${params.length}`;
    }

    const query = `
      SELECT 
        pa.id, pa.branch_id, pa.employee_id, pa.type, pa.amount, pa.adjustment_date,
        pa.reason, pa.status, pa.payroll_record_id, pa.created_by, pa.created_by_name, pa.created_at,
        pe.name as employee_name, pe.job_title, pe.salary_type
      FROM payroll_adjustments pa
      JOIN payroll_employees pe ON pa.employee_id = pe.id
      WHERE ${whereAdj}
      UNION ALL
      SELECT 
        rd.id, rd.branch_id, rd.employee_id, 'retained_dues' as type, rd.amount, rd.due_date as adjustment_date,
        rd.reason, rd.status, rd.payroll_record_id, rd.created_by, rd.created_by_name, rd.created_at,
        pe.name as employee_name, pe.job_title, pe.salary_type
      FROM payroll_retained_dues rd
      JOIN payroll_employees pe ON rd.employee_id = pe.id
      WHERE ${whereRet}
      ORDER BY adjustment_date DESC, id DESC
    `;

    const result = await pool.query(query, params);
    res.json({ success: true, adjustments: result.rows });
  } catch (err) {
    console.error("getAdjustments error:", err);
    res.status(500).json({ error: "فشل في جلب سجل التسويات والحوافز", details: err.message });
  }
}

/**
 * POST /payroll/adjustments
 */
async function createAdjustment(req, res) {
  try {
    const {
      branch_id,
      employee_id,
      type, // 'bonus' | 'deduction' | 'overtime'
      amount,
      adjustment_date,
      reason,
    } = req.body;

    const safeBranchId = Number(branch_id || req.user?.branch_id || 1);
    const empId = Number(employee_id);
    const numAmount = Number(amount);
    const safeDate = adjustment_date ? String(adjustment_date).slice(0, 10) : new Date().toISOString().slice(0, 10);
    const cleanReason = reason ? String(reason).trim() : null;

    if (!empId || isNaN(numAmount) || numAmount <= 0) {
      return res.status(400).json({ error: "يرجى تحديد العامل والمبلغ بشكل صحيح (أكبر من صفر)" });
    }

    if (!["bonus", "deduction", "overtime", "retained_dues"].includes(type)) {
      return res.status(400).json({ error: "نوع الحركة غير صالح (يجب أن يكون حافز أو خصم أو إضافي أو مستحق مرحل)" });
    }

    // Branch authorization check
    const currentUser = req.user;
    if (currentUser && currentUser.role !== "admin" && Number(currentUser.id) !== 7) {
      if (Number(currentUser.branch_id) !== safeBranchId) {
        return res.status(403).json({ error: "غير مصرح لك بتسجيل حركة لفرع آخر" });
      }
    }

    // Verify employee exists and is active
    const empCheck = await pool.query(
      "SELECT id, name, branch_id FROM payroll_employees WHERE id = $1 AND branch_id = $2",
      [empId, safeBranchId],
    );
    if (empCheck.rows.length === 0) {
      return res.status(404).json({ error: "العامل غير موجود في هذا الفرع" });
    }

    // Check if employee has an already paid record covering this date
    const paidCheck = await pool.query(
      `
      SELECT pr.id, pr.period_start, pr.period_end
      FROM payroll_records pr
      LEFT JOIN cash_out co ON pr.cash_out_id = co.id
      WHERE pr.branch_id = $1 AND pr.employee_id = $2 AND pr.payment_status = 'paid'
        AND (pr.cash_out_id IS NULL OR co.id IS NOT NULL)
        AND pr.period_start <= $3 AND pr.period_end >= $3
      LIMIT 1
      `,
      [safeBranchId, empId, safeDate],
    );
    if (paidCheck.rows.length > 0) {
      return res.status(400).json({
        error: `تم صرف مسير راتب هذا العامل بالفعل للفترة التي تشمل تاريخ ${safeDate}. لحفظ حركات جديدة، يجب إلغاء إذن الصرف من الخزينة أولاً.`,
      });
    }

    const createdBy = currentUser?.id || null;
    const createdByName = currentUser?.name || currentUser?.full_name || currentUser?.username || "الإدارة";

    let insertRes;
    if (type === "retained_dues") {
      insertRes = await pool.query(
        `
        INSERT INTO payroll_retained_dues 
          (branch_id, employee_id, amount, due_date, reason, status, created_by, created_by_name)
        VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)
        RETURNING id, branch_id, employee_id, 'retained_dues' as type, amount, due_date as adjustment_date, reason, status, created_by, created_by_name, created_at
        `,
        [safeBranchId, empId, numAmount, safeDate, cleanReason, createdBy, createdByName],
      );
    } else {
      insertRes = await pool.query(
        `
        INSERT INTO payroll_adjustments 
          (branch_id, employee_id, type, amount, adjustment_date, reason, status, created_by, created_by_name)
        VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)
        RETURNING *
        `,
        [safeBranchId, empId, type, numAmount, safeDate, cleanReason, createdBy, createdByName],
      );
    }

    const adjustment = insertRes.rows[0];

    const broadcast = req.app?.get("broadcastRealtime");
    if (typeof broadcast === "function") {
      broadcast("data:payroll", { action: "adjustment_created", branch_id: safeBranchId, ts: Date.now() });
    }

    res.json({
      success: true,
      message: "تم تسجيل الحركة بنجاح",
      adjustment,
    });
  } catch (err) {
    console.error("createAdjustment error:", err);
    res.status(500).json({ error: "فشل في تسجيل الحركة", details: err.message });
  }
}

/**
 * DELETE /payroll/adjustments/:id
 */
async function deleteAdjustment(req, res) {
  try {
    const adjId = Number(req.params.id);
    const currentUser = req.user;

    let findRes = await pool.query("SELECT * FROM payroll_adjustments WHERE id = $1", [adjId]);
    let isRetained = false;
    if (findRes.rows.length === 0) {
      findRes = await pool.query("SELECT * FROM payroll_retained_dues WHERE id = $1", [adjId]);
      isRetained = true;
    }
    if (findRes.rows.length === 0) {
      return res.status(404).json({ error: "الحركة غير موجودة" });
    }

    const adj = findRes.rows[0];

    if (adj.status !== "pending") {
      return res.status(400).json({ error: "لا يمكن حذف حركة تم اعتمادها وصرفها بالمسير" });
    }

    // Branch authorization check
    if (currentUser && currentUser.role !== "admin" && Number(currentUser.id) !== 7) {
      if (Number(currentUser.branch_id) !== adj.branch_id) {
        return res.status(403).json({ error: "غير مصرح لك بحذف حركة في فرع آخر" });
      }
    }

    if (isRetained) {
      await pool.query("DELETE FROM payroll_retained_dues WHERE id = $1", [adjId]);
    } else {
      await pool.query("DELETE FROM payroll_adjustments WHERE id = $1", [adjId]);
    }

    const broadcast = req.app?.get("broadcastRealtime");
    if (typeof broadcast === "function") {
      broadcast("data:payroll", { action: "adjustment_deleted", branch_id: adj.branch_id, ts: Date.now() });
    }

    res.json({ success: true, message: "تم حذف الحركة بنجاح" });
  } catch (err) {
    console.error("deleteAdjustment error:", err);
    res.status(500).json({ error: "فشل في حذف الحركة", details: err.message });
  }
}

/* ==========================================================================
   3. PAYROLL SHEET CALCULATION & PAYOUT (مسير الرواتب وصرف الأسبوعيات والشهريات)
   ========================================================================== */

/**
 * Helper to get current Date object in Cairo timezone (Africa/Cairo)
 */
function getCairoNow() {
  const str = new Date().toLocaleString("en-US", { timeZone: "Africa/Cairo" });
  return new Date(str);
}

/**
 * Checks if current date in Cairo allows paying the current cycle salary.
 * - Weekly: Unlocked on Thursday (day === 4) OR retroactive (todayStr > periodEnd).
 * - Monthly: Unlocked on the last day of the month OR retroactive (todayStr > periodEnd).
 * Returns { isPayrollDay: boolean, isRetroactive: boolean, todayStr: string, reason: string }
 */
function checkIsPayrollDay(cycleType, periodEnd) {
  const cairoNow = getCairoNow();
  const year = cairoNow.getFullYear();
  const month = String(cairoNow.getMonth() + 1).padStart(2, "0");
  const day = String(cairoNow.getDate()).padStart(2, "0");
  const todayStr = `${year}-${month}-${day}`;

  const cleanEnd = String(periodEnd || "").slice(0, 10);

  // If this is a historical period (ended before today), it is retroactive and always unlocked!
  if (cleanEnd && cleanEnd < todayStr) {
    return { isPayrollDay: true, isRetroactive: true, todayStr, reason: "فترة سابقة منتهية (أثر رجعي)" };
  }

  const normCycle = String(cycleType || "weekly").toLowerCase();

  if (normCycle === "weekly" || normCycle === "daily") {
    // Thursday is day 4 (Sunday=0, Monday=1, Tuesday=2, Wednesday=3, Thursday=4, Friday=5, Saturday=6)
    const dayOfWeek = cairoNow.getDay();
    const isThu = dayOfWeek === 4;
    return {
      isPayrollDay: isThu,
      isRetroactive: false,
      todayStr,
      reason: isThu
        ? "اليوم الخميس (موعد الصرف الأسبوعي الرسمي)"
        : "صرف راتب الأسبوع الحالي متاح يوم الخميس فقط (أو للفترات المنتهية سابقاً).",
    };
  }

  if (normCycle === "monthly") {
    const curYear = cairoNow.getFullYear();
    const curMonth = cairoNow.getMonth(); // 0-indexed
    const lastDayOfMonth = new Date(curYear, curMonth + 1, 0).getDate();
    const curDay = cairoNow.getDate();
    const isLast = curDay >= lastDayOfMonth;
    return {
      isPayrollDay: isLast,
      isRetroactive: false,
      todayStr,
      reason: isLast
        ? "اليوم الأخير من الشهر (موعد الصرف الشهري الرسمي)"
        : "صرف راتب الشهر الحالي متاح في اليوم الأخير من الشهر فقط (أو للفترات المنتهية سابقاً).",
    };
  }

  return { isPayrollDay: true, isRetroactive: false, todayStr, reason: "" };
}

/**
 * GET /payroll/sheet?branch_id=1&cycle_type=weekly&period_start=YYYY-MM-DD&period_end=YYYY-MM-DD
 * Calculates proposed payout sheet with un-deducted advances
 */
async function getPayrollSheet(req, res) {
  try {
    const branchId = Number(req.query.branch_id) || 1;
    const rawCycle = String(req.query.cycle_type || "all").toLowerCase();
    const periodStart = req.query.period_start || new Date().toISOString().slice(0, 10);
    const periodEnd = req.query.period_end || new Date().toISOString().slice(0, 10);

    let cycleClause = "";
    const params = [branchId];

    if (rawCycle === "weekly") {
      params.push("weekly");
      cycleClause = "AND (salary_type = $2 OR salary_type = 'daily')";
    } else if (rawCycle === "monthly") {
      params.push("monthly");
      cycleClause = "AND salary_type = $2";
    }

    // 1. Fetch active employees of this branch (sorted: weekly -> daily -> monthly)
    const empRes = await pool.query(
      `
      SELECT id, name, phone, job_title, salary_type, base_salary, status
      FROM payroll_employees
      WHERE branch_id = $1 AND status = 'active' ${cycleClause}
      ORDER BY 
        CASE 
          WHEN salary_type = 'weekly' THEN 1 
          WHEN salary_type = 'daily' THEN 2 
          ELSE 3 
        END ASC, 
        id ASC
      `,
      params,
    );

    const employees = empRes.rows;
    if (employees.length === 0) {
      return res.json({ success: true, rows: [] });
    }

    const empIds = employees.map((e) => e.id);

    // 2. Fetch pending advances up to period_end for these employees
    const advRes = await pool.query(
      `
      SELECT id, employee_id, amount, advance_date, notes
      FROM payroll_advances
      WHERE employee_id = ANY($1) AND status = 'pending' AND advance_date <= $2
      ORDER BY advance_date ASC
      `,
      [empIds, periodEnd],
    );

    // Group advances by employee
    const advancesByEmp = {};
    for (const adv of advRes.rows) {
      if (!advancesByEmp[adv.employee_id]) advancesByEmp[adv.employee_id] = [];
      advancesByEmp[adv.employee_id].push(adv);
    }

    // 2.b Fetch pending adjustments (bonuses, overtime, deductions, retained dues) up to periodEnd
    const adjRes = await pool.query(
      `
      SELECT id, branch_id, employee_id, type, amount, adjustment_date, reason, status, created_by_name, created_at
      FROM payroll_adjustments
      WHERE branch_id = $1 AND employee_id = ANY($2) AND status = 'pending' AND adjustment_date <= $3
      UNION ALL
      SELECT id, branch_id, employee_id, 'retained_dues' as type, amount, due_date as adjustment_date, reason, status, created_by_name, created_at
      FROM payroll_retained_dues
      WHERE branch_id = $1 AND employee_id = ANY($2) AND status = 'pending' AND due_date <= $3
      ORDER BY adjustment_date ASC, id ASC
      `,
      [branchId, empIds, periodEnd],
    );

    const adjustmentsByEmp = {};
    for (const adj of adjRes.rows) {
      if (!adjustmentsByEmp[adj.employee_id]) adjustmentsByEmp[adj.employee_id] = [];
      adjustmentsByEmp[adj.employee_id].push(adj);
    }

    // 3. Fetch paid records for these employees in this period window
    // (Only records whose linked cash_out still exists in the treasury, or cash_out_id is NULL)
    const paidRes = await pool.query(
      `
      SELECT 
        pr.id, pr.employee_id, pr.cycle_type, pr.period_start, pr.period_end, 
        pr.base_amount, pr.days_worked, pr.overtime_amount, pr.bonus_amount, pr.deductions_amount,
        pr.advances_deducted, pr.net_amount, co.permission_number, pr.payment_status, 
        pr.paid_at, pr.paid_by_name, pr.cash_out_id, pr.notes
      FROM payroll_records pr
      LEFT JOIN cash_out co ON pr.cash_out_id = co.id
      WHERE pr.branch_id = $1
        AND pr.employee_id = ANY($2)
        AND pr.payment_status = 'paid'
        AND pr.cycle_type != 'arrears'
        AND (pr.cash_out_id IS NULL OR co.id IS NOT NULL)
        AND (
          (pr.period_start = $3 AND pr.period_end = $4)
          OR (pr.period_end >= $3 AND pr.period_start <= $4)
        )
      ORDER BY pr.paid_at DESC
      `,
      [branchId, empIds, periodStart, periodEnd],
    );

    const paidByEmp = {};
    for (const rec of paidRes.rows) {
      if (!paidByEmp[rec.employee_id]) {
        paidByEmp[rec.employee_id] = rec;
      }
    }

    // Fetch applied adjustments for paid records if any
    const paidRecordIds = paidRes.rows.map((r) => r.id);
    const appliedAdjustmentsByEmp = {};
    if (paidRecordIds.length > 0) {
      const appliedAdjRes = await pool.query(
        `
        SELECT id, branch_id, employee_id, type, amount, adjustment_date, reason, status, created_by_name, created_at
        FROM payroll_adjustments
        WHERE branch_id = $1 AND payroll_record_id = ANY($2)
        UNION ALL
        SELECT id, branch_id, employee_id, 'retained_dues' as type, amount, due_date as adjustment_date, reason, status, created_by_name, created_at
        FROM payroll_retained_dues
        WHERE branch_id = $1 AND payroll_record_id = ANY($2)
        ORDER BY adjustment_date ASC, id ASC
        `,
        [branchId, paidRecordIds],
      );
      for (const adj of appliedAdjRes.rows) {
        if (!appliedAdjustmentsByEmp[adj.employee_id]) appliedAdjustmentsByEmp[adj.employee_id] = [];
        appliedAdjustmentsByEmp[adj.employee_id].push(adj);
      }
    }

    // 3.b Fetch attendance records for these employees within the period window
    const attendanceByEmp = {};
    try {
      const attRes = await pool.query(
        `
        SELECT id, branch_id, employee_id, attendance_date, status, day_rate, adjustment_id, notes
        FROM payroll_attendance
        WHERE branch_id = $1 AND employee_id = ANY($2) AND attendance_date >= $3 AND attendance_date <= $4
        ORDER BY attendance_date ASC
        `,
        [branchId, empIds, periodStart, periodEnd],
      );
      for (const att of attRes.rows) {
        if (!attendanceByEmp[att.employee_id]) attendanceByEmp[att.employee_id] = [];
        const dateStr = att.attendance_date instanceof Date
          ? att.attendance_date.toISOString().slice(0, 10)
          : String(att.attendance_date).slice(0, 10);
        attendanceByEmp[att.employee_id].push({
          id: att.id,
          date: dateStr,
          status: att.status,
          day_rate: Number(att.day_rate || 0),
          adjustment_id: att.adjustment_id,
          notes: att.notes,
        });
      }
    } catch (attErr) {
      console.warn("payroll_attendance query note:", attErr.message);
    }

    // 3.c Fetch latest paid period_end for each employee (to determine boundaries of un-settled prior cycles)
    const latestPaidRes = await pool.query(
      `
      SELECT employee_id, MAX(period_end) as last_period_end
      FROM payroll_records
      WHERE branch_id = $1 AND employee_id = ANY($2) AND payment_status = 'paid' AND cycle_type != 'arrears'
      GROUP BY employee_id
      `,
      [branchId, empIds],
    );
    const lastPaidEndByEmp = {};
    for (const r of latestPaidRes.rows) {
      if (r.last_period_end) {
        lastPaidEndByEmp[r.employee_id] = r.last_period_end instanceof Date
          ? r.last_period_end.toISOString().slice(0, 10)
          : String(r.last_period_end).slice(0, 10);
      }
    }

    // 4. Build sheet rows
    const sheetRows = employees.map((emp) => {
      const empAdvances = advancesByEmp[emp.id] || [];
      const baseSalary = Number(emp.base_salary || 0);

      const paidRecord = paidByEmp[emp.id];
      const isPaid = Boolean(paidRecord);

      // Attendance data for this employee
      const empAttendance = attendanceByEmp[emp.id] || [];
      const absentDaysCount = empAttendance.filter((a) => a.status === "absent").length;
      const dailyRate = emp.salary_type === "weekly"
        ? Math.round((baseSalary / 6.0) * 100) / 100
        : (emp.salary_type === "monthly" ? Math.round((baseSalary / 30.0) * 100) / 100 : baseSalary);
      const calculatedDaysWorked = emp.salary_type === "weekly" || emp.salary_type === "daily"
        ? Math.max(0, 6 - absentDaysCount)
        : (emp.salary_type === "monthly" ? Math.max(0, 30 - absentDaysCount) : 0);

      // Adjustments list & calculated sums
      const empPendingAdjustments = adjustmentsByEmp[emp.id] || [];
      const empAppliedAdjustments = appliedAdjustmentsByEmp[emp.id] || [];
      const empAdjustmentsList = isPaid ? empAppliedAdjustments : empPendingAdjustments;

      const sumBonus = empAdjustmentsList
        .filter((a) => a.type === "bonus")
        .reduce((s, a) => s + Number(a.amount || 0), 0);
      const sumOvertime = empAdjustmentsList
        .filter((a) => a.type === "overtime")
        .reduce((s, a) => s + Number(a.amount || 0), 0);
      const sumDeductions = empAdjustmentsList
        .filter((a) => a.type === "deduction")
        .reduce((s, a) => s + Number(a.amount || 0), 0);
      const sumRetainedDues = empAdjustmentsList
        .filter((a) => a.type === "retained_dues")
        .reduce((s, a) => s + Number(a.amount || 0), 0);

      const overtimeAmount = isPaid ? Number(paidRecord.overtime_amount || 0) : sumOvertime;
      const bonusAmount = isPaid ? Number(paidRecord.bonus_amount || 0) : sumBonus;
      const deductionsAmount = isPaid ? Number(paidRecord.deductions_amount || 0) : sumDeductions;

      // Separate prior advances (before periodStart) vs current period advances (within period window)
      const priorAdvances = [];
      const currentAdvances = [];
      for (const adv of empAdvances) {
        const advDateStr = adv.advance_date instanceof Date
          ? adv.advance_date.toISOString().slice(0, 10)
          : String(adv.advance_date || "").slice(0, 10);
        if (advDateStr < periodStart) {
          priorAdvances.push(adv);
        } else {
          currentAdvances.push(adv);
        }
      }

      // Calculate unclosed prior cycles between lastPaidPeriodEnd and periodStart
      let priorExcessAdvances = 0;
      let priorUnpaidDues = 0;

      if (!isPaid && priorAdvances.length > 0) {
        const lastPaidEnd = lastPaidEndByEmp[emp.id] || (
          emp.hire_date
            ? (emp.hire_date instanceof Date ? emp.hire_date.toISOString().slice(0, 10) : String(emp.hire_date).slice(0, 10))
            : null
        );

        let unclosedCyclesCount = 1;
        if (lastPaidEnd) {
          const startMs = new Date(periodStart + "T12:00:00").getTime();
          const endMs = new Date(lastPaidEnd + "T12:00:00").getTime();
          const diffDays = Math.max(0, Math.round((startMs - endMs) / (1000 * 60 * 60 * 24)));
          if (emp.salary_type === "weekly" || emp.salary_type === "daily") {
            unclosedCyclesCount = Math.max(1, Math.floor(diffDays / 7));
          } else if (emp.salary_type === "monthly") {
            unclosedCyclesCount = Math.max(1, Math.floor(diffDays / 30));
          }
        }

        const priorEarnedSalary = unclosedCyclesCount * baseSalary;
        const totalPriorAdvances = priorAdvances.reduce((s, a) => s + Number(a.amount || 0), 0);

        if (totalPriorAdvances > priorEarnedSalary) {
          priorExcessAdvances = Math.round((totalPriorAdvances - priorEarnedSalary) * 100) / 100;
        } else {
          // Exactly as user requested: if covered by prior unclosed work, carried forward advance is 0!
          priorExcessAdvances = 0;
          priorUnpaidDues = Math.round((priorEarnedSalary - totalPriorAdvances) * 100) / 100;
        }
      }

      const currentAdvancesTotal = currentAdvances.reduce((sum, a) => sum + Number(a.amount || 0), 0);
      const effectivePendingAdvances = isPaid
        ? Number(paidRecord.advances_deducted || 0)
        : Math.round((currentAdvancesTotal + priorExcessAdvances) * 100) / 100;

      const grossEarnings = Math.max(
        0,
        Math.round((baseSalary + overtimeAmount + bonusAmount - deductionsAmount) * 100) / 100,
      );
      const excessAdvances = isPaid
        ? 0
        : Math.max(0, Math.round((effectivePendingAdvances - grossEarnings) * 100) / 100);

      const currentPeriodNet = isPaid
        ? Number(paidRecord.net_amount || 0)
        : Math.max(0, Math.round((grossEarnings - effectivePendingAdvances) * 100) / 100);

      const carriedOverDues = isPaid ? 0 : Math.round((sumRetainedDues + priorUnpaidDues) * 100) / 100;
      const totalPayableNet = isPaid
        ? Number(paidRecord.net_amount || 0)
        : Math.round((currentPeriodNet + carriedOverDues) * 100) / 100;

      const dayCheck = checkIsPayrollDay(emp.salary_type, periodEnd);

      return {
        employee_id: emp.id,
        name: emp.name,
        job_title: emp.job_title,
        salary_type: emp.salary_type,
        base_salary: isPaid ? Number(paidRecord.base_amount || baseSalary) : baseSalary,
        daily_rate: dailyRate,
        days_worked: isPaid ? Number(paidRecord.days_worked || calculatedDaysWorked) : calculatedDaysWorked,
        absent_days_count: absentDaysCount,
        attendance_list: empAttendance,
        overtime_amount: overtimeAmount,
        bonus_amount: bonusAmount,
        deductions_amount: deductionsAmount,
        pending_advances: effectivePendingAdvances,
        excess_advances: excessAdvances,
        advances_list: isPaid ? [] : (priorExcessAdvances > 0 ? empAdvances : currentAdvances),
        all_pending_advance_ids: isPaid ? [] : empAdvances.map((a) => a.id),
        adjustments_list: empAdjustmentsList,
        carried_over_dues: carriedOverDues,
        current_net: currentPeriodNet,
        net_amount: isPaid ? currentPeriodNet : totalPayableNet,
        is_payroll_day: dayCheck.isPayrollDay,
        can_pay_current: dayCheck.isPayrollDay,
        can_pay_arrears: carriedOverDues > 0,
        lock_reason: dayCheck.isPayrollDay ? "" : dayCheck.reason,
        notes: isPaid ? (paidRecord.notes || "") : "",
        is_paid: isPaid,
        payout_info: isPaid
          ? {
              record_id: paidRecord.id,
              paid_at: paidRecord.paid_at,
              paid_by_name: paidRecord.paid_by_name,
              net_amount: currentPeriodNet,
              cash_out_id: paidRecord.cash_out_id,
              permission_number: paidRecord.permission_number,
              cycle_type: paidRecord.cycle_type,
              period_start: paidRecord.period_start,
              period_end: paidRecord.period_end,
              base_amount: Number(paidRecord.base_amount || baseSalary),
              days_worked: Number(paidRecord.days_worked || 0),
              overtime_amount: overtimeAmount,
              bonus_amount: bonusAmount,
              deductions_amount: deductionsAmount,
              advances_deducted: Number(paidRecord.advances_deducted || 0),
              notes: paidRecord.notes || "",
            }
          : null,
      };
    });

    const serverCheck = checkIsPayrollDay(rawCycle, periodEnd);

    res.json({
      success: true,
      branch_id: branchId,
      cycle_type: rawCycle,
      period_start: periodStart,
      period_end: periodEnd,
      server_today: serverCheck.todayStr,
      is_payroll_day: serverCheck.isPayrollDay,
      lock_reason: serverCheck.isPayrollDay ? "" : serverCheck.reason,
      rows: sheetRows,
    });
  } catch (err) {
    console.error("getPayrollSheet error:", err);
    res.status(500).json({ error: "فشل في احتساب شيت القبض", details: err.message });
  }
}

/**
 * POST /payroll/payout
 * Confirms and executes payout for a single employee or batch of employees:
 * - Records in payroll_records
 * - Marks linked advances as deducted
 * - Inserts cash_out record into the branch treasury
 */
async function confirmPayrollPayout(req, res) {
  const client = await pool.connect();
  try {
    const {
      branch_id,
      items, // array of payout records
      cycle_type = "weekly",
      period_start,
      period_end,
      record_cash_out = true,
      payout_scope = "full", // 'full' | 'arrears_only' | 'current_only' | 'carry_forward'
    } = req.body;

    if (!branch_id || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "بيانات الصرف غير مكتملة أو الشيت فارغ" });
    }

    const safeBranchId = Number(branch_id);
    const safeStart = period_start || new Date().toISOString().slice(0, 10);
    const safeEnd = period_end || new Date().toISOString().slice(0, 10);
    const user = req.user || {};
    const paidByName = user.full_name || user.username || "الإدارة";

    await client.query("BEGIN");

    const createdRecords = [];
    let totalCashPaidOut = 0;

    for (const item of items) {
      const empId = Number(item.employee_id);
      const empScope = item.payout_scope || payout_scope || "full";
      const itemCycle = item.cycle_type || item.salary_type || cycle_type;

      // -------------------------------------------------------------
      // -------------------------------------------------------------
      // CASE 1: ARREARS ONLY (صرف المستحقات والمتأخرات السابقة فقط)
      // متاح في أي يوم من أيام الأسبوع أو الشهر!
      // -------------------------------------------------------------
      if (empScope === "arrears_only") {
        const arrearsRes = await client.query(
          `
          SELECT id, amount, reason, due_date as adjustment_date
          FROM payroll_retained_dues
          WHERE branch_id = $1 AND employee_id = $2 AND status = 'pending' AND due_date <= $3
          ORDER BY due_date ASC, id ASC
          `,
          [safeBranchId, empId, safeEnd],
        );
        const retainedAmount = arrearsRes.rows.reduce((s, r) => s + Number(r.amount || 0), 0);

        // Also check if employee has unclosed prior cycles with prior advances (priorUnpaidDues)
        const priorAdvRes = await client.query(
          `
          SELECT id, amount, advance_date
          FROM payroll_advances
          WHERE branch_id = $1 AND employee_id = $2 AND status = 'pending' AND advance_date < $3
          ORDER BY advance_date ASC, id ASC
          `,
          [safeBranchId, empId, safeStart],
        );
        const priorAdvances = priorAdvRes.rows;

        const empRes = await client.query(
          `SELECT id, name, job_title, salary_type, base_salary, hire_date FROM payroll_employees WHERE id = $1`,
          [empId],
        );
        const empInfo = empRes.rows[0];

        const latestPaidRes = await client.query(
          `
          SELECT MAX(period_end) as last_period_end
          FROM payroll_records
          WHERE branch_id = $1 AND employee_id = $2 AND payment_status = 'paid' AND cycle_type != 'arrears'
          `,
          [safeBranchId, empId],
        );
        const lastPaidEnd = latestPaidRes.rows[0]?.last_period_end ? (
          latestPaidRes.rows[0].last_period_end instanceof Date
            ? latestPaidRes.rows[0].last_period_end.toISOString().slice(0, 10)
            : String(latestPaidRes.rows[0].last_period_end).slice(0, 10)
        ) : (
          empInfo?.hire_date ? (
            empInfo.hire_date instanceof Date
              ? empInfo.hire_date.toISOString().slice(0, 10)
              : String(empInfo.hire_date).slice(0, 10)
          ) : null
        );

        let priorUnpaidDues = 0;
        let priorEarnedSalary = 0;
        let totalPriorAdvances = 0;
        let unclosedCyclesCount = 1;

        if (priorAdvances.length > 0) {
          if (lastPaidEnd) {
            const startMs = new Date(safeStart + "T12:00:00").getTime();
            const endMs = new Date(lastPaidEnd + "T12:00:00").getTime();
            const diffDays = Math.max(0, Math.round((startMs - endMs) / (1000 * 60 * 60 * 24)));
            if (empInfo?.salary_type === "weekly" || empInfo?.salary_type === "daily") {
              unclosedCyclesCount = Math.max(1, Math.floor(diffDays / 7));
            } else if (empInfo?.salary_type === "monthly") {
              unclosedCyclesCount = Math.max(1, Math.floor(diffDays / 30));
            }
          }

          const empBaseSalary = Number(empInfo?.base_salary || item.base_amount || 0);
          priorEarnedSalary = unclosedCyclesCount * empBaseSalary;
          totalPriorAdvances = priorAdvances.reduce((s, a) => s + Number(a.amount || 0), 0);

          if (totalPriorAdvances <= priorEarnedSalary) {
            priorUnpaidDues = Math.round((priorEarnedSalary - totalPriorAdvances) * 100) / 100;
          }
        }

        const arrearsAmount = Math.round((retainedAmount + priorUnpaidDues) * 100) / 100;
        if (arrearsAmount <= 0) {
          throw new Error(`لا توجد مستحقات مرحلة سابقة معلقة للصرف للعامل [${item.name || empInfo?.name || empId}].`);
        }

        const shouldRecordCashOut = item.record_cash_out !== undefined
          ? Boolean(item.record_cash_out)
          : (record_cash_out !== undefined ? Boolean(record_cash_out) : true);

        let cashOutId = null;
        let permissionNumber = null;
        if (shouldRecordCashOut && arrearsAmount > 0) {
          permissionNumber = generatePermissionNumber(safeEnd);
          const rolePrefix = formatJobTitleWithPrefix(item.job_title || empInfo?.job_title);
          const cashOutRes = await client.query(
            `
            INSERT INTO cash_out 
              (branch_id, name, amount, notes, transaction_date, permission_number, entry_type)
            VALUES ($1, $2, $3, $4, $5, $6, 'expense')
            RETURNING id
            `,
            [
              safeBranchId,
              `مستحقات مرحلة: ${item.name || empInfo?.name || "موظف"}`,
              arrearsAmount,
              item.notes || `صرف مستحقات مرحلة سابقة ${rolePrefix}: ${item.name || empInfo?.name || ""} - بقيمة ${arrearsAmount} ج.م`,
              safeEnd,
              permissionNumber,
            ],
          );
          cashOutId = cashOutRes.rows[0].id;
          totalCashPaidOut += arrearsAmount;
        }

        const notesText = item.notes
          ? String(item.notes).trim()
          : (shouldRecordCashOut
              ? `صرف مستحقات مرحلة سابقة بقيمة ${arrearsAmount} ج.م`
              : `تسوية مستحقات مرحلة سابقة بقيمة ${arrearsAmount} ج.م (تسوية داخلية دون تسجيل سند باليومية)`);

        let unclosedStartStr = safeStart;
        let unclosedEndStr = safeEnd;
        if (lastPaidEnd && priorUnpaidDues > 0) {
          const lastEndObj = new Date(lastPaidEnd + "T12:00:00");
          lastEndObj.setDate(lastEndObj.getDate() + 1);
          if (lastEndObj.getDay() === 5) lastEndObj.setDate(lastEndObj.getDate() + 1);
          unclosedStartStr = lastEndObj.toISOString().slice(0, 10);

          const curStartObj = new Date(safeStart + "T12:00:00");
          curStartObj.setDate(curStartObj.getDate() - 1);
          if (curStartObj.getDay() === 5) curStartObj.setDate(curStartObj.getDate() - 1);
          unclosedEndStr = curStartObj.toISOString().slice(0, 10);
        }

        const cycleTypeToUse = priorUnpaidDues > 0 ? (empInfo?.salary_type || itemCycle || "weekly") : "arrears";
        const recPeriodStart = priorUnpaidDues > 0 ? unclosedStartStr : safeStart;
        const recPeriodEnd = priorUnpaidDues > 0 ? unclosedEndStr : safeEnd;

        // Insert into payroll_records
        const recordRes = await client.query(
          `
          INSERT INTO payroll_records 
            (branch_id, employee_id, cycle_type, period_start, period_end, base_amount, days_worked,
             overtime_amount, bonus_amount, deductions_amount, advances_deducted, net_amount,
             cash_out_id, payment_status, paid_at, paid_by, paid_by_name, notes)
          VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 0, 0, $8, $9, $10, 'paid', NOW(), $11, $12, $13)
          RETURNING *
          `,
          [
            safeBranchId,
            empId,
            cycleTypeToUse,
            recPeriodStart,
            recPeriodEnd,
            priorUnpaidDues > 0 ? priorEarnedSalary : 0,
            priorUnpaidDues > 0 ? (unclosedCyclesCount * 6) : 0,
            priorUnpaidDues > 0 ? totalPriorAdvances : 0,
            arrearsAmount,
            cashOutId,
            user.id || null,
            paidByName,
            notesText,
          ],
        );

        const payrollRecord = recordRes.rows[0];
        createdRecords.push(payrollRecord);

        // Mark the retained_dues as applied
        if (arrearsRes.rows.length > 0) {
          const adjIds = arrearsRes.rows.map((r) => r.id);
          await client.query(
            `
            UPDATE payroll_retained_dues 
            SET status = 'applied', payroll_record_id = $1, updated_at = NOW() 
            WHERE id = ANY($2) AND branch_id = $3
            `,
            [payrollRecord.id, adjIds, safeBranchId],
          );
        }

        // Mark prior advances as deducted
        if (priorAdvances.length > 0 && priorUnpaidDues > 0) {
          const priorAdvIds = priorAdvances.map((a) => a.id);
          await client.query(
            `
            UPDATE payroll_advances 
            SET status = 'deducted', payroll_record_id = $1 
            WHERE id = ANY($2) AND branch_id = $3
            `,
            [payrollRecord.id, priorAdvIds, safeBranchId],
          );
        }

        continue; // Proceed to next employee item
      }

      // -------------------------------------------------------------
      // CASES 2, 3, 4: CURRENT SALARY INVOLVED ('full', 'current_only', 'carry_forward')
      // -------------------------------------------------------------
      const dayCheck = checkIsPayrollDay(itemCycle, safeEnd);

      // Enforce strict payroll day guard if paying cash for current cycle (Admins can override for early settlement)
      const isAdmin = Number(user.id) === 7 || user.role === "admin";
      if (empScope !== "carry_forward" && !dayCheck.isPayrollDay && !isAdmin && !item.admin_override) {
        throw new Error(
          `غير مصرح بصرف راتب الفترة الحالية للعامل [${item.name || empId}] قبل موعد الصرف الرسمي (${dayCheck.reason})`
        );
      }

      const baseAmount = Number(item.base_amount || 0);
      const daysWorked = Number(item.days_worked || 0);
      const overtimeAmount = Number(item.overtime_amount || 0);
      const bonusAmount = Number(item.bonus_amount || 0);
      const deductionsAmount = Number(item.deductions_amount || 0);
      const advancesDeducted = Number(item.advances_deducted || 0);

      const grossEarnings = Math.max(
        0,
        Math.round((baseAmount + overtimeAmount + bonusAmount - deductionsAmount) * 100) / 100,
      );

      let actualDeductedInRecord = advancesDeducted;
      let carryOverExcess = 0;
      let netAmount = 0;

      if (advancesDeducted > grossEarnings) {
        carryOverExcess = Math.round((advancesDeducted - grossEarnings) * 100) / 100;
        actualDeductedInRecord = grossEarnings;
        netAmount = 0;
      } else {
        actualDeductedInRecord = advancesDeducted;
        netAmount = Math.max(
          0,
          Math.round((grossEarnings - advancesDeducted) * 100) / 100,
        );
      }

      // Double payout guard: ensure employee has not already been paid for this period with an active cash_out
      const dupCheck = await client.query(
        `
        SELECT pr.id, pr.paid_at 
        FROM payroll_records pr
        LEFT JOIN cash_out co ON pr.cash_out_id = co.id
        WHERE pr.branch_id = $1 AND pr.employee_id = $2 AND pr.payment_status = 'paid'
          AND pr.cycle_type != 'arrears'
          AND (pr.cash_out_id IS NULL OR co.id IS NOT NULL)
          AND (
            (pr.period_start = $3 AND pr.period_end = $4)
            OR (pr.period_end >= $3 AND pr.period_start <= $4)
          )
        LIMIT 1
        `,
        [safeBranchId, empId, safeStart, safeEnd],
      );
      if (dupCheck.rows.length > 0) {
        throw new Error(`تم اعتماد وصرف راتب العامل [${item.name || empId}] بالفعل عن هذه الفترة.`);
      }

      // Fetch pending retained_dues if scope is 'full'
      let retainedDuesAmount = 0;
      let retainedDuesAdjIds = [];
      let priorUnpaidDuesAmount = 0;
      let fullPriorAdvances = [];
      let fullPriorEarnedSalary = 0;
      let fullTotalPriorAdvances = 0;
      let fullUnclosedCyclesCount = 1;
      let fullUnclosedStart = safeStart;
      let fullUnclosedEnd = safeEnd;

      if (empScope === "full") {
        const retainedRes = await client.query(
          `
          SELECT id, amount 
          FROM payroll_retained_dues
          WHERE branch_id = $1 AND employee_id = $2 AND status = 'pending' AND due_date <= $3
          `,
          [safeBranchId, empId, safeEnd],
        );
        retainedDuesAmount = retainedRes.rows.reduce((s, r) => s + Number(r.amount || 0), 0);
        retainedDuesAdjIds = retainedRes.rows.map((r) => r.id);

        // Also check if employee has unclosed prior cycles with prior advances (priorUnpaidDues)
        const priorAdvRes = await client.query(
          `
          SELECT id, amount, advance_date
          FROM payroll_advances
          WHERE branch_id = $1 AND employee_id = $2 AND status = 'pending' AND advance_date < $3
          ORDER BY advance_date ASC, id ASC
          `,
          [safeBranchId, empId, safeStart],
        );
        fullPriorAdvances = priorAdvRes.rows;

        if (fullPriorAdvances.length > 0) {
          const empRes = await client.query(
            `SELECT id, name, salary_type, base_salary, hire_date FROM payroll_employees WHERE id = $1`,
            [empId],
          );
          const empInfo = empRes.rows[0];

          const latestPaidRes = await client.query(
            `
            SELECT MAX(period_end) as last_period_end
            FROM payroll_records
            WHERE branch_id = $1 AND employee_id = $2 AND payment_status = 'paid' AND cycle_type != 'arrears'
            `,
            [safeBranchId, empId],
          );
          const lastPaidEnd = latestPaidRes.rows[0]?.last_period_end ? (
            latestPaidRes.rows[0].last_period_end instanceof Date
              ? latestPaidRes.rows[0].last_period_end.toISOString().slice(0, 10)
              : String(latestPaidRes.rows[0].last_period_end).slice(0, 10)
          ) : (
            empInfo?.hire_date ? (
              empInfo.hire_date instanceof Date
                ? empInfo.hire_date.toISOString().slice(0, 10)
                : String(empInfo.hire_date).slice(0, 10)
            ) : null
          );

          if (lastPaidEnd) {
            const startMs = new Date(safeStart + "T12:00:00").getTime();
            const endMs = new Date(lastPaidEnd + "T12:00:00").getTime();
            const diffDays = Math.max(0, Math.round((startMs - endMs) / (1000 * 60 * 60 * 24)));
            if (empInfo?.salary_type === "weekly" || empInfo?.salary_type === "daily") {
              fullUnclosedCyclesCount = Math.max(1, Math.floor(diffDays / 7));
            } else if (empInfo?.salary_type === "monthly") {
              fullUnclosedCyclesCount = Math.max(1, Math.floor(diffDays / 30));
            }

            const lastEndObj = new Date(lastPaidEnd + "T12:00:00");
            lastEndObj.setDate(lastEndObj.getDate() + 1);
            if (lastEndObj.getDay() === 5) lastEndObj.setDate(lastEndObj.getDate() + 1);
            fullUnclosedStart = lastEndObj.toISOString().slice(0, 10);

            const curStartObj = new Date(safeStart + "T12:00:00");
            curStartObj.setDate(curStartObj.getDate() - 1);
            if (curStartObj.getDay() === 5) curStartObj.setDate(curStartObj.getDate() - 1);
            fullUnclosedEnd = curStartObj.toISOString().slice(0, 10);
          }

          const empBaseSalary = Number(empInfo?.base_salary || item.base_amount || 0);
          fullPriorEarnedSalary = fullUnclosedCyclesCount * empBaseSalary;
          fullTotalPriorAdvances = fullPriorAdvances.reduce((s, a) => s + Number(a.amount || 0), 0);

          if (fullTotalPriorAdvances <= fullPriorEarnedSalary) {
            priorUnpaidDuesAmount = Math.round((fullPriorEarnedSalary - fullTotalPriorAdvances) * 100) / 100;
          }
        }
      }

      const totalCarriedDues = retainedDuesAmount + priorUnpaidDuesAmount;
      const totalCashToPay = empScope === "full" ? (netAmount + totalCarriedDues) : netAmount;

      // 1. Create cash_out voucher if totalCashToPay > 0 and requested (and not carry_forward)
      let cashOutId = null;
      let permissionNumber = null;
      if (record_cash_out && empScope !== "carry_forward" && totalCashToPay > 0) {
        permissionNumber = generatePermissionNumber(safeEnd);
        const nameTitle = empScope === "full" && totalCarriedDues > 0
          ? `راتب ومستحقات: ${item.name || "موظف"}`
          : `راتب: ${item.name || "موظف"}`;

        const rolePrefix = formatJobTitleWithPrefix(item.job_title);
        const notesBreakdown = [
          `صرف راتب ${itemCycle === "monthly" ? "شهري" : "أسبوعي"} ${rolePrefix}: ${item.name || ""}`,
          `الفترة من ${safeStart} إلى ${safeEnd}`,
          totalCarriedDues > 0 ? `(شامل ${totalCarriedDues} ج مستحقات مرحلة سابقة)` : null,
          actualDeductedInRecord > 0 ? `(بعد خصم سلف ${actualDeductedInRecord} ج)` : null,
        ].filter(Boolean).join(" - ");

        const cashOutRes = await client.query(
          `
          INSERT INTO cash_out 
            (branch_id, name, amount, notes, transaction_date, permission_number, entry_type)
          VALUES ($1, $2, $3, $4, $5, $6, 'expense')
          RETURNING id
          `,
          [
            safeBranchId,
            nameTitle,
            totalCashToPay,
            notesBreakdown,
            safeEnd,
            permissionNumber,
          ],
        );
        cashOutId = cashOutRes.rows[0].id;
        totalCashPaidOut += totalCashToPay;
      }

      // If full scope has prior unclosed dues, insert a record for the unclosed period first
      if (empScope === "full" && priorUnpaidDuesAmount > 0) {
        const priorRecRes = await client.query(
          `
          INSERT INTO payroll_records 
            (branch_id, employee_id, cycle_type, period_start, period_end, base_amount, days_worked,
             overtime_amount, bonus_amount, deductions_amount, advances_deducted, net_amount,
             cash_out_id, payment_status, paid_at, paid_by, paid_by_name, notes)
          VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 0, 0, $8, $9, $10, 'paid', NOW(), $11, $12, $13)
          RETURNING *
          `,
          [
            safeBranchId,
            empId,
            itemCycle,
            fullUnclosedStart,
            fullUnclosedEnd,
            fullPriorEarnedSalary,
            fullUnclosedCyclesCount * 6,
            fullTotalPriorAdvances,
            priorUnpaidDuesAmount,
            cashOutId,
            user.id || null,
            paidByName,
            `تسوية مسير متأخر سابق (${fullUnclosedStart} إلى ${fullUnclosedEnd}) ضمن الصرف الشامل`,
          ],
        );
        createdRecords.push(priorRecRes.rows[0]);

        // Mark prior advances as deducted
        if (fullPriorAdvances.length > 0) {
          const pIds = fullPriorAdvances.map((a) => a.id);
          await client.query(
            `UPDATE payroll_advances SET status = 'deducted', payroll_record_id = $1 WHERE id = ANY($2) AND branch_id = $3`,
            [priorRecRes.rows[0].id, pIds, safeBranchId],
          );
        }
      }

      // 2. Prepare notes and insert into payroll_records
      let recordNotes = item.notes ? String(item.notes).trim() : "";
      if (carryOverExcess > 0) {
        const carryMsg = `(تم استهلاك كامل الراتب مقابل السلف، وترحيل ${carryOverExcess} ج سلف متبقية للأسبوع القادم)`;
        recordNotes = recordNotes ? `${recordNotes} - ${carryMsg}` : carryMsg;
      }
      if (empScope === "full" && retainedDuesAmount > 0) {
        const retMsg = `(تم صرف مستحقات مرحلة سابقة بقيمة ${retainedDuesAmount} ج مع الراتب)`;
        recordNotes = recordNotes ? `${recordNotes} - ${retMsg}` : retMsg;
      }
      if (empScope === "carry_forward") {
        const fwdMsg = `(تم ترحيل صافي المستحق ${netAmount} ج كمتأخرات للمسير القادم دون صرف نقدية)`;
        recordNotes = recordNotes ? `${recordNotes} - ${fwdMsg}` : fwdMsg;
      }

      const paymentStatus = empScope === "carry_forward" ? "carried_forward" : "paid";

      const recordRes = await client.query(
        `
        INSERT INTO payroll_records 
          (branch_id, employee_id, cycle_type, period_start, period_end, base_amount, days_worked,
           overtime_amount, bonus_amount, deductions_amount, advances_deducted, net_amount,
           cash_out_id, payment_status, paid_at, paid_by, paid_by_name, notes)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW(), $15, $16, $17)
        RETURNING *
        `,
        [
          safeBranchId,
          empId,
          itemCycle,
          safeStart,
          safeEnd,
          baseAmount,
          daysWorked,
          overtimeAmount,
          bonusAmount,
          deductionsAmount,
          actualDeductedInRecord,
          empScope === "carry_forward" ? 0 : totalCashToPay,
          cashOutId,
          paymentStatus,
          user.id || null,
          paidByName,
          recordNotes || null,
        ],
      );

      const payrollRecord = recordRes.rows[0];
      createdRecords.push(payrollRecord);

      // If carry_forward: insert netAmount as retained_dues for the next cycle
      if (empScope === "carry_forward" && netAmount > 0) {
        const nextDayObj = new Date(safeEnd + "T12:00:00");
        nextDayObj.setDate(nextDayObj.getDate() + 1);
        const nextDateStr = nextDayObj.toISOString().slice(0, 10);

        await client.query(
          `
          INSERT INTO payroll_retained_dues 
            (branch_id, employee_id, amount, due_date, reason, status, created_by, created_by_name)
          VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)
          `,
          [
            safeBranchId,
            empId,
            netAmount,
            nextDateStr,
            `مستحق مرحل من مسير الفترة (${safeStart} إلى ${safeEnd})`,
            user.id || null,
            paidByName,
          ],
        );
      }

      // 3. Mark linked advances as deducted
      const advanceIds = Array.isArray(item.advance_ids) ? item.advance_ids.map(Number).filter(Boolean) : [];
      if (advanceIds.length > 0) {
        await client.query(
          `
          UPDATE payroll_advances 
          SET status = 'deducted', payroll_record_id = $1 
          WHERE id = ANY($2) AND branch_id = $3
          `,
          [payrollRecord.id, advanceIds, safeBranchId],
        );
      } else {
        await client.query(
          `
          UPDATE payroll_advances 
          SET status = 'deducted', payroll_record_id = $1 
          WHERE employee_id = $2 AND branch_id = $3 AND status = 'pending' AND advance_date <= $4
          `,
          [payrollRecord.id, empId, safeBranchId, safeEnd],
        );
      }

      // 3.b If there is excess advance beyond gross earnings, carry it over as a new pending advance
      if (carryOverExcess > 0) {
        const endDateObj = new Date(safeEnd + "T12:00:00");
        endDateObj.setDate(endDateObj.getDate() + 1);
        const nextDateStr = endDateObj.toISOString().slice(0, 10);

        await client.query(
          `
          INSERT INTO payroll_advances 
            (branch_id, employee_id, amount, advance_date, status, cash_out_id, notes, created_by, created_by_name)
          VALUES ($1, $2, $3, $4, 'pending', NULL, $5, $6, $7)
          `,
          [
            safeBranchId,
            empId,
            carryOverExcess,
            nextDateStr,
            `متبقي سلف مرحل من مسير الفترة (${safeStart} إلى ${safeEnd})`,
            user.id || null,
            paidByName,
          ],
        );
      }

      // 4. Mark linked adjustments as applied
      const adjustmentIds = Array.isArray(item.adjustment_ids) ? item.adjustment_ids.map(Number).filter(Boolean) : [];
      if (adjustmentIds.length > 0) {
        await client.query(
          `
          UPDATE payroll_adjustments 
          SET status = 'applied', payroll_record_id = $1, updated_at = NOW() 
          WHERE id = ANY($2) AND branch_id = $3
          `,
          [payrollRecord.id, adjustmentIds, safeBranchId],
        );
      } else {
        await client.query(
          `
          UPDATE payroll_adjustments 
          SET status = 'applied', payroll_record_id = $1, updated_at = NOW() 
          WHERE employee_id = $2 AND branch_id = $3 AND status = 'pending' AND adjustment_date <= $4
          `,
          [payrollRecord.id, empId, safeBranchId, safeEnd],
        );
      }

      // If scope was 'full' and had retained_dues, ensure they are marked applied with this payroll_record_id
      if (empScope === "full" && retainedDuesAdjIds.length > 0) {
        await client.query(
          `
          UPDATE payroll_retained_dues 
          SET status = 'applied', payroll_record_id = $1, updated_at = NOW() 
          WHERE id = ANY($2) AND branch_id = $3
          `,
          [payrollRecord.id, retainedDuesAdjIds, safeBranchId],
        );
      }

      // 5. Link attendance records for this period to this payroll record
      try {
        await client.query(
          `
          UPDATE payroll_attendance 
          SET payroll_record_id = $1, updated_at = NOW() 
          WHERE employee_id = $2 AND branch_id = $3 AND attendance_date >= $4 AND attendance_date <= $5
          `,
          [payrollRecord.id, empId, safeBranchId, safeStart, safeEnd],
        );
      } catch (attErr) {
        console.warn("payroll_attendance payout link note:", attErr.message);
      }
    }

    await client.query("COMMIT");

    // Realtime broadcast to update dashboard and cash registries
    const broadcast = req.app?.get("broadcastRealtime");
    if (typeof broadcast === "function") {
      broadcast("data:payroll", { action: "payroll_paid", branch_id: safeBranchId, ts: Date.now() });
      if (record_cash_out && totalCashPaidOut > 0) {
        broadcast("data:cash", { action: "cash_out_created", branch_id: safeBranchId, ts: Date.now() });
      }
    }

    res.json({
      success: true,
      message: `تم اعتماد وصرف الرواتب بنجاح بإجمالي ${totalCashPaidOut} ج.م`,
      records: createdRecords,
      total_paid: totalCashPaidOut,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("confirmPayrollPayout error:", err);
    res.status(500).json({ error: "فشل في اعتماد وصرف مسير الرواتب", details: err.message });
  } finally {
    client.release();
  }
}

/**
 * GET /payroll/history?branch_id=1&cycle_type=weekly&limit=50
 */
async function getPayrollHistory(req, res) {
  try {
    const branchId = Number(req.query.branch_id) || 1;
    const cycleType = req.query.cycle_type;
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));

    let query = `
      SELECT 
        r.*,
        e.name AS employee_name,
        e.job_title,
        co.permission_number
      FROM payroll_records r
      JOIN payroll_employees e ON e.id = r.employee_id
      LEFT JOIN cash_out co ON co.id = r.cash_out_id
      WHERE r.branch_id = $1
    `;
    const params = [branchId];
    let idx = 2;

    if (cycleType && ["weekly", "monthly"].includes(cycleType)) {
      query += ` AND r.cycle_type = $${idx++}`;
      params.push(cycleType);
    }

    query += ` ORDER BY r.period_end DESC, r.id DESC LIMIT $${idx}`;
    params.push(limit);

    const result = await pool.query(query, params);
    res.json({ success: true, records: result.rows });
  } catch (err) {
    console.error("getPayrollHistory error:", err);
    res.status(500).json({ error: "فشل في جلب سجل الرواتب", details: err.message });
  }
}

/**
 * DELETE /payroll/history/:id
 * Reverts a confirmed payout: restores deducted advances to pending, removes cash_out entry
 */
async function revertPayrollRecord(req, res) {
  const client = await pool.connect();
  try {
    const recordId = Number(req.params.id);

    await client.query("BEGIN");

    const recRes = await client.query("SELECT * FROM payroll_records WHERE id = $1 FOR UPDATE", [recordId]);
    if (recRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "سجل الراتب غير موجود" });
    }

    const record = recRes.rows[0];

    // 1. Revert advances back to 'pending'
    await client.query(
      "UPDATE payroll_advances SET status = 'pending', payroll_record_id = NULL WHERE payroll_record_id = $1",
      [recordId],
    );

    // 1.b Revert adjustments back to 'pending'
    await client.query(
      "UPDATE payroll_adjustments SET status = 'pending', payroll_record_id = NULL, updated_at = NOW() WHERE payroll_record_id = $1",
      [recordId],
    );

    // 1.c Revert linked attendance back
    try {
      await client.query(
        "UPDATE payroll_attendance SET payroll_record_id = NULL, updated_at = NOW() WHERE payroll_record_id = $1",
        [recordId],
      );
    } catch (attErr) {
      console.warn("payroll_attendance revert note:", attErr.message);
    }

    // 2. Delete linked cash_out row if exists
    if (record.cash_out_id) {
      await client.query("DELETE FROM cash_out WHERE id = $1", [record.cash_out_id]);
    }

    // 3. Delete the payroll_records row
    await client.query("DELETE FROM payroll_records WHERE id = $1", [recordId]);

    await client.query("COMMIT");

    const broadcast = req.app?.get("broadcastRealtime");
    if (typeof broadcast === "function") {
      broadcast("data:payroll", { action: "payroll_reverted", branch_id: record.branch_id, ts: Date.now() });
      if (record.cash_out_id) {
        broadcast("data:cash", { action: "cash_out_deleted", branch_id: record.branch_id, ts: Date.now() });
      }
    }

    res.json({ success: true, message: "تم إلغاء واسترجاع مسير الراتب بنجاح" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("revertPayrollRecord error:", err);
    res.status(500).json({ error: "فشل في استرجاع مسير الراتب", details: err.message });
  } finally {
    client.release();
  }
}

/**
 * POST /payroll/attendance/toggle
 * Toggles employee attendance for a specific date (absent vs present)
 * Body: { branch_id, employee_id, attendance_date, status: "absent" | "present", notes }
 */
async function toggleAttendance(req, res) {
  const client = await pool.connect();
  try {
    const { branch_id, employee_id, attendance_date, status = "absent", notes = "" } = req.body;
    const safeBranchId = Number(branch_id);
    const empId = Number(employee_id);
    const dateStr = String(attendance_date || "").slice(0, 10);
    const targetStatus = status === "absent" ? "absent" : "present";

    if (!safeBranchId || !empId || !dateStr) {
      return res.status(400).json({ error: "بيانات تسجيل الحضور والغياب غير مكتملة" });
    }

    // 1. Fetch employee
    const empRes = await client.query(
      "SELECT id, name, salary_type, base_salary, status, branch_id FROM payroll_employees WHERE id = $1",
      [empId],
    );
    if (empRes.rows.length === 0) {
      return res.status(404).json({ error: "العامل غير موجود" });
    }
    const emp = empRes.rows[0];

    // 2. Check if period covering this date is already paid
    const paidCheck = await client.query(
      `
      SELECT pr.id, pr.period_start, pr.period_end, pr.paid_at
      FROM payroll_records pr
      LEFT JOIN cash_out co ON pr.cash_out_id = co.id
      WHERE pr.branch_id = $1 AND pr.employee_id = $2 AND pr.payment_status = 'paid'
        AND (pr.cash_out_id IS NULL OR co.id IS NOT NULL)
        AND pr.period_start <= $3 AND pr.period_end >= $3
      LIMIT 1
      `,
      [safeBranchId, empId, dateStr],
    );
    if (paidCheck.rows.length > 0) {
      return res.status(400).json({
        error: `تم اعتماد وصرف مسير راتب هذا العامل بالفعل للفترة التي تشمل تاريخ ${dateStr}. لا يمكن تعديل الغياب بأثر رجعي.`,
      });
    }

    // 3. Calculate daily rate on server (Base / 6 for weekly)
    const baseSalary = Number(emp.base_salary || 0);
    let dayRate = 0;
    if (emp.salary_type === "weekly") {
      dayRate = Math.round((baseSalary / 6.0) * 100) / 100;
    } else if (emp.salary_type === "monthly") {
      dayRate = Math.round((baseSalary / 30.0) * 100) / 100;
    } else {
      // daily
      dayRate = baseSalary;
    }

    // Arabic day name helper
    const daysArabic = ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
    const dObj = new Date(dateStr + "T12:00:00");
    const dayName = isNaN(dObj.getTime()) ? "" : daysArabic[dObj.getDay()];

    // Friday Protection: Friday is the official paid weekly holiday; deductions are forbidden
    if (dObj.getDay() === 5 && emp.salary_type === "weekly" && targetStatus === "absent") {
      return res.status(400).json({
        error: "يوم الجمعة إجازة أسبوعية رسمية مدفوعة ولا يجوز تسجيل غياب أو تطبيق خصم فيه.",
      });
    }

    const user = req.user || {};
    const createdBy = user.id || null;
    const createdByName = user.full_name || user.username || "الإدارة";

    await client.query("BEGIN");

    // Check existing attendance record
    const existRes = await client.query(
      "SELECT id, status, adjustment_id FROM payroll_attendance WHERE employee_id = $1 AND attendance_date = $2",
      [empId, dateStr],
    );
    const existing = existRes.rows[0];

    if (targetStatus === "absent") {
      // If already absent, return early
      if (existing && existing.status === "absent") {
        await client.query("COMMIT");
        return res.json({ success: true, message: "العامل مسجل غياب بالفعل لهذا اليوم", status: "absent", day_rate: dayRate });
      }

      // Create linked adjustment deduction
      const reasonText = `خصم غياب يوم ${dayName ? dayName + " " : ""}(${dateStr}) - أسبوعية`;
      const adjRes = await client.query(
        `
        INSERT INTO payroll_adjustments 
          (branch_id, employee_id, type, amount, adjustment_date, reason, status, created_by, created_by_name)
        VALUES ($1, $2, 'deduction', $3, $4, $5, 'pending', $6, $7)
        RETURNING id
        `,
        [safeBranchId, empId, dayRate, dateStr, reasonText, createdBy, createdByName],
      );
      const adjustmentId = adjRes.rows[0].id;

      // Upsert into payroll_attendance
      await client.query(
        `
        INSERT INTO payroll_attendance
          (branch_id, employee_id, attendance_date, status, day_rate, adjustment_id, notes, created_by, created_by_name)
        VALUES ($1, $2, $3, 'absent', $4, $5, $6, $7, $8)
        ON CONFLICT (employee_id, attendance_date)
        DO UPDATE SET 
          status = 'absent', 
          day_rate = EXCLUDED.day_rate, 
          adjustment_id = EXCLUDED.adjustment_id, 
          notes = EXCLUDED.notes,
          updated_at = NOW()
        `,
        [safeBranchId, empId, dateStr, dayRate, adjustmentId, notes || reasonText, createdBy, createdByName],
      );
    } else {
      // Revert to "present"
      if (existing && existing.adjustment_id) {
        // Delete pending linked adjustment
        await client.query(
          "DELETE FROM payroll_adjustments WHERE id = $1 AND status = 'pending'",
          [existing.adjustment_id],
        );
      }
      // Delete attendance row
      await client.query(
        "DELETE FROM payroll_attendance WHERE employee_id = $1 AND attendance_date = $2",
        [empId, dateStr],
      );
    }

    await client.query("COMMIT");

    const broadcast = req.app?.get("broadcastRealtime");
    if (typeof broadcast === "function") {
      broadcast("data:payroll", {
        action: "attendance_updated",
        branch_id: safeBranchId,
        employee_id: empId,
        date: dateStr,
        status: targetStatus,
        ts: Date.now(),
      });
    }

    res.json({
      success: true,
      status: targetStatus,
      day_rate: dayRate,
      message: targetStatus === "absent" ? `تم تسجيل غياب العامل وخصم ${dayRate} ج` : "تم إلغاء الغياب واسترجاع اليومية",
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("toggleAttendance error:", err);
    res.status(500).json({ error: "فشل في تحديث حالة الحضور والغياب", details: err.message });
  } finally {
    client.release();
  }
}

/**
 * GET /payroll/employees/:id/ledger?branch_id=1&from=YYYY-MM-DD&to=YYYY-MM-DD
 * Comprehensive audit trail, ledger, and transaction history for an individual employee
 */
async function getEmployeeLedger(req, res) {
  try {
    const empId = Number(req.params.id);
    const branchId = Number(req.query.branch_id) || null;
    const fromDate = req.query.from || null;
    const toDate = req.query.to || null;

    if (!empId) {
      return res.status(400).json({ error: "معرف العامل غير صحيح" });
    }

    // 1. Fetch employee profile
    const empRes = await pool.query(
      `
      SELECT e.*, b.name as branch_name
      FROM payroll_employees e
      LEFT JOIN branches b ON e.branch_id = b.id
      WHERE e.id = $1
      `,
      [empId],
    );
    if (empRes.rows.length === 0) {
      return res.status(404).json({ error: "العامل غير موجود" });
    }
    const employee = empRes.rows[0];

    // 2. Aggregated Summary Statistics
    const [payoutsStats, advancesStats, absenceStats, adjStats] = await Promise.all([
      // Total net payouts
      pool.query(
        `
        SELECT 
          COALESCE(SUM(pr.net_amount), 0) as total_net_paid,
          COALESCE(SUM(pr.base_amount), 0) as total_base_paid,
          COALESCE(SUM(pr.overtime_amount), 0) as total_overtime_paid,
          COALESCE(SUM(pr.bonus_amount), 0) as total_bonus_paid,
          COALESCE(SUM(pr.deductions_amount), 0) as total_deductions_paid,
          COALESCE(SUM(pr.advances_deducted), 0) as total_advances_settled,
          COUNT(pr.id) as count_payouts
        FROM payroll_records pr
        LEFT JOIN cash_out co ON pr.cash_out_id = co.id
        WHERE pr.employee_id = $1 AND pr.payment_status = 'paid'
          AND (pr.cash_out_id IS NULL OR co.id IS NOT NULL)
        `,
        [empId],
      ),
      // Advances stats
      pool.query(
        `
        SELECT 
          COALESCE(SUM(amount), 0) as total_advances_taken,
          COALESCE(SUM(CASE WHEN status = 'pending' THEN amount ELSE 0 END), 0) as pending_advances,
          COALESCE(SUM(CASE WHEN status = 'deducted' THEN amount ELSE 0 END), 0) as deducted_advances,
          COUNT(id) as count_advances
        FROM payroll_advances
        WHERE employee_id = $1
        `,
        [empId],
      ),
      // Absences stats
      pool.query(
        `
        SELECT 
          COUNT(id) as count_absences,
          COALESCE(SUM(day_rate), 0) as total_absence_amount
        FROM payroll_attendance
        WHERE employee_id = $1 AND status = 'absent'
        `,
        [empId],
      ),
      // Active pending adjustments stats
      pool.query(
        `
        SELECT 
          COALESCE(SUM(CASE WHEN type IN ('bonus', 'overtime') THEN amount ELSE 0 END), 0) as pending_bonuses,
          COALESCE(SUM(CASE WHEN type = 'deduction' THEN amount ELSE 0 END), 0) as pending_deductions
        FROM payroll_adjustments
        WHERE employee_id = $1 AND status = 'pending'
        `,
        [empId],
      ),
    ]);

    const summary = {
      total_net_paid: Number(payoutsStats.rows[0]?.total_net_paid || 0),
      total_base_paid: Number(payoutsStats.rows[0]?.total_base_paid || 0),
      total_overtime_paid: Number(payoutsStats.rows[0]?.total_overtime_paid || 0),
      total_bonus_paid: Number(payoutsStats.rows[0]?.total_bonus_paid || 0),
      total_deductions_paid: Number(payoutsStats.rows[0]?.total_deductions_paid || 0),
      total_advances_settled: Number(payoutsStats.rows[0]?.total_advances_settled || 0),
      count_payouts: Number(payoutsStats.rows[0]?.count_payouts || 0),

      total_advances_taken: Number(advancesStats.rows[0]?.total_advances_taken || 0),
      pending_advances: Number(advancesStats.rows[0]?.pending_advances || 0),
      count_advances: Number(advancesStats.rows[0]?.count_advances || 0),

      count_absences: Number(absenceStats.rows[0]?.count_absences || 0),
      total_absence_amount: Number(absenceStats.rows[0]?.total_absence_amount || 0),

      pending_bonuses: Number(adjStats.rows[0]?.pending_bonuses || 0),
      pending_deductions: Number(adjStats.rows[0]?.pending_deductions || 0),
    };

    // 3. Transactions / Audit Trail
    const [payoutsRes, advsRes, attsRes, adjsRes] = await Promise.all([
      pool.query(
        `
        SELECT 
          pr.id, 'payout' as tx_type, pr.net_amount as amount, pr.paid_at as tx_date,
          CONCAT('صرف مسير راتب (', pr.cycle_type, ') عن الفترة ', pr.period_start, ' إلى ', pr.period_end) as description,
          co.permission_number, pr.paid_by_name as actor_name, pr.payment_status as status,
          pr.notes,
          pr.base_amount, pr.days_worked, pr.overtime_amount, pr.bonus_amount, pr.deductions_amount, pr.advances_deducted
        FROM payroll_records pr
        LEFT JOIN cash_out co ON pr.cash_out_id = co.id
        WHERE pr.employee_id = $1 AND pr.payment_status = 'paid'
          AND (pr.cash_out_id IS NULL OR co.id IS NOT NULL)
        ORDER BY pr.paid_at DESC
        `,
        [empId],
      ),
      pool.query(
        `
        SELECT 
          pa.id, 'advance' as tx_type, pa.amount, pa.advance_date as tx_date,
          COALESCE(pa.notes, 'سلفة نقدية للموظف') as description,
          co.permission_number, pa.created_by_name as actor_name, pa.status,
          pa.notes
        FROM payroll_advances pa
        LEFT JOIN cash_out co ON pa.cash_out_id = co.id
        WHERE pa.employee_id = $1
        ORDER BY pa.advance_date DESC, pa.id DESC
        `,
        [empId],
      ),
      pool.query(
        `
        SELECT 
          att.id, 'absence' as tx_type, att.day_rate as amount, att.attendance_date as tx_date,
          COALESCE(att.notes, CONCAT('تسجيل غياب يوم ', att.attendance_date)) as description,
          NULL as permission_number, att.created_by_name as actor_name, att.status,
          att.notes
        FROM payroll_attendance att
        WHERE att.employee_id = $1 AND att.status = 'absent'
        ORDER BY att.attendance_date DESC, att.id DESC
        `,
        [empId],
      ),
      pool.query(
        `
        SELECT 
          padj.id, padj.type as tx_type, padj.amount, padj.adjustment_date as tx_date,
          COALESCE(padj.reason, padj.type) as description,
          NULL as permission_number, padj.created_by_name as actor_name, padj.status,
          padj.reason as notes
        FROM payroll_adjustments padj
        WHERE padj.employee_id = $1
          AND (padj.reason NOT LIKE 'خصم غياب%' OR padj.reason IS NULL)
        UNION ALL
        SELECT 
          rd.id, 'retained_dues' as tx_type, rd.amount, rd.due_date as tx_date,
          COALESCE(rd.reason, 'مستحق مرحل سابق') as description,
          NULL as permission_number, rd.created_by_name as actor_name, rd.status,
          rd.reason as notes
        FROM payroll_retained_dues rd
        WHERE rd.employee_id = $1
        ORDER BY tx_date DESC, id DESC
        `,
        [empId],
      ),
    ]);

    const transactions = [];

    // Map payouts
    for (const r of payoutsRes.rows) {
      transactions.push({
        id: `payout-${r.id}`,
        record_id: r.id,
        tx_type: "payout",
        category: "راتب",
        amount: Number(r.amount || 0),
        tx_date: r.tx_date instanceof Date ? r.tx_date.toISOString().slice(0, 10) : String(r.tx_date).slice(0, 10),
        raw_timestamp: r.tx_date,
        description: r.description,
        permission_number: r.permission_number || null,
        actor_name: r.actor_name || "الإدارة",
        status: r.status,
        notes: r.notes || "",
        breakdown: {
          base: Number(r.base_amount || 0),
          days_worked: Number(r.days_worked || 0),
          overtime: Number(r.overtime_amount || 0),
          bonus: Number(r.bonus_amount || 0),
          deductions: Number(r.deductions_amount || 0),
          advances_deducted: Number(r.advances_deducted || 0),
        },
      });
    }

    // Map advances
    for (const r of advsRes.rows) {
      transactions.push({
        id: `adv-${r.id}`,
        record_id: r.id,
        tx_type: "advance",
        category: "سلفة",
        amount: Number(r.amount || 0),
        tx_date: r.tx_date instanceof Date ? r.tx_date.toISOString().slice(0, 10) : String(r.tx_date).slice(0, 10),
        raw_timestamp: r.tx_date,
        description: r.description,
        permission_number: r.permission_number || null,
        actor_name: r.actor_name || "الإدارة",
        status: r.status,
        notes: r.notes || "",
      });
    }

    // Map absences
    for (const r of attsRes.rows) {
      transactions.push({
        id: `att-${r.id}`,
        record_id: r.id,
        tx_type: "absence",
        category: "غياب",
        amount: Number(r.amount || 0),
        tx_date: r.tx_date instanceof Date ? r.tx_date.toISOString().slice(0, 10) : String(r.tx_date).slice(0, 10),
        raw_timestamp: r.tx_date,
        description: r.description,
        permission_number: null,
        actor_name: r.actor_name || "الإدارة",
        status: r.status,
        notes: r.notes || "",
      });
    }

    // Map other adjustments (bonus, overtime, deduction)
    for (const r of adjsRes.rows) {
      transactions.push({
        id: `adj-${r.id}`,
        record_id: r.id,
        tx_type: r.tx_type,
        category: r.tx_type === "bonus" ? "مكافأة" : r.tx_type === "overtime" ? "إضافي" : "خصم",
        amount: Number(r.amount || 0),
        tx_date: r.tx_date instanceof Date ? r.tx_date.toISOString().slice(0, 10) : String(r.tx_date).slice(0, 10),
        raw_timestamp: r.tx_date,
        description: r.description,
        permission_number: null,
        actor_name: r.actor_name || "الإدارة",
        status: r.status,
        notes: r.notes || "",
      });
    }

    // Sort all transactions chronologically descending
    transactions.sort((a, b) => {
      const dateA = new Date(a.raw_timestamp || a.tx_date).getTime();
      const dateB = new Date(b.raw_timestamp || b.tx_date).getTime();
      return dateB - dateA;
    });

    res.json({
      success: true,
      employee: {
        id: employee.id,
        name: employee.name,
        phone: employee.phone,
        national_id: employee.national_id,
        job_title: employee.job_title,
        salary_type: employee.salary_type,
        base_salary: Number(employee.base_salary || 0),
        status: employee.status,
        hire_date: employee.hire_date,
        branch_id: employee.branch_id,
        branch_name: employee.branch_name,
        notes: employee.notes,
      },
      summary,
      transactions,
    });
  } catch (err) {
    console.error("getEmployeeLedger error:", err);
    res.status(500).json({ error: "فشل في جلب كشف حساب العامل", details: err.message });
  }
}

module.exports = {
  getEmployees,
  createEmployee,
  updateEmployee,
  getAdvances,
  createAdvance,
  deleteAdvance,
  getAdjustments,
  createAdjustment,
  deleteAdjustment,
  getPayrollSheet,
  confirmPayrollPayout,
  getPayrollHistory,
  revertPayrollRecord,
  toggleAttendance,
  getEmployeeLedger,
};
