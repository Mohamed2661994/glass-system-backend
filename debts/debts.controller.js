const fs = require("fs");
const path = require("path");
const pool = require("../db");

const LOCAL_STORE_FILE = path.join(__dirname, "debts_local_store.json");

// ==========================================
// Local File Fallback for Offline Testing
// ==========================================
function getLocalStore() {
  if (!fs.existsSync(LOCAL_STORE_FILE)) {
    const initial = {
      debts: [
        {
          id: 1,
          title: "قسط سيارة هيونداي توسان",
          creditor_name: "بنك مصر",
          creditor_phone: "19888",
          total_amount: 180000,
          paid_amount: 30000,
          remaining_amount: 150000,
          installment_count: 12,
          installment_amount: 15000,
          frequency: "monthly",
          start_date: "2026-09-01",
          status: "active",
          category: "قرض سيارة",
          notes: "شيكات بنكية مسحوبة أول كل شهر",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        },
        {
          id: 2,
          title: "جمعية الأهل والأصدقاء",
          creditor_name: "م. إبراهيم فؤاد",
          creditor_phone: "01099887766",
          total_amount: 50000,
          paid_amount: 20000,
          remaining_amount: 30000,
          installment_count: 10,
          installment_amount: 5000,
          frequency: "monthly",
          start_date: "2026-08-15",
          status: "active",
          category: "جمعية شخصية",
          notes: "تسليم فودافون كاش أو إنستاباي يوم 15 في الشهر",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }
      ],
      installments: []
    };

    // Auto-generate installments for initial mock
    for (const d of initial.debts) {
      for (let i = 1; i <= d.installment_count; i++) {
        const dDate = new Date(d.start_date);
        dDate.setMonth(dDate.getMonth() + (i - 1));
        const isPaid = (i * d.installment_amount) <= d.paid_amount;
        initial.installments.push({
          id: initial.installments.length + 1,
          debt_id: d.id,
          installment_number: i,
          due_date: dDate.toISOString().split("T")[0],
          amount: d.installment_amount,
          paid_amount: isPaid ? d.installment_amount : 0,
          paid_at: isPaid ? dDate.toISOString() : null,
          status: isPaid ? "paid" : "pending",
          payment_method: isPaid ? "إنستاباي" : "كاش",
          source_type: "personal",
          notes: "",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });
      }
    }

    fs.writeFileSync(LOCAL_STORE_FILE, JSON.stringify(initial, null, 2), "utf8");
    return initial;
  }
  try {
    return JSON.parse(fs.readFileSync(LOCAL_STORE_FILE, "utf8"));
  } catch {
    return { debts: [], installments: [] };
  }
}

function saveLocalStore(store) {
  try {
    fs.writeFileSync(LOCAL_STORE_FILE, JSON.stringify(store, null, 2), "utf8");
  } catch (err) {
    console.error("Failed to save debts local store:", err.message);
  }
}

// ==========================================
// Auto DDL Initialization
// ==========================================
async function initDebtsTables() {
  const sql = `
    CREATE TABLE IF NOT EXISTS external_debts (
      id SERIAL PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      creditor_name VARCHAR(255) NOT NULL,
      creditor_phone VARCHAR(50) DEFAULT '',
      total_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
      paid_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
      remaining_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
      installment_count INTEGER NOT NULL DEFAULT 1,
      installment_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
      frequency VARCHAR(50) NOT NULL DEFAULT 'monthly',
      start_date DATE NOT NULL DEFAULT CURRENT_DATE,
      status VARCHAR(50) NOT NULL DEFAULT 'active',
      category VARCHAR(100) DEFAULT 'عام',
      notes TEXT DEFAULT '',
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS debt_installments (
      id SERIAL PRIMARY KEY,
      debt_id INTEGER NOT NULL REFERENCES external_debts(id) ON DELETE CASCADE,
      installment_number INTEGER NOT NULL,
      due_date DATE NOT NULL,
      amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
      paid_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
      paid_at TIMESTAMP WITH TIME ZONE,
      status VARCHAR(50) NOT NULL DEFAULT 'pending',
      payment_method VARCHAR(100) DEFAULT 'كاش',
      source_type VARCHAR(50) DEFAULT 'personal',
      treasury_tx_id INTEGER,
      notes TEXT DEFAULT '',
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_debt_installments_debt_id ON debt_installments(debt_id);
    CREATE INDEX IF NOT EXISTS idx_debt_installments_due_date ON debt_installments(due_date);
    CREATE INDEX IF NOT EXISTS idx_debt_installments_status ON debt_installments(status);
    CREATE INDEX IF NOT EXISTS idx_external_debts_status ON external_debts(status);
  `;
  try {
    await pool.query(sql);
    console.log("✅ external_debts & debt_installments tables ready");
  } catch (err) {
    console.log("ℹ️ Debts tables init deferred or using local fallback:", err.message);
  }
}

initDebtsTables();

// ==========================================
// Date Math Helper
// ==========================================
function calculateNextDueDate(startDateStr, index, frequency) {
  const d = new Date(startDateStr);
  if (isNaN(d.getTime())) return new Date().toISOString().split("T")[0];

  if (frequency === "daily") {
    d.setDate(d.getDate() + index);
  } else if (frequency === "weekly") {
    d.setDate(d.getDate() + index * 7);
  } else {
    // monthly default
    d.setMonth(d.getMonth() + index);
  }
  return d.toISOString().split("T")[0];
}

// ==========================================
// Controller Methods
// ==========================================

// 1. Summary Statistics (KPI Cards)
exports.getSummary = async (req, res) => {
  try {
    const summaryQuery = `
      SELECT 
        COALESCE(SUM(total_amount), 0) AS total_debts,
        COALESCE(SUM(paid_amount), 0) AS total_paid,
        COALESCE(SUM(remaining_amount), 0) AS total_remaining,
        COUNT(*) FILTER (WHERE status = 'active') AS active_debts_count,
        COUNT(*) FILTER (WHERE status = 'completed') AS completed_debts_count
      FROM external_debts
    `;
    const installmentsQuery = `
      SELECT 
        COUNT(*) FILTER (WHERE status = 'pending' AND due_date < CURRENT_DATE) AS overdue_count,
        COALESCE(SUM(amount - paid_amount) FILTER (WHERE status = 'pending' AND due_date < CURRENT_DATE), 0) AS overdue_amount,
        COALESCE(SUM(amount - paid_amount) FILTER (WHERE status = 'pending' AND due_date >= CURRENT_DATE AND due_date <= CURRENT_DATE + INTERVAL '30 days'), 0) AS upcoming_30_days_amount
      FROM debt_installments
    `;

    const [summaryRes, instRes] = await Promise.all([
      pool.query(summaryQuery),
      pool.query(installmentsQuery)
    ]);

    const s = summaryRes.rows[0];
    const i = instRes.rows[0];

    return res.json({
      total_debts: Number(s.total_debts),
      total_paid: Number(s.total_paid),
      total_remaining: Number(s.total_remaining),
      active_debts_count: Number(s.active_debts_count),
      completed_debts_count: Number(s.completed_debts_count),
      overdue_count: Number(i.overdue_count),
      overdue_amount: Number(i.overdue_amount),
      upcoming_30_days_amount: Number(i.upcoming_30_days_amount)
    });
  } catch (err) {
    // Fallback to local store
    const store = getLocalStore();
    const now = new Date().toISOString().split("T")[0];
    const next30 = new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0];

    let total_debts = 0, total_paid = 0, total_remaining = 0, active_debts_count = 0, completed_debts_count = 0;
    for (const d of store.debts) {
      total_debts += Number(d.total_amount || 0);
      total_paid += Number(d.paid_amount || 0);
      total_remaining += Number(d.remaining_amount || 0);
      if (d.status === "active") active_debts_count++;
      if (d.status === "completed") completed_debts_count++;
    }

    let overdue_count = 0, overdue_amount = 0, upcoming_30_days_amount = 0;
    for (const inst of store.installments) {
      if (inst.status === "pending") {
        const rem = Number(inst.amount) - Number(inst.paid_amount || 0);
        if (inst.due_date < now) {
          overdue_count++;
          overdue_amount += rem;
        } else if (inst.due_date <= next30) {
          upcoming_30_days_amount += rem;
        }
      }
    }

    return res.json({
      total_debts,
      total_paid,
      total_remaining,
      active_debts_count,
      completed_debts_count,
      overdue_count,
      overdue_amount,
      upcoming_30_days_amount
    });
  }
};

// 2. Get All Debts (With Filters)
exports.getDebts = async (req, res) => {
  const { status, search, category } = req.query;
  try {
    let whereClauses = [];
    let params = [];

    if (status && status !== "all") {
      params.push(status);
      whereClauses.push(`d.status = $${params.length}`);
    }
    if (category && category !== "all") {
      params.push(category);
      whereClauses.push(`d.category = $${params.length}`);
    }
    if (search) {
      params.push(`%${search.trim()}%`);
      whereClauses.push(`(d.title ILIKE $${params.length} OR d.creditor_name ILIKE $${params.length} OR d.creditor_phone ILIKE $${params.length})`);
    }

    const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

    const query = `
      SELECT 
        d.*,
        (
          SELECT MIN(due_date) 
          FROM debt_installments i 
          WHERE i.debt_id = d.id AND i.status = 'pending'
        ) AS next_due_date,
        (
          SELECT COUNT(*) 
          FROM debt_installments i 
          WHERE i.debt_id = d.id AND i.status = 'paid'
        ) AS paid_installments_count
      FROM external_debts d
      ${whereStr}
      ORDER BY 
        CASE WHEN d.status = 'active' THEN 1 ELSE 2 END,
        d.id DESC
    `;

    const result = await pool.query(query, params);
    const debts = result.rows.map(d => ({
      ...d,
      total_amount: Number(d.total_amount),
      paid_amount: Number(d.paid_amount),
      remaining_amount: Number(d.remaining_amount),
      installment_amount: Number(d.installment_amount),
      paid_installments_count: Number(d.paid_installments_count || 0),
      progress_percent: d.total_amount > 0 ? Math.min(100, Math.round((d.paid_amount / d.total_amount) * 100)) : 0
    }));

    return res.json(debts);
  } catch (err) {
    // Local fallback
    const store = getLocalStore();
    let filtered = store.debts;

    if (status && status !== "all") {
      filtered = filtered.filter(d => d.status === status);
    }
    if (category && category !== "all") {
      filtered = filtered.filter(d => d.category === category);
    }
    if (search) {
      const q = search.toLowerCase();
      filtered = filtered.filter(d => 
        (d.title && d.title.toLowerCase().includes(q)) ||
        (d.creditor_name && d.creditor_name.toLowerCase().includes(q)) ||
        (d.creditor_phone && d.creditor_phone.includes(q))
      );
    }

    const debts = filtered.map(d => {
      const debtInsts = store.installments.filter(i => i.debt_id === d.id);
      const pendingInsts = debtInsts.filter(i => i.status === "pending").sort((a,b) => a.due_date.localeCompare(b.due_date));
      const paidInsts = debtInsts.filter(i => i.status === "paid");

      return {
        ...d,
        total_amount: Number(d.total_amount),
        paid_amount: Number(d.paid_amount),
        remaining_amount: Number(d.remaining_amount),
        installment_amount: Number(d.installment_amount),
        next_due_date: pendingInsts.length > 0 ? pendingInsts[0].due_date : null,
        paid_installments_count: paidInsts.length,
        progress_percent: d.total_amount > 0 ? Math.min(100, Math.round((d.paid_amount / d.total_amount) * 100)) : 0
      };
    });

    return res.json(debts);
  }
};

// 3. Get Single Debt with All Installments
exports.getDebtById = async (req, res) => {
  const { id } = req.params;
  try {
    const debtRes = await pool.query(`SELECT * FROM external_debts WHERE id = $1`, [id]);
    if (debtRes.rows.length === 0) {
      return res.status(404).json({ error: "المديونية غير موجودة" });
    }

    const instRes = await pool.query(
      `SELECT * FROM debt_installments WHERE debt_id = $1 ORDER BY installment_number ASC`,
      [id]
    );

    const debt = debtRes.rows[0];
    debt.total_amount = Number(debt.total_amount);
    debt.paid_amount = Number(debt.paid_amount);
    debt.remaining_amount = Number(debt.remaining_amount);
    debt.installment_amount = Number(debt.installment_amount);
    debt.installments = instRes.rows.map(i => ({
      ...i,
      amount: Number(i.amount),
      paid_amount: Number(i.paid_amount)
    }));

    return res.json(debt);
  } catch (err) {
    const store = getLocalStore();
    const debt = store.debts.find(d => d.id === Number(id));
    if (!debt) return res.status(404).json({ error: "المديونية غير موجودة" });

    const installments = store.installments
      .filter(i => i.debt_id === Number(id))
      .sort((a,b) => a.installment_number - b.installment_number)
      .map(i => ({ ...i, amount: Number(i.amount), paid_amount: Number(i.paid_amount) }));

    return res.json({
      ...debt,
      total_amount: Number(debt.total_amount),
      paid_amount: Number(debt.paid_amount),
      remaining_amount: Number(debt.remaining_amount),
      installment_amount: Number(debt.installment_amount),
      installments
    });
  }
};

// 4. Create New Debt & Auto-Generate Installments
exports.createDebt = async (req, res) => {
  const {
    title,
    creditor_name,
    creditor_phone = "",
    total_amount,
    installment_count = 1,
    frequency = "monthly",
    start_date,
    category = "عام",
    notes = ""
  } = req.body;

  if (!title || !creditor_name || !total_amount || Number(total_amount) <= 0) {
    return res.status(400).json({ error: "يرجى ملء البيانات الأساسية: اسم المديونية، اسم الدائن، وإجمالي المبلغ" });
  }

  const numTotal = Number(total_amount);
  const count = Math.max(1, parseInt(installment_count, 10) || 1);
  const baseInstallment = Math.floor((numTotal / count) * 100) / 100;
  const remainder = Math.round((numTotal - baseInstallment * count) * 100) / 100;
  const startDate = start_date || new Date().toISOString().split("T")[0];

  const client = await pool.connect().catch(() => null);

  if (client) {
    try {
      await client.query("BEGIN");

      const insertDebtSql = `
        INSERT INTO external_debts (
          title, creditor_name, creditor_phone, total_amount, paid_amount, remaining_amount,
          installment_count, installment_amount, frequency, start_date, status, category, notes
        ) VALUES ($1, $2, $3, $4, 0, $4, $5, $6, $7, $8, 'active', $9, $10)
        RETURNING *
      `;
      const debtRes = await client.query(insertDebtSql, [
        title.trim(),
        creditor_name.trim(),
        creditor_phone.trim(),
        numTotal,
        count,
        baseInstallment,
        frequency,
        startDate,
        category || "عام",
        notes || ""
      ]);

      const newDebt = debtRes.rows[0];

      // Insert Installments
      for (let i = 1; i <= count; i++) {
        const dueDate = calculateNextDueDate(startDate, i - 1, frequency);
        const instAmount = i === count ? baseInstallment + remainder : baseInstallment;

        await client.query(
          `INSERT INTO debt_installments (debt_id, installment_number, due_date, amount, paid_amount, status)
           VALUES ($1, $2, $3, $4, 0, 'pending')`,
          [newDebt.id, i, dueDate, instAmount]
        );
      }

      await client.query("COMMIT");
      return res.status(201).json({ success: true, debt: newDebt });
    } catch (err) {
      await client.query("ROLLBACK");
      return res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  } else {
    // Local fallback
    const store = getLocalStore();
    const newDebtId = store.debts.length > 0 ? Math.max(...store.debts.map(d => d.id)) + 1 : 1;

    const newDebt = {
      id: newDebtId,
      title: title.trim(),
      creditor_name: creditor_name.trim(),
      creditor_phone: creditor_phone.trim(),
      total_amount: numTotal,
      paid_amount: 0,
      remaining_amount: numTotal,
      installment_count: count,
      installment_amount: baseInstallment,
      frequency,
      start_date: startDate,
      status: "active",
      category: category || "عام",
      notes: notes || "",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    store.debts.push(newDebt);

    let nextInstId = store.installments.length > 0 ? Math.max(...store.installments.map(i => i.id)) + 1 : 1;
    for (let i = 1; i <= count; i++) {
      const dueDate = calculateNextDueDate(startDate, i - 1, frequency);
      const instAmount = i === count ? baseInstallment + remainder : baseInstallment;

      store.installments.push({
        id: nextInstId++,
        debt_id: newDebtId,
        installment_number: i,
        due_date: dueDate,
        amount: instAmount,
        paid_amount: 0,
        paid_at: null,
        status: "pending",
        payment_method: "كاش",
        source_type: "personal",
        notes: "",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
    }

    saveLocalStore(store);
    return res.status(201).json({ success: true, debt: newDebt });
  }
};

// 5. Update Debt
exports.updateDebt = async (req, res) => {
  const { id } = req.params;
  const {
    title,
    creditor_name,
    creditor_phone,
    total_amount,
    installment_count,
    frequency,
    start_date,
    category,
    notes,
    status
  } = req.body;

  const client = await pool.connect().catch(() => null);

  if (client) {
    try {
      await client.query("BEGIN");
      const currentRes = await client.query(`SELECT * FROM external_debts WHERE id = $1 FOR UPDATE`, [id]);
      if (currentRes.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "المديونية غير موجودة" });
      }

      const current = currentRes.rows[0];
      const newTitle = title !== undefined ? title.trim() : current.title;
      const newCreditorName = creditor_name !== undefined ? creditor_name.trim() : current.creditor_name;
      const newCreditorPhone = creditor_phone !== undefined ? creditor_phone.trim() : current.creditor_phone;
      const newCategory = category !== undefined ? category : current.category;
      const newNotes = notes !== undefined ? notes : current.notes;
      const newStatus = status !== undefined ? status : current.status;

      let newTotal = total_amount !== undefined && Number(total_amount) > 0 ? Number(total_amount) : Number(current.total_amount);
      let newCount = installment_count !== undefined && parseInt(installment_count, 10) > 0 ? parseInt(installment_count, 10) : Number(current.installment_count);
      let newFrequency = frequency !== undefined ? frequency : current.frequency;
      let newStartDate = start_date !== undefined ? start_date : current.start_date;

      const currentPaid = Number(current.paid_amount || 0);

      // If no payments yet, allow full recalculation of installments
      const recalculateSchedule =
        currentPaid === 0 &&
        (total_amount !== undefined || installment_count !== undefined || frequency !== undefined || start_date !== undefined);

      if (recalculateSchedule) {
        const baseInstallment = Math.floor((newTotal / newCount) * 100) / 100;
        const remainder = Math.round((newTotal - baseInstallment * newCount) * 100) / 100;

        await client.query(
          `UPDATE external_debts
           SET title = $1, creditor_name = $2, creditor_phone = $3, category = $4, notes = $5, status = $6,
               total_amount = $7, remaining_amount = $7, installment_count = $8, installment_amount = $9,
               frequency = $10, start_date = $11, updated_at = NOW()
           WHERE id = $12`,
          [
            newTitle, newCreditorName, newCreditorPhone, newCategory, newNotes, newStatus,
            newTotal, newCount, baseInstallment, newFrequency, newStartDate, id
          ]
        );

        // Remove old pending installments and re-generate
        await client.query(`DELETE FROM debt_installments WHERE debt_id = $1 AND status != 'paid'`, [id]);
        for (let i = 1; i <= newCount; i++) {
          const dueDate = calculateNextDueDate(newStartDate, i - 1, newFrequency);
          const instAmount = i === newCount ? baseInstallment + remainder : baseInstallment;
          await client.query(
            `INSERT INTO debt_installments (debt_id, installment_number, due_date, amount, paid_amount, status)
             VALUES ($1, $2, $3, $4, 0, 'pending')`,
            [id, i, dueDate, instAmount]
          );
        }
      } else {
        // If payments already exist, ensure total_amount >= currentPaid
        if (newTotal < currentPaid) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: `إجمالي المبلغ لا يمكن أن يكون أقل من المبلغ المسدد بالفعل (${currentPaid.toLocaleString()} ج)` });
        }
        const newRemaining = Math.max(0, newTotal - currentPaid);
        await client.query(
          `UPDATE external_debts
           SET title = $1, creditor_name = $2, creditor_phone = $3, category = $4, notes = $5, status = $6,
               total_amount = $7, remaining_amount = $8, start_date = COALESCE($9, start_date), updated_at = NOW()
           WHERE id = $10`,
          [
            newTitle, newCreditorName, newCreditorPhone, newCategory, newNotes, newStatus,
            newTotal, newRemaining, start_date || null, id
          ]
        );

        // If start_date was updated and there are pending installments, shift their due dates
        if (start_date) {
          const pendingInsts = await client.query(
            `SELECT id, installment_number FROM debt_installments 
             WHERE debt_id = $1 AND status != 'paid' 
             ORDER BY installment_number ASC`,
            [id]
          );

          for (let idx = 0; idx < pendingInsts.rows.length; idx++) {
            const instRow = pendingInsts.rows[idx];
            const newInstDueDate = calculateNextDueDate(start_date, idx, newFrequency);
            await client.query(
              `UPDATE debt_installments SET due_date = $1, updated_at = NOW() WHERE id = $2`,
              [newInstDueDate, instRow.id]
            );
          }
        }
      }

      await client.query("COMMIT");
      const updatedRes = await client.query(`SELECT * FROM external_debts WHERE id = $1`, [id]);
      return res.json({ success: true, debt: updatedRes.rows[0] });
    } catch (err) {
      await client.query("ROLLBACK");
      return res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  } else {
    const store = getLocalStore();
    const debt = store.debts.find(d => d.id === Number(id));
    if (!debt) return res.status(404).json({ error: "المديونية غير موجودة" });

    if (title) debt.title = title.trim();
    if (creditor_name) debt.creditor_name = creditor_name.trim();
    if (creditor_phone !== undefined) debt.creditor_phone = creditor_phone.trim();
    if (category) debt.category = category;
    if (notes !== undefined) debt.notes = notes;
    if (status) debt.status = status;

    const currentPaid = Number(debt.paid_amount || 0);
    if (total_amount !== undefined && Number(total_amount) > 0) {
      const newTotal = Number(total_amount);
      if (newTotal < currentPaid) {
        return res.status(400).json({ error: `إجمالي المبلغ لا يمكن أن يكون أقل من المبلغ المسدد بالفعل (${currentPaid.toLocaleString()} ج)` });
      }
      debt.total_amount = newTotal;
      debt.remaining_amount = newTotal - currentPaid;
    }

    if (currentPaid === 0 && (installment_count || frequency || start_date)) {
      if (installment_count) debt.installment_count = parseInt(installment_count, 10);
      if (frequency) debt.frequency = frequency;
      if (start_date) debt.start_date = start_date;
      debt.installment_amount = Math.floor((debt.total_amount / debt.installment_count) * 100) / 100;
      
      store.installments = store.installments.filter(i => i.debt_id !== Number(id) || i.status === "paid");
      let nextInstId = store.installments.length > 0 ? Math.max(...store.installments.map(i => i.id)) + 1 : 1;
      const baseInstallment = debt.installment_amount;
      const remainder = Math.round((debt.total_amount - baseInstallment * debt.installment_count) * 100) / 100;

      for (let i = 1; i <= debt.installment_count; i++) {
        const dueDate = calculateNextDueDate(debt.start_date, i - 1, debt.frequency);
        const instAmount = i === debt.installment_count ? baseInstallment + remainder : baseInstallment;
        store.installments.push({
          id: nextInstId++,
          debt_id: Number(id),
          installment_number: i,
          due_date: dueDate,
          amount: instAmount,
          paid_amount: 0,
          paid_at: null,
          status: "pending",
          payment_method: "كاش",
          source_type: "personal",
          notes: "",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });
      }
    } else if (currentPaid > 0 && start_date) {
      debt.start_date = start_date;
      const pendingInsts = store.installments
        .filter(i => i.debt_id === Number(id) && i.status !== "paid")
        .sort((a, b) => a.installment_number - b.installment_number);

      pendingInsts.forEach((inst, idx) => {
        inst.due_date = calculateNextDueDate(start_date, idx, debt.frequency);
        inst.updated_at = new Date().toISOString();
      });
    }

    debt.updated_at = new Date().toISOString();
    saveLocalStore(store);
    return res.json({ success: true, debt });
  }
};

// 6. Delete Debt
exports.deleteDebt = async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query(`DELETE FROM external_debts WHERE id = $1`, [id]);
    return res.json({ success: true, message: "تم حذف المديونية وأقساطها بنجاح" });
  } catch (err) {
    const store = getLocalStore();
    store.debts = store.debts.filter(d => d.id !== Number(id));
    store.installments = store.installments.filter(i => i.debt_id !== Number(id));
    saveLocalStore(store);
    return res.json({ success: true, message: "تم حذف المديونية وأقساطها بنجاح" });
  }
};

// 6.5 Update Single Installment
exports.updateInstallment = async (req, res) => {
  const { id } = req.params;
  const { due_date, amount, paid_amount, payment_method, notes } = req.body;

  const client = await pool.connect().catch(() => null);
  if (client) {
    try {
      await client.query("BEGIN");
      const currentRes = await client.query(`SELECT * FROM debt_installments WHERE id = $1 FOR UPDATE`, [id]);
      if (currentRes.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "القسط غير موجود" });
      }

      const current = currentRes.rows[0];
      const newDueDate = due_date || current.due_date;
      const newAmount = amount !== undefined && Number(amount) > 0 ? Number(amount) : Number(current.amount);
      const newPaidAmount = paid_amount !== undefined ? Math.max(0, Number(paid_amount)) : Number(current.paid_amount || 0);
      const newPaymentMethod = payment_method !== undefined ? payment_method : current.payment_method;
      const newNotes = notes !== undefined ? notes : current.notes;

      let newStatus = current.status;
      if (newPaidAmount >= newAmount) {
        newStatus = "paid";
      } else if (newPaidAmount > 0) {
        newStatus = "partially_paid";
      } else {
        newStatus = "pending";
      }

      const updateSql = `
        UPDATE debt_installments
        SET 
          due_date = $1,
          amount = $2,
          paid_amount = $3,
          status = $4,
          payment_method = $5,
          notes = $6,
          paid_at = CASE WHEN $3 > 0 THEN COALESCE(paid_at, NOW()) ELSE NULL END,
          updated_at = NOW()
        WHERE id = $7
        RETURNING *
      `;
      const result = await client.query(updateSql, [
        newDueDate,
        newAmount,
        newPaidAmount,
        newStatus,
        newPaymentMethod,
        newNotes,
        id
      ]);

      // Recalculate parent debt
      const debtId = current.debt_id;
      const sumRes = await client.query(
        `SELECT COALESCE(SUM(paid_amount), 0) as total_paid FROM debt_installments WHERE debt_id = $1`,
        [debtId]
      );
      const totalPaid = Number(sumRes.rows[0].total_paid);
      const debtRes = await client.query(`SELECT total_amount FROM external_debts WHERE id = $1`, [debtId]);
      const totalAmount = Number(debtRes.rows[0]?.total_amount || 0);
      const remainingAmount = Math.max(0, totalAmount - totalPaid);
      const debtStatus = remainingAmount <= 0 ? "completed" : "active";

      await client.query(
        `UPDATE external_debts SET paid_amount = $1, remaining_amount = $2, status = $3, updated_at = NOW() WHERE id = $4`,
        [totalPaid, remainingAmount, debtStatus, debtId]
      );

      await client.query("COMMIT");
      return res.json({ success: true, installment: result.rows[0] });
    } catch (err) {
      await client.query("ROLLBACK");
      return res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  } else {
    const store = getLocalStore();
    const inst = store.installments.find(i => i.id === Number(id));
    if (!inst) return res.status(404).json({ error: "القسط غير موجود" });

    if (due_date) inst.due_date = due_date;
    if (amount !== undefined && Number(amount) > 0) inst.amount = Number(amount);
    if (paid_amount !== undefined) inst.paid_amount = Math.max(0, Number(paid_amount));
    if (payment_method !== undefined) inst.payment_method = payment_method;
    if (notes !== undefined) inst.notes = notes;

    if (inst.paid_amount >= inst.amount) {
      inst.status = "paid";
    } else if (inst.paid_amount > 0) {
      inst.status = "partially_paid";
    } else {
      inst.status = "pending";
    }
    inst.updated_at = new Date().toISOString();

    const parentDebt = store.debts.find(d => d.id === inst.debt_id);
    if (parentDebt) {
      const allInsts = store.installments.filter(i => i.debt_id === parentDebt.id);
      const sumPaid = allInsts.reduce((sum, i) => sum + Number(i.paid_amount || 0), 0);
      parentDebt.paid_amount = sumPaid;
      parentDebt.remaining_amount = Math.max(0, Number(parentDebt.total_amount) - sumPaid);
      parentDebt.status = parentDebt.remaining_amount <= 0 ? "completed" : "active";
    }

    saveLocalStore(store);
    return res.json({ success: true, installment: inst });
  }
};

// 6.6 Delete Single Installment
exports.deleteInstallment = async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect().catch(() => null);

  if (client) {
    try {
      await client.query("BEGIN");
      const instRes = await client.query(`SELECT debt_id FROM debt_installments WHERE id = $1`, [id]);
      if (instRes.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "القسط غير موجود" });
      }
      const debtId = instRes.rows[0].debt_id;

      await client.query(`DELETE FROM debt_installments WHERE id = $1`, [id]);

      // Recalculate parent debt
      const sumRes = await client.query(
        `SELECT COALESCE(SUM(paid_amount), 0) as total_paid, COUNT(*) as inst_count FROM debt_installments WHERE debt_id = $1`,
        [debtId]
      );
      const totalPaid = Number(sumRes.rows[0].total_paid);
      const instCount = Number(sumRes.rows[0].inst_count);

      const debtRes = await client.query(`SELECT total_amount FROM external_debts WHERE id = $1`, [debtId]);
      const totalAmount = Number(debtRes.rows[0]?.total_amount || 0);
      const remainingAmount = Math.max(0, totalAmount - totalPaid);
      const debtStatus = remainingAmount <= 0 ? "completed" : "active";

      await client.query(
        `UPDATE external_debts 
         SET paid_amount = $1, remaining_amount = $2, installment_count = $3, status = $4, updated_at = NOW() 
         WHERE id = $5`,
        [totalPaid, remainingAmount, instCount, debtStatus, debtId]
      );

      await client.query("COMMIT");
      return res.json({ success: true, message: "تم حذف القسط بنجاح" });
    } catch (err) {
      await client.query("ROLLBACK");
      return res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  } else {
    const store = getLocalStore();
    const instIndex = store.installments.findIndex(i => i.id === Number(id));
    if (instIndex === -1) return res.status(404).json({ error: "القسط غير موجود" });
    const debtId = store.installments[instIndex].debt_id;
    store.installments.splice(instIndex, 1);

    const parentDebt = store.debts.find(d => d.id === debtId);
    if (parentDebt) {
      const remainingInsts = store.installments.filter(i => i.debt_id === debtId);
      const totalPaid = remainingInsts.reduce((sum, i) => sum + Number(i.paid_amount || 0), 0);
      parentDebt.paid_amount = totalPaid;
      parentDebt.remaining_amount = Math.max(0, Number(parentDebt.total_amount) - totalPaid);
      parentDebt.installment_count = remainingInsts.length;
      parentDebt.status = parentDebt.remaining_amount <= 0 ? "completed" : "active";
    }

    saveLocalStore(store);
    return res.json({ success: true, message: "تم حذف القسط بنجاح" });
  }
};

// 7. Pay Installment
exports.payInstallment = async (req, res) => {
  const { id } = req.params;
  const {
    paid_amount,
    payment_method = "كاش",
    source_type = "personal", // 'personal' or 'treasury'
    branch_id = 1,
    notes = ""
  } = req.body;

  const client = await pool.connect().catch(() => null);

  if (client) {
    try {
      await client.query("BEGIN");

      const instRes = await client.query(`SELECT * FROM debt_installments WHERE id = $1 FOR UPDATE`, [id]);
      if (instRes.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "القسط غير موجود" });
      }

      const inst = instRes.rows[0];
      const debtId = inst.debt_id;
      const amountDue = Number(inst.amount) - Number(inst.paid_amount);
      const paymentAmount = paid_amount ? Number(paid_amount) : amountDue;

      if (paymentAmount <= 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "قيمة السداد يجب أن تكون أكبر من صفر" });
      }

      const newPaidAmount = Number(inst.paid_amount) + paymentAmount;
      const isFullyPaid = newPaidAmount >= Number(inst.amount);
      const newStatus = isFullyPaid ? "paid" : "partially_paid";

      let treasuryTxId = null;
      if (source_type === "treasury") {
        // Optional treasury integration: record cash_out under 'مسحوبات شخصية'
        try {
          const cashRes = await client.query(
            `INSERT INTO cash_out (branch_id, amount, category, description, created_at)
             VALUES ($1, $2, 'مسحوبات شخصية', $3, NOW()) RETURNING id`,
            [branch_id, paymentAmount, `سداد قسط رقم ${inst.installment_number} للمديونية (#${debtId})`]
          );
          treasuryTxId = cashRes.rows[0]?.id || null;
        } catch (cErr) {
          console.warn("Could not insert cash_out for treasury debt payment:", cErr.message);
        }
      }

      await client.query(
        `UPDATE debt_installments
         SET paid_amount = $1, paid_at = NOW(), status = $2, payment_method = $3, source_type = $4, treasury_tx_id = $5, notes = $6, updated_at = NOW()
         WHERE id = $7`,
        [newPaidAmount, newStatus, payment_method, source_type, treasuryTxId, notes || inst.notes || "", id]
      );

      // Recalculate parent debt
      const sumRes = await client.query(
        `SELECT COALESCE(SUM(paid_amount), 0) as total_paid FROM debt_installments WHERE debt_id = $1`,
        [debtId]
      );
      const totalPaid = Number(sumRes.rows[0].total_paid);

      const debtRes = await client.query(`SELECT total_amount FROM external_debts WHERE id = $1`, [debtId]);
      const totalAmount = Number(debtRes.rows[0]?.total_amount || 0);
      const remainingAmount = Math.max(0, totalAmount - totalPaid);
      const debtStatus = remainingAmount <= 0 ? "completed" : "active";

      await client.query(
        `UPDATE external_debts SET paid_amount = $1, remaining_amount = $2, status = $3, updated_at = NOW() WHERE id = $4`,
        [totalPaid, remainingAmount, debtStatus, debtId]
      );

      await client.query("COMMIT");
      return res.json({ success: true, message: "تم تسجيل السداد بنجاح", installment_id: id, new_status: newStatus });
    } catch (err) {
      await client.query("ROLLBACK");
      return res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  } else {
    // Local fallback
    const store = getLocalStore();
    const inst = store.installments.find(i => i.id === Number(id));
    if (!inst) return res.status(404).json({ error: "القسط غير موجود" });

    const amountDue = Number(inst.amount) - Number(inst.paid_amount || 0);
    const paymentAmount = paid_amount ? Number(paid_amount) : amountDue;

    inst.paid_amount = Number(inst.paid_amount || 0) + paymentAmount;
    inst.paid_at = new Date().toISOString();
    inst.status = inst.paid_amount >= Number(inst.amount) ? "paid" : "partially_paid";
    inst.payment_method = payment_method;
    inst.source_type = source_type;
    if (notes) inst.notes = notes;
    inst.updated_at = new Date().toISOString();

    // Recalculate parent debt
    const parentDebt = store.debts.find(d => d.id === inst.debt_id);
    if (parentDebt) {
      const allInsts = store.installments.filter(i => i.debt_id === parentDebt.id);
      const sumPaid = allInsts.reduce((sum, i) => sum + Number(i.paid_amount || 0), 0);
      parentDebt.paid_amount = sumPaid;
      parentDebt.remaining_amount = Math.max(0, Number(parentDebt.total_amount) - sumPaid);
      parentDebt.status = parentDebt.remaining_amount <= 0 ? "completed" : "active";
      parentDebt.updated_at = new Date().toISOString();
    }

    saveLocalStore(store);
    return res.json({ success: true, message: "تم تسجيل السداد بنجاح", installment_id: id, new_status: inst.status });
  }
};

// 8. Revert / Unpay Installment
exports.unpayInstallment = async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect().catch(() => null);

  if (client) {
    try {
      await client.query("BEGIN");
      const instRes = await client.query(`SELECT * FROM debt_installments WHERE id = $1`, [id]);
      if (instRes.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "القسط غير موجود" });
      }

      const inst = instRes.rows[0];
      const debtId = inst.debt_id;

      await client.query(
        `UPDATE debt_installments 
         SET paid_amount = 0, paid_at = NULL, status = 'pending', updated_at = NOW() 
         WHERE id = $1`,
        [id]
      );

      // Recalculate parent debt
      const sumRes = await client.query(
        `SELECT COALESCE(SUM(paid_amount), 0) as total_paid FROM debt_installments WHERE debt_id = $1`,
        [debtId]
      );
      const totalPaid = Number(sumRes.rows[0].total_paid);
      const debtRes = await client.query(`SELECT total_amount FROM external_debts WHERE id = $1`, [debtId]);
      const totalAmount = Number(debtRes.rows[0]?.total_amount || 0);
      const remainingAmount = Math.max(0, totalAmount - totalPaid);

      await client.query(
        `UPDATE external_debts SET paid_amount = $1, remaining_amount = $2, status = 'active', updated_at = NOW() WHERE id = $3`,
        [totalPaid, remainingAmount, debtId]
      );

      await client.query("COMMIT");
      return res.json({ success: true, message: "تم إلغاء السداد وإعادة القسط إلى معلق" });
    } catch (err) {
      await client.query("ROLLBACK");
      return res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  } else {
    const store = getLocalStore();
    const inst = store.installments.find(i => i.id === Number(id));
    if (!inst) return res.status(404).json({ error: "القسط غير موجود" });

    inst.paid_amount = 0;
    inst.paid_at = null;
    inst.status = "pending";
    inst.updated_at = new Date().toISOString();

    const parentDebt = store.debts.find(d => d.id === inst.debt_id);
    if (parentDebt) {
      const allInsts = store.installments.filter(i => i.debt_id === parentDebt.id);
      const sumPaid = allInsts.reduce((sum, i) => sum + Number(i.paid_amount || 0), 0);
      parentDebt.paid_amount = sumPaid;
      parentDebt.remaining_amount = Math.max(0, Number(parentDebt.total_amount) - sumPaid);
      parentDebt.status = "active";
      parentDebt.updated_at = new Date().toISOString();
    }

    saveLocalStore(store);
    return res.json({ success: true, message: "تم إلغاء السداد وإعادة القسط إلى معلق" });
  }
};

// 9. Get Upcoming / Overdue Installments Timeline
exports.getUpcoming = async (req, res) => {
  try {
    const query = `
      SELECT 
        i.*,
        d.title as debt_title,
        d.creditor_name,
        d.creditor_phone,
        d.category as debt_category
      FROM debt_installments i
      JOIN external_debts d ON i.debt_id = d.id
      WHERE i.status = 'pending' AND i.due_date <= CURRENT_DATE + INTERVAL '30 days'
      ORDER BY i.due_date ASC
      LIMIT 50
    `;
    const result = await pool.query(query);
    const list = result.rows.map(r => ({
      ...r,
      amount: Number(r.amount),
      paid_amount: Number(r.paid_amount),
      is_overdue: new Date(r.due_date) < new Date(new Date().toISOString().split("T")[0])
    }));
    return res.json(list);
  } catch (err) {
    const store = getLocalStore();
    const now = new Date().toISOString().split("T")[0];
    const next30 = new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0];

    const upcoming = store.installments
      .filter(i => i.status === "pending" && i.due_date <= next30)
      .sort((a,b) => a.due_date.localeCompare(b.due_date))
      .map(i => {
        const d = store.debts.find(x => x.id === i.debt_id) || {};
        return {
          ...i,
          amount: Number(i.amount),
          paid_amount: Number(i.paid_amount),
          debt_title: d.title || "",
          creditor_name: d.creditor_name || "",
          creditor_phone: d.creditor_phone || "",
          debt_category: d.category || "عام",
          is_overdue: i.due_date < now
        };
      });

    return res.json(upcoming);
  }
};

// 10. Get Active Debts Lookup (Accessible for Cash Out & Selectors)
exports.getActiveList = async (req, res) => {
  try {
    const query = `
      SELECT 
        d.id,
        d.title,
        d.creditor_name,
        d.creditor_phone,
        d.total_amount,
        d.paid_amount,
        d.remaining_amount,
        d.installment_count,
        d.installment_amount,
        d.frequency,
        d.status,
        d.category,
        (
          SELECT json_agg(
            json_build_object(
              'id', i.id,
              'installment_number', i.installment_number,
              'due_date', i.due_date,
              'amount', i.amount,
              'paid_amount', i.paid_amount,
              'status', i.status
            ) ORDER BY i.installment_number ASC
          )
          FROM debt_installments i
          WHERE i.debt_id = d.id AND i.status != 'paid'
        ) as pending_installments
      FROM external_debts d
      WHERE d.status != 'completed'
      ORDER BY d.id ASC
    `;
    const result = await pool.query(query);
    return res.json(
      result.rows.map(r => ({
        ...r,
        total_amount: Number(r.total_amount),
        paid_amount: Number(r.paid_amount),
        remaining_amount: Number(r.remaining_amount),
        installment_amount: Number(r.installment_amount),
        pending_installments: (r.pending_installments || []).map(i => ({
          ...i,
          amount: Number(i.amount),
          paid_amount: Number(i.paid_amount)
        }))
      }))
    );
  } catch (err) {
    const store = getLocalStore();
    const list = store.debts
      .filter(d => d.status !== 'completed')
      .map(d => {
        const pInst = store.installments
          .filter(i => i.debt_id === d.id && i.status !== 'paid')
          .sort((a, b) => a.installment_number - b.installment_number);
        return {
          ...d,
          total_amount: Number(d.total_amount),
          paid_amount: Number(d.paid_amount),
          remaining_amount: Number(d.remaining_amount),
          installment_amount: Number(d.installment_amount),
          pending_installments: pInst.map(i => ({
            ...i,
            amount: Number(i.amount),
            paid_amount: Number(i.paid_amount)
          }))
        };
      });
    return res.json(list);
  }
};

// 11. Helper: Record Debt Payment from Cash Out
exports.recordDebtPaymentFromCashOut = async ({
  client = pool,
  cashOutId,
  debtId,
  installmentId,
  amount,
  date,
  permissionNumber,
  notes
}) => {
  if (!debtId || !amount || Number(amount) <= 0) return null;
  const paymentAmount = Number(amount);

  try {
    if (installmentId) {
      // Specific installment chosen
      const instRes = await client.query('SELECT * FROM debt_installments WHERE id = $1', [installmentId]);
      if (instRes.rows.length > 0) {
        const inst = instRes.rows[0];
        const newPaid = Number(inst.paid_amount || 0) + paymentAmount;
        const newStatus = newPaid >= Number(inst.amount) ? 'paid' : 'partially_paid';
        await client.query(
          `UPDATE debt_installments
           SET paid_amount = $1, paid_at = $2, status = $3, payment_method = 'خزينة المحل', source_type = 'treasury', treasury_tx_id = $4, notes = $5, updated_at = NOW()
           WHERE id = $6`,
          [
            newPaid,
            date || new Date().toISOString().split('T')[0],
            newStatus,
            cashOutId,
            (inst.notes ? inst.notes + ' | ' : '') + `إذن صرف #${permissionNumber || cashOutId}`,
            installmentId
          ]
        );
      }
    } else {
      // Allocate payment automatically to pending installments in chronological order
      const instsRes = await client.query(
        `SELECT * FROM debt_installments 
         WHERE debt_id = $1 AND status != 'paid' 
         ORDER BY installment_number ASC, due_date ASC`,
        [debtId]
      );

      let remainingPayment = paymentAmount;
      for (const inst of instsRes.rows) {
        if (remainingPayment <= 0) break;
        const needed = Number(inst.amount) - Number(inst.paid_amount || 0);
        const payNow = Math.min(remainingPayment, needed);
        const newPaid = Number(inst.paid_amount || 0) + payNow;
        const newStatus = newPaid >= Number(inst.amount) ? 'paid' : 'partially_paid';

        await client.query(
          `UPDATE debt_installments
           SET paid_amount = $1, paid_at = $2, status = $3, payment_method = 'خزينة المحل', source_type = 'treasury', treasury_tx_id = $4, notes = $5, updated_at = NOW()
           WHERE id = $6`,
          [
            newPaid,
            date || new Date().toISOString().split('T')[0],
            newStatus,
            cashOutId,
            (inst.notes ? inst.notes + ' | ' : '') + `إذن صرف #${permissionNumber || cashOutId}`,
            inst.id
          ]
        );

        remainingPayment -= payNow;
      }
    }

    // Recalculate parent debt
    const sumRes = await client.query(
      `SELECT COALESCE(SUM(paid_amount), 0) as total_paid FROM debt_installments WHERE debt_id = $1`,
      [debtId]
    );
    const totalPaid = Number(sumRes.rows[0]?.total_paid || 0);
    const debtRes = await client.query(`SELECT total_amount FROM external_debts WHERE id = $1`, [debtId]);
    const totalAmount = Number(debtRes.rows[0]?.total_amount || 0);
    const newRemaining = Math.max(0, totalAmount - totalPaid);
    const newDebtStatus = newRemaining <= 0 ? 'completed' : 'active';

    await client.query(
      `UPDATE external_debts
       SET paid_amount = $1, remaining_amount = $2, status = $3, updated_at = NOW()
       WHERE id = $4`,
      [totalPaid, newRemaining, newDebtStatus, debtId]
    );

    return { success: true, debtId, totalPaid, newRemaining, status: newDebtStatus };
  } catch (err) {
    console.error('Error in recordDebtPaymentFromCashOut:', err);
    // Local store fallback
    try {
      const store = getLocalStore();
      const debt = store.debts.find(d => d.id === Number(debtId));
      if (debt) {
        const pInsts = store.installments
          .filter(i => i.debt_id === Number(debtId) && i.status !== 'paid')
          .sort((a, b) => a.installment_number - b.installment_number);
        let rem = paymentAmount;
        for (const i of pInsts) {
          if (rem <= 0) break;
          const needed = Number(i.amount) - Number(i.paid_amount || 0);
          const payNow = Math.min(rem, needed);
          i.paid_amount = Number(i.paid_amount || 0) + payNow;
          i.status = i.paid_amount >= Number(i.amount) ? 'paid' : 'partially_paid';
          i.treasury_tx_id = cashOutId;
          i.payment_method = 'خزينة المحل';
          i.source_type = 'treasury';
          rem -= payNow;
        }
        const allInsts = store.installments.filter(i => i.debt_id === debt.id);
        debt.paid_amount = allInsts.reduce((sum, i) => sum + Number(i.paid_amount || 0), 0);
        debt.remaining_amount = Math.max(0, Number(debt.total_amount) - debt.paid_amount);
        debt.status = debt.remaining_amount <= 0 ? 'completed' : 'active';
        saveLocalStore(store);
      }
    } catch (lErr) {
      console.warn('Local fallback error:', lErr.message);
    }
    return null;
  }
};

// 12. Helper: Revert Debt Payment when cash_out is updated or removed
exports.revertDebtPaymentFromCashOut = async ({ client = pool, cashOutId }) => {
  if (!cashOutId) return;
  try {
    const instsRes = await client.query(
      `SELECT * FROM debt_installments WHERE treasury_tx_id = $1`,
      [cashOutId]
    );
    if (instsRes.rows.length === 0) return;

    const debtIds = [...new Set(instsRes.rows.map(r => r.debt_id))];

    await client.query(
      `UPDATE debt_installments
       SET paid_amount = 0, paid_at = NULL, status = 'pending', treasury_tx_id = NULL, source_type = 'personal', updated_at = NOW()
       WHERE treasury_tx_id = $1`,
      [cashOutId]
    );

    for (const dId of debtIds) {
      const sumRes = await client.query(
        `SELECT COALESCE(SUM(paid_amount), 0) as total_paid FROM debt_installments WHERE debt_id = $1`,
        [dId]
      );
      const totalPaid = Number(sumRes.rows[0]?.total_paid || 0);
      const debtRes = await client.query(`SELECT total_amount FROM external_debts WHERE id = $1`, [dId]);
      const totalAmount = Number(debtRes.rows[0]?.total_amount || 0);
      const newRemaining = Math.max(0, totalAmount - totalPaid);
      const newDebtStatus = newRemaining <= 0 ? 'completed' : 'active';

      await client.query(
        `UPDATE external_debts
         SET paid_amount = $1, remaining_amount = $2, status = $3, updated_at = NOW()
         WHERE id = $4`,
        [totalPaid, newRemaining, newDebtStatus, dId]
      );
    }
  } catch (err) {
    console.error('Error in revertDebtPaymentFromCashOut:', err);
  }
};

