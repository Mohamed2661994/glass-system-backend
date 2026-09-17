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
          `سلفة نقدية للعامل: ${emp.name}${notes ? ` - ${notes}` : ""}`,
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
   3. PAYROLL SHEET CALCULATION & PAYOUT (مسير الرواتب وصرف الأسبوعيات والشهريات)
   ========================================================================== */

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

    // 4. Build sheet rows
    const sheetRows = employees.map((emp) => {
      const empAdvances = advancesByEmp[emp.id] || [];
      const totalAdvances = empAdvances.reduce((sum, a) => sum + Number(a.amount || 0), 0);
      const baseSalary = Number(emp.base_salary || 0);

      const paidRecord = paidByEmp[emp.id];
      const isPaid = Boolean(paidRecord);
      const paidNetAmount = isPaid ? Number(paidRecord.net_amount || 0) : Math.max(0, baseSalary - totalAdvances);

      return {
        employee_id: emp.id,
        name: emp.name,
        job_title: emp.job_title,
        salary_type: emp.salary_type,
        base_salary: isPaid ? Number(paidRecord.base_amount || baseSalary) : baseSalary,
        days_worked: isPaid ? Number(paidRecord.days_worked || (emp.salary_type === "daily" ? 6 : 0)) : (emp.salary_type === "daily" ? 6 : 0),
        overtime_amount: isPaid ? Number(paidRecord.overtime_amount || 0) : 0,
        bonus_amount: isPaid ? Number(paidRecord.bonus_amount || 0) : 0,
        deductions_amount: isPaid ? Number(paidRecord.deductions_amount || 0) : 0,
        pending_advances: isPaid ? Number(paidRecord.advances_deducted || 0) : totalAdvances,
        advances_list: isPaid ? [] : empAdvances,
        net_amount: paidNetAmount,
        notes: isPaid ? (paidRecord.notes || "") : "",
        is_paid: isPaid,
        payout_info: isPaid
          ? {
              record_id: paidRecord.id,
              paid_at: paidRecord.paid_at,
              paid_by_name: paidRecord.paid_by_name,
              net_amount: paidNetAmount,
              cash_out_id: paidRecord.cash_out_id,
              permission_number: paidRecord.permission_number,
              cycle_type: paidRecord.cycle_type,
              period_start: paidRecord.period_start,
              period_end: paidRecord.period_end,
              base_amount: Number(paidRecord.base_amount || baseSalary),
              days_worked: Number(paidRecord.days_worked || 0),
              overtime_amount: Number(paidRecord.overtime_amount || 0),
              bonus_amount: Number(paidRecord.bonus_amount || 0),
              deductions_amount: Number(paidRecord.deductions_amount || 0),
              advances_deducted: Number(paidRecord.advances_deducted || 0),
              notes: paidRecord.notes || "",
            }
          : null,
      };
    });

    res.json({
      success: true,
      branch_id: branchId,
      cycle_type: rawCycle,
      period_start: periodStart,
      period_end: periodEnd,
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
      const baseAmount = Number(item.base_amount || 0);
      const daysWorked = Number(item.days_worked || 0);
      const overtimeAmount = Number(item.overtime_amount || 0);
      const bonusAmount = Number(item.bonus_amount || 0);
      const deductionsAmount = Number(item.deductions_amount || 0);
      const advancesDeducted = Number(item.advances_deducted || 0);
      const netAmount = Math.max(
        0,
        Math.round(
          (baseAmount + overtimeAmount + bonusAmount - deductionsAmount - advancesDeducted) * 100,
        ) / 100,
      );

      const itemCycle = item.cycle_type || item.salary_type || cycle_type;

      // 0. Double payout guard: ensure employee has not already been paid for this period with an active cash_out
      const dupCheck = await client.query(
        `
        SELECT pr.id, pr.paid_at 
        FROM payroll_records pr
        LEFT JOIN cash_out co ON pr.cash_out_id = co.id
        WHERE pr.branch_id = $1 AND pr.employee_id = $2 AND pr.payment_status = 'paid'
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

      // 1. Create cash_out voucher if netAmount > 0 and requested
      let cashOutId = null;
      let permissionNumber = null;
      if (record_cash_out && netAmount > 0) {
        permissionNumber = generatePermissionNumber(safeEnd);
        const cashOutRes = await client.query(
          `
          INSERT INTO cash_out 
            (branch_id, name, amount, notes, transaction_date, permission_number, entry_type)
          VALUES ($1, $2, $3, $4, $5, $6, 'expense')
          RETURNING id
          `,
          [
            safeBranchId,
            `راتب: ${item.name || "عامل"}`,
            netAmount,
            `صرف راتب ${itemCycle === "monthly" ? "شهري" : "أسبوعي"} للعامل: ${item.name || ""} - الفترة من ${safeStart} إلى ${safeEnd}${advancesDeducted > 0 ? ` (بعد خصم سلف ${advancesDeducted} ج)` : ""}`,
            safeEnd,
            permissionNumber,
          ],
        );
        cashOutId = cashOutRes.rows[0].id;
        totalCashPaidOut += netAmount;
      }

      // 2. Insert into payroll_records
      const recordRes = await client.query(
        `
        INSERT INTO payroll_records 
          (branch_id, employee_id, cycle_type, period_start, period_end, base_amount, days_worked,
           overtime_amount, bonus_amount, deductions_amount, advances_deducted, net_amount,
           cash_out_id, payment_status, paid_at, paid_by, paid_by_name, notes)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'paid', NOW(), $14, $15, $16)
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
          advancesDeducted,
          netAmount,
          cashOutId,
          user.id || null,
          paidByName,
          item.notes || null,
        ],
      );

      const payrollRecord = recordRes.rows[0];
      createdRecords.push(payrollRecord);

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

module.exports = {
  getEmployees,
  createEmployee,
  updateEmployee,
  getAdvances,
  createAdvance,
  deleteAdvance,
  getPayrollSheet,
  confirmPayrollPayout,
  getPayrollHistory,
  revertPayrollRecord,
};
