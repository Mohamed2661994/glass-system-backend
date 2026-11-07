/**
 * ═══════════════════════════════════════════════════════════════════
 * Quaz AI - System Diagnostic & Analytics Tools
 * ───────────────────────────────────────────────────────────────────
 * Provides read-only analytical queries against PostgreSQL for
 * executive decision support via Gemini Function Calling.
 * ═══════════════════════════════════════════════════════════════════
 */

const pool = require('../db');

function getCairoToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
}

function formatMoney(amount) {
  const num = Number(amount) || 0;
  return num.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + ' ج.م';
}

/**
 * 1. Cash Drawer & Treasuries Summary (حركة الخزينة والدرج)
 */
async function getCashAndTreasurySummary({ date, branchId, userContext } = {}) {
  const targetDate = date ? String(date).trim() : getCairoToday();
  const isAdmin = userContext ? Boolean(userContext.isAdmin) : true;
  const branchFilter = (!isAdmin && userContext?.branchId) ? Number(userContext.branchId) : (Number(branchId) || null);

  try {
    // 1. Cash In for date
    let inQuery = `
      SELECT 
        ci.branch_id,
        b.name as branch_name,
        COALESCE(SUM(ci.amount), 0) as total_in,
        COUNT(*) as transactions_count
      FROM cash_in ci
      LEFT JOIN branches b ON b.id = ci.branch_id
      WHERE ci.transaction_date = $1
    `;
    const inParams = [targetDate];
    if (branchFilter) {
      inQuery += ` AND ci.branch_id = $2`;
      inParams.push(branchFilter);
    }
    inQuery += ` GROUP BY ci.branch_id, b.name`;
    const inRes = await pool.query(inQuery, inParams);

    // 2. Cash Out (Expenses & Payments) for date
    let outQuery = `
      SELECT 
        co.branch_id,
        b.name as branch_name,
        COALESCE(SUM(co.amount), 0) as total_out,
        COUNT(*) as transactions_count
      FROM cash_out co
      LEFT JOIN branches b ON b.id = co.branch_id
      WHERE co.transaction_date = $1
    `;
    const outParams = [targetDate];
    if (branchFilter) {
      outQuery += ` AND co.branch_id = $2`;
      outParams.push(branchFilter);
    }
    outQuery += ` GROUP BY co.branch_id, b.name`;
    const outRes = await pool.query(outQuery, outParams);

    // 3. Recent 5 cash movements today
    let recentInQuery = `
      SELECT ci.id, ci.amount, ci.customer_name, ci.source_type, ci.notes, b.name as branch_name, ci.created_at
      FROM cash_in ci
      LEFT JOIN branches b ON b.id = ci.branch_id
      WHERE ci.transaction_date = $1
    `;
    const recentInParams = [targetDate];
    if (branchFilter) {
      recentInQuery += ` AND ci.branch_id = $2`;
      recentInParams.push(branchFilter);
    }
    recentInQuery += ` ORDER BY ci.id DESC LIMIT 5`;
    const recentIn = await pool.query(recentInQuery, recentInParams);

    let recentOutQuery = `
      SELECT co.id, co.amount, co.name, co.reason, co.entry_type, co.notes, b.name as branch_name, co.created_at
      FROM cash_out co
      LEFT JOIN branches b ON b.id = co.branch_id
      WHERE co.transaction_date = $1
    `;
    const recentOutParams = [targetDate];
    if (branchFilter) {
      recentOutQuery += ` AND co.branch_id = $2`;
      recentOutParams.push(branchFilter);
    }
    recentOutQuery += ` ORDER BY co.id DESC LIMIT 5`;
    const recentOut = await pool.query(recentOutQuery, recentOutParams);

    // Consolidate per branch
    const branchMap = {};
    inRes.rows.forEach(r => {
      branchMap[r.branch_id] = {
        branchId: r.branch_id,
        branchName: r.branch_name || `فرع ${r.branch_id}`,
        totalCashIn: Number(r.total_in),
        totalCashOut: 0,
        netBalance: Number(r.total_in),
      };
    });
    outRes.rows.forEach(r => {
      if (!branchMap[r.branch_id]) {
        branchMap[r.branch_id] = {
          branchId: r.branch_id,
          branchName: r.branch_name || `فرع ${r.branch_id}`,
          totalCashIn: 0,
          totalCashOut: Number(r.total_out),
          netBalance: -Number(r.total_out),
        };
      } else {
        branchMap[r.branch_id].totalCashOut = Number(r.total_out);
        branchMap[r.branch_id].netBalance -= Number(r.total_out);
      }
    });

    // If non-admin branch employee: strictly return their branch numbers only!
    if (!isAdmin && branchFilter) {
      const myBranch = branchMap[branchFilter] || {
        branchName: `فرع ${branchFilter}`,
        totalCashIn: 0,
        totalCashOut: 0,
        netBalance: 0,
      };
      return {
        date: targetDate,
        branchName: myBranch.branchName,
        totalCashIn: formatMoney(myBranch.totalCashIn),
        totalCashOut: formatMoney(myBranch.totalCashOut),
        netDrawerBalance: formatMoney(myBranch.netBalance),
        recentIncoming: recentIn.rows.map(r => ({
          id: r.id,
          amount: formatMoney(r.amount),
          customer: r.customer_name || 'غير محدد',
          notes: r.notes || r.source_type,
        })),
        recentOutgoing: recentOut.rows.map(r => ({
          id: r.id,
          amount: formatMoney(r.amount),
          recipient: r.name || 'غير محدد',
          reason: r.reason || r.notes || r.entry_type,
        })),
      };
    }

    let overallIn = 0;
    let overallOut = 0;
    Object.values(branchMap).forEach(b => {
      overallIn += b.totalCashIn;
      overallOut += b.totalCashOut;
    });

    return {
      date: targetDate,
      overallTotalCashIn: formatMoney(overallIn),
      overallTotalCashOut: formatMoney(overallOut),
      overallNetDrawerBalance: formatMoney(overallIn - overallOut),
      branches: Object.values(branchMap).map(b => ({
        branch: b.branchName,
        cashIn: formatMoney(b.totalCashIn),
        cashOut: formatMoney(b.totalCashOut),
        netDrawer: formatMoney(b.netBalance),
      })),
      recentIncoming: recentIn.rows.map(r => ({
        id: r.id,
        amount: formatMoney(r.amount),
        customer: r.customer_name || 'غير محدد',
        branch: r.branch_name,
        notes: r.notes || r.source_type,
      })),
      recentOutgoing: recentOut.rows.map(r => ({
        id: r.id,
        amount: formatMoney(r.amount),
        recipient: r.name || 'غير محدد',
        reason: r.reason || r.notes || r.entry_type,
        branch: r.branch_name,
      })),
    };
  } catch (error) {
    console.error('[Quaz AI Tool] Error getCashAndTreasurySummary:', error);
    return { error: `فشل استعلام الخزينة: ${error.message}` };
  }
}

/**
 * 2. Sales and Profit Metrics (حركة المبيعات وصافي الأرباح)
 */
async function getSalesAndProfits({ date, startDate, endDate, branchId, userContext } = {}) {
  const targetDate = date ? String(date).trim() : getCairoToday();
  const start = startDate ? String(startDate).trim() : targetDate;
  const end = endDate ? String(endDate).trim() : targetDate;
  const isAdmin = userContext ? Boolean(userContext.isAdmin) : true;
  const branchFilter = (!isAdmin && userContext?.branchId) ? Number(userContext.branchId) : (Number(branchId) || null);

  try {
    let query = `
      SELECT 
        COUNT(id) as total_invoices,
        COALESCE(SUM(total), 0) as gross_sales,
        COALESCE(SUM(paid_amount), 0) as collected_cash,
        COALESCE(SUM(remaining_amount), 0) as credit_debt
      FROM invoices
      WHERE movement_type = 'sale'
        AND is_void IS NOT TRUE
        AND invoice_date BETWEEN $1 AND $2
    `;
    const params = [start, end];
    if (branchFilter) {
      query += ` AND branch_id = $3`;
      params.push(branchFilter);
    }
    const invRes = await pool.query(query, params);
    const summary = invRes.rows[0] || {};

    // Estimated profit from invoice items
    let profitQuery = `
      SELECT 
        COALESCE(SUM(ii.price * ii.quantity), 0) as total_sales_items,
        COALESCE(SUM(ii.cost_price * ii.quantity), 0) as total_cost_items
      FROM invoice_items ii
      JOIN invoices inv ON inv.id = ii.invoice_id
      WHERE inv.movement_type = 'sale'
        AND inv.is_void IS NOT TRUE
        AND inv.invoice_date BETWEEN $1 AND $2
    `;
    const profitParams = [start, end];
    if (branchFilter) {
      profitQuery += ` AND inv.branch_id = $3`;
      profitParams.push(branchFilter);
    }
    const profitRes = await pool.query(profitQuery, profitParams);
    const itemSales = Number(profitRes.rows[0]?.total_sales_items || 0);
    const itemCost = Number(profitRes.rows[0]?.total_cost_items || 0);
    const netProfit = itemSales - itemCost;
    const profitMargin = itemSales > 0 ? ((netProfit / itemSales) * 100).toFixed(1) + '%' : '0%';

    // Top 5 selling items
    let topQuery = `
      SELECT 
        p.name as product_name,
        SUM(ii.quantity) as total_qty,
        SUM(ii.price * ii.quantity) as total_revenue
      FROM invoice_items ii
      JOIN invoices inv ON inv.id = ii.invoice_id
      JOIN products p ON p.id = ii.product_id
      WHERE inv.movement_type = 'sale'
        AND inv.is_void IS NOT TRUE
        AND inv.invoice_date BETWEEN $1 AND $2
    `;
    const topParams = [start, end];
    if (branchFilter) {
      topQuery += ` AND inv.branch_id = $3`;
      topParams.push(branchFilter);
    }
    topQuery += ` GROUP BY p.id, p.name ORDER BY total_qty DESC LIMIT 5`;
    const topRes = await pool.query(topQuery, topParams);

    const result = {
      period: start === end ? `تاريخ ${start}` : `الفترة من ${start} إلى ${end}`,
      totalInvoicesCount: Number(summary.total_invoices || 0),
      grossSales: formatMoney(summary.gross_sales),
      collectedCash: formatMoney(summary.collected_cash),
      topSellingProducts: topRes.rows.map(r => ({
        product: r.product_name,
        soldQuantity: Number(r.total_qty),
        revenue: formatMoney(r.total_revenue),
      })),
    };

    if (isAdmin) {
      result.creditDebtOnCustomers = formatMoney(summary.credit_debt);
      result.estimatedNetProfit = formatMoney(netProfit);
      result.profitMarginPercent = profitMargin;
    }

    return result;
  } catch (error) {
    console.error('[Quaz AI Tool] Error getSalesAndProfits:', error);
    return { error: `فشل استعلام المبيعات والأرباح: ${error.message}` };
  }
}

/**
 * 3. Stagnant Stock with positive shelf inventory (الأصناف الراكدة المتاحة للعروض)
 */
async function getStagnantStock({ limit = 10 } = {}) {
  const maxRows = Math.min(Number(limit) || 10, 50);

  try {
    // Products with 0 sales and stock > 0
    const query = `
      WITH product_sales AS (
        SELECT ii.product_id, SUM(ii.quantity) as sold_qty
        FROM invoice_items ii
        JOIN invoices inv ON inv.id = ii.invoice_id
        WHERE inv.movement_type = 'sale' AND inv.is_void IS NOT TRUE
        GROUP BY ii.product_id
      ),
      product_current_stock AS (
        SELECT product_id, SUM(quantity) as stock_qty
        FROM stock
        GROUP BY product_id
      )
      SELECT 
        p.id,
        p.name,
        p.manufacturer,
        COALESCE(p.retail_package, p.wholesale_package, '1 قطعة') as package_name,
        COALESCE(p.retail_price, p.wholesale_price, p.purchase_price, 0) as selling_price,
        pcs.stock_qty,
        (pcs.stock_qty * COALESCE(p.retail_price, p.wholesale_price, p.purchase_price, 0)) as tied_capital
      FROM products p
      JOIN product_current_stock pcs ON pcs.product_id = p.id
      LEFT JOIN product_sales ps ON ps.product_id = p.id
      WHERE p.is_active IS NOT FALSE
        AND (ps.sold_qty IS NULL OR ps.sold_qty = 0)
        AND pcs.stock_qty > 0
      ORDER BY pcs.stock_qty DESC
      LIMIT $1
    `;
    const res = await pool.query(query, [maxRows]);

    // Count overall stagnant in stock
    const countQuery = `
      WITH product_sales AS (
        SELECT ii.product_id, SUM(ii.quantity) as sold_qty
        FROM invoice_items ii
        JOIN invoices inv ON inv.id = ii.invoice_id
        WHERE inv.movement_type = 'sale' AND inv.is_void IS NOT TRUE
        GROUP BY ii.product_id
      ),
      product_current_stock AS (
        SELECT product_id, SUM(quantity) as stock_qty
        FROM stock
        GROUP BY product_id
      )
      SELECT 
        COUNT(p.id) as total_stagnant_count,
        COALESCE(SUM(pcs.stock_qty * COALESCE(p.retail_price, p.wholesale_price, p.purchase_price, 0)), 0) as total_tied_capital
      FROM products p
      JOIN product_current_stock pcs ON pcs.product_id = p.id
      LEFT JOIN product_sales ps ON ps.product_id = p.id
      WHERE p.is_active IS NOT FALSE
        AND (ps.sold_qty IS NULL OR ps.sold_qty = 0)
        AND pcs.stock_qty > 0
    `;
    const countRes = await pool.query(countQuery);
    const overallCount = Number(countRes.rows[0]?.total_stagnant_count || 0);
    const overallTied = Number(countRes.rows[0]?.total_tied_capital || 0);

    return {
      totalStagnantProductsWithStock: overallCount,
      estimatedTiedUpCapital: formatMoney(overallTied),
      advice: 'هذه بضاعة راكدة لم يُباع منها شيء ولكنها متوفرة برصيد فعلي على الأرفف، ينصح بإطلاق عروض تخفيض أو تصفيات BOGO لتسييل رأس المال المجمد.',
      sampleStagnantProducts: res.rows.map(r => ({
        id: r.id,
        name: r.name,
        manufacturer: r.manufacturer || 'عام',
        package: r.package_name,
        stockAvailable: Number(r.stock_qty),
        tiedCapital: formatMoney(r.tied_capital),
      })),
    };
  } catch (error) {
    console.error('[Quaz AI Tool] Error getStagnantStock:', error);
    return { error: `فشل استعلام الأصناف الراكدة: ${error.message}` };
  }
}

/**
 * 4. Critical Stock & Reorder Alerts (نواقص المخزن والأصناف الحرجة)
 */
async function getLowStockAlerts({ threshold = 5, limit = 15 } = {}) {
  const maxThreshold = Number(threshold) || 5;
  const maxRows = Math.min(Number(limit) || 15, 30);

  try {
    const query = `
      SELECT 
        p.id,
        p.name,
        p.manufacturer,
        COALESCE(SUM(s.quantity), 0) as current_stock,
        COALESCE(p.retail_price, p.wholesale_price, 0) as selling_price
      FROM products p
      LEFT JOIN stock s ON s.product_id = p.id
      WHERE p.is_active IS NOT FALSE
      GROUP BY p.id, p.name, p.manufacturer, p.retail_price, p.wholesale_price
      HAVING COALESCE(SUM(s.quantity), 0) <= $1
      ORDER BY current_stock ASC, p.id ASC
      LIMIT $2
    `;
    const res = await pool.query(query, [maxThreshold, maxRows]);

    return {
      thresholdUsed: maxThreshold,
      criticalItemsCount: res.rows.length,
      criticalItems: res.rows.map(r => ({
        id: r.id,
        name: r.name,
        manufacturer: r.manufacturer || 'عام',
        currentStock: Number(r.current_stock),
        status: Number(r.current_stock) === 0 ? '❌ نافذ تماماً' : '⚠️ رصيد حرج',
      })),
    };
  } catch (error) {
    console.error('[Quaz AI Tool] Error getLowStockAlerts:', error);
    return { error: `فشل استعلام نواقص المخزن: ${error.message}` };
  }
}

/**
 * 5. Payroll, Advances & Employee Ledger (الرواتب والسلفيات)
 */
async function getPayrollSummary({ employeeName, userContext } = {}) {
  const isAdmin = userContext ? Boolean(userContext.isAdmin) : true;
  if (!isAdmin) {
    return { error: '⛔ عذراً! كشف رواتب وسلفيات العمال خاص بالإدارة العليا فقط وغير مصرح بالاطلاع عليه.' };
  }

  try {
    let query = `
      SELECT 
        e.id,
        e.name,
        e.job_title,
        e.salary_type,
        e.base_salary,
        e.status,
        b.name as branch_name,
        COALESCE(
          (SELECT SUM(pa.amount) FROM payroll_advances pa WHERE pa.employee_id = e.id AND pa.status = 'pending'), 
          0
        ) as pending_advances
      FROM payroll_employees e
      LEFT JOIN branches b ON b.id = e.branch_id
      WHERE e.status = 'active'
    `;
    const params = [];
    if (employeeName && typeof employeeName === 'string') {
      query += ` AND e.name ILIKE $1`;
      params.push(`%${employeeName.trim()}%`);
    }
    query += ` ORDER BY e.id ASC`;
    const res = await pool.query(query, params);

    const totalBaseSalary = res.rows.reduce((sum, r) => sum + Number(r.base_salary || 0), 0);
    const totalPendingAdvances = res.rows.reduce((sum, r) => sum + Number(r.pending_advances || 0), 0);

    return {
      activeEmployeesCount: res.rows.length,
      totalBaseSalariesBudget: formatMoney(totalBaseSalary),
      totalPendingAdvances: formatMoney(totalPendingAdvances),
      employees: res.rows.map(r => ({
        id: r.id,
        name: r.name,
        jobTitle: r.job_title || 'موظف',
        branch: r.branch_name,
        salaryType: r.salary_type === 'monthly' ? 'شهري' : 'أسبوعي',
        baseSalary: formatMoney(r.base_salary),
        pendingAdvances: formatMoney(r.pending_advances),
      })),
    };
  } catch (error) {
    console.error('[Quaz AI Tool] Error getPayrollSummary:', error);
    return { error: `فشل استعلام الرواتب: ${error.message}` };
  }
}

/**
 * 6. External Debts and Suppliers Summary (الديون ومستحقات الموردين)
 */
async function getDebtsSummary({ creditorName, userContext } = {}) {
  const isAdmin = userContext ? Boolean(userContext.isAdmin) : true;
  if (!isAdmin) {
    return { error: '⛔ عذراً! كشف المديونيات وحسابات الموردين خاص بالإدارة العليا فقط وغير مصرح بالاطلاع عليه.' };
  }

  try {
    let query = `
      SELECT 
        id,
        title,
        creditor_name,
        creditor_phone,
        total_amount,
        paid_amount,
        remaining_amount,
        installment_count,
        installment_amount,
        frequency,
        category,
        status
      FROM external_debts
      WHERE remaining_amount > 0 AND status = 'active'
    `;
    const params = [];
    if (creditorName && typeof creditorName === 'string') {
      query += ` AND (creditor_name ILIKE $1 OR title ILIKE $1)`;
      params.push(`%${creditorName.trim()}%`);
    }
    query += ` ORDER BY remaining_amount DESC LIMIT 15`;
    const res = await pool.query(query, params);

    let totalRemaining = 0;
    let totalOriginal = 0;
    res.rows.forEach(r => {
      totalRemaining += Number(r.remaining_amount || 0);
      totalOriginal += Number(r.total_amount || 0);
    });

    return {
      activeDebtsCount: res.rows.length,
      totalRemainingDebts: formatMoney(totalRemaining),
      debtsList: res.rows.map(r => ({
        id: r.id,
        title: r.title,
        creditor: r.creditor_name,
        phone: r.creditor_phone || '-',
        total: formatMoney(r.total_amount),
        paid: formatMoney(r.paid_amount),
        remaining: formatMoney(r.remaining_amount),
        category: r.category,
      })),
    };
  } catch (error) {
    console.error('[Quaz AI Tool] Error getDebtsSummary:', error);
    return { error: `فشل استعلام المديونيات: ${error.message}` };
  }
}

/**
 * 7. Executive General Overview (نظرة تنفيذية شاملة وموجزة)
 */
async function getExecutiveDailyOverview({ userContext } = {}) {
  const isAdmin = userContext ? Boolean(userContext.isAdmin) : true;
  if (!isAdmin) {
    return { error: '⛔ عذراً! النظرة التنفيذية الشاملة خاصة بالإدارة العليا فقط.' };
  }

  const [cash, sales, debts, stagnant] = await Promise.all([
    getCashAndTreasurySummary({ userContext }),
    getSalesAndProfits({ userContext }),
    getDebtsSummary({ userContext }),
    getStagnantStock({ limit: 5 }),
  ]);

  return {
    todayDate: getCairoToday(),
    cashStatus: {
      netCashInTreasury: cash.overallNetDrawerBalance,
      totalIn: cash.overallTotalCashIn,
      totalOut: cash.overallTotalCashOut,
    },
    salesStatus: {
      invoicesCount: sales.totalInvoicesCount,
      grossSales: sales.grossSales,
      collectedCash: sales.collectedCash,
      netProfit: sales.estimatedNetProfit,
      margin: sales.profitMarginPercent,
    },
    debtsStatus: {
      activeDebtsCount: debts.activeDebtsCount,
      totalRemainingDebts: debts.totalRemainingDebts,
    },
    stagnantStatus: {
      itemsCount: stagnant.totalStagnantProductsWithStock,
      tiedCapital: stagnant.estimatedTiedUpCapital,
    },
  };
}

/**
 * 8. Search Product Stock & Inventory Details (استعلام وبحث رصيد صنف محدد بالفروع)
 */
async function searchProductStock({ query, barcode, branchId, userContext } = {}) {
  const searchTerm = (barcode || query || '').trim();
  if (!searchTerm) {
    return { error: 'برجاء كتابة اسم الصنف أو الباركود للاستعلام عن رصيده.' };
  }

  const isAdmin = userContext ? Boolean(userContext.isAdmin) : true;
  const userBranch = userContext?.branchId ? Number(userContext.branchId) : null;
  const effectiveBranch = (!isAdmin && userBranch) ? userBranch : (Number(branchId) || null);

  try {
    const sql = `
      SELECT 
        p.id,
        p.name,
        p.barcode,
        p.manufacturer,
        p.model,
        p.color,
        COALESCE(p.retail_package, p.wholesale_package, 'قطعة') as package_type,
        COALESCE(p.retail_price, 0) as retail_price,
        COALESCE(p.wholesale_price, 0) as wholesale_price,
        COALESCE(p.purchase_price, 0) as purchase_price,
        COALESCE(SUM(s.quantity), 0) as total_stock,
        COALESCE(SUM(CASE WHEN s.branch_id = 1 THEN s.quantity ELSE 0 END), 0) as showroom_stock,
        COALESCE(SUM(CASE WHEN s.branch_id = 2 THEN s.quantity ELSE 0 END), 0) as warehouse_stock,
        COALESCE(SUM(CASE WHEN s.branch_id = 3 THEN s.quantity ELSE 0 END), 0) as branch3_stock
      FROM products p
      LEFT JOIN stock s ON s.product_id = p.id
      WHERE p.is_active IS NOT FALSE
        AND (
          p.name ILIKE $1 
          OR p.barcode ILIKE $1 
          OR p.manufacturer ILIKE $1 
          OR p.model ILIKE $1
        )
      GROUP BY p.id, p.name, p.barcode, p.manufacturer, p.model, p.color, p.retail_package, p.wholesale_package, p.retail_price, p.wholesale_price, p.purchase_price
      ORDER BY total_stock DESC
      LIMIT 8
    `;

    const res = await pool.query(sql, [`%${searchTerm}%`]);
    if (res.rows.length === 0) {
      return {
        message: `لم يتم العثور على أي صنف يطابق "${searchTerm}" في النظام. برجاء التأكد من اسم الصنف أو الباركود.`,
        productsFound: [],
      };
    }

    return {
      searchTerm,
      matchedProductsCount: res.rows.length,
      products: res.rows.map(r => {
        const item = {
          id: r.id,
          name: r.name,
          barcode: r.barcode || '-',
          manufacturer: r.manufacturer || 'عام',
          package: r.package_type,
          retailPrice: formatMoney(r.retail_price),
          wholesalePrice: formatMoney(r.wholesale_price),
        };

        if (isAdmin) {
          item.purchasePrice = formatMoney(r.purchase_price);
          item.totalStockAllBranches = Number(r.total_stock);
          item.stockByBranch = {
            showroomBranch1: Number(r.showroom_stock),
            warehouseBranch2: Number(r.warehouse_stock),
            branch3: Number(r.branch3_stock),
          };
        } else if (effectiveBranch === 1) {
          // Showroom user
          item.stockInShowroom = Number(r.showroom_stock);
          item.warehouseAvailability = Number(r.warehouse_stock) > 0 ? `متوفر في المخزن الرئيسي (${r.warehouse_stock} قطعة للتحويل)` : 'غير متوفر بالمخزن';
        } else if (effectiveBranch === 2) {
          // Warehouse user
          item.stockInWarehouse = Number(r.warehouse_stock);
          item.stockInShowroom = Number(r.showroom_stock);
        } else {
          item.currentStock = Number(r.total_stock);
        }

        return item;
      }),
    };
  } catch (error) {
    console.error('[Quaz AI Tool] searchProductStock error:', error);
    return { error: `فشل استعلام رصيد الصنف: ${error.message}` };
  }
}

module.exports = {
  getCashAndTreasurySummary,
  getSalesAndProfits,
  getStagnantStock,
  getLowStockAlerts,
  getPayrollSummary,
  getDebtsSummary,
  getExecutiveDailyOverview,
  searchProductStock,
  getCairoToday,
};
