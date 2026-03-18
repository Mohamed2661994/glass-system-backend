const pool = require("../db");

let ensureInvoiceItemsCostPriceColumnPromise = null;

async function ensureInvoiceItemsCostPriceColumn() {
  if (!ensureInvoiceItemsCostPriceColumnPromise) {
    ensureInvoiceItemsCostPriceColumnPromise = pool
      .query(
        `
        ALTER TABLE invoice_items
        ADD COLUMN IF NOT EXISTS cost_price NUMERIC
        `,
      )
      .catch((error) => {
        ensureInvoiceItemsCostPriceColumnPromise = null;
        throw error;
      });
  }

  return ensureInvoiceItemsCostPriceColumnPromise;
}

/* ===============================
   📦 تقرير جرد المخزن الشامل
   وارد + منصرف + رصيد حالي
================================ */
exports.getInventorySummary = async (req, res) => {
  try {
    const { warehouse_id } = req.query;

    const result = await pool.query(
      `
    SELECT
      p.id AS product_id,
      p.name AS product_name,
      p.manufacturer AS manufacturer_name,
      w.name AS warehouse_name,
      p.wholesale_package,
      p.retail_package,
      s.variant_id,

      COALESCE(SUM(
        CASE 
          WHEN sm.movement_type IN ('purchase','transfer_in','replace_in','return_sale')
          THEN sm.quantity ELSE 0 END
      ), 0) AS total_in,

      COALESCE(SUM(
        CASE 
          WHEN sm.movement_type IN ('sale','transfer_out','replace_out','return_purchase')
          THEN sm.quantity ELSE 0 END
      ), 0) AS total_out,

      COALESCE(s.quantity, 0) AS current_stock

    FROM products p
    LEFT JOIN stock s ON s.product_id = p.id
    LEFT JOIN warehouses w ON w.id = s.warehouse_id
    LEFT JOIN stock_movements sm
      ON sm.product_id = p.id
      AND sm.warehouse_id = s.warehouse_id
      AND COALESCE(sm.variant_id, 0) = COALESCE(s.variant_id, 0)

    ${warehouse_id ? "WHERE s.warehouse_id = $1" : ""}

    GROUP BY p.id, p.name, p.manufacturer, w.name, p.wholesale_package, p.retail_package, s.quantity, s.variant_id

    HAVING 
      COALESCE(SUM(CASE WHEN sm.movement_type IN ('purchase','transfer_in','replace_in','return_sale') THEN sm.quantity ELSE 0 END),0) > 0
      OR COALESCE(SUM(CASE WHEN sm.movement_type IN ('sale','transfer_out','replace_out','return_purchase') THEN sm.quantity ELSE 0 END),0) > 0
      OR COALESCE(s.quantity,0) > 0

    ORDER BY p.name
      `,
      warehouse_id ? [warehouse_id] : [],
    );

    // Get all variants to map variant_id → package names
    const variantsRes = await pool.query(
      `SELECT id, product_id, wholesale_package, retail_package FROM product_variants ORDER BY id`,
    );
    const variantsById = {};
    for (const v of variantsRes.rows) {
      variantsById[v.id] = v;
    }

    // Build rows with package_name based on variant_id
    const rows = result.rows.map((row) => {
      const vid = Number(row.variant_id) || 0;
      let pkgLabel;
      if (vid === 0) {
        pkgLabel =
          [row.wholesale_package, row.retail_package]
            .filter(Boolean)
            .join(" / ") || "-";
      } else {
        const v = variantsById[vid];
        pkgLabel = v
          ? [v.wholesale_package, v.retail_package].filter(Boolean).join(" / ")
          : "-";
      }
      return { ...row, package_name: pkgLabel };
    });

    res.json(rows);
  } catch (err) {
    console.error("INVENTORY SUMMARY ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
};

/* ===============================
   🔄 تقرير حركة صنف
================================ */
exports.getProductMovement = async (req, res) => {
  try {
    const { product_id, product_name, warehouse_id, from, to, party_name } =
      req.query;

    if (!product_id && !product_name) {
      return res.status(400).json({ error: "product_id أو product_name مطلوب" });
    }

    const conditions = [];
    const values = [];
    let idx = 1;

    if (product_id) {
      conditions.push(`sm.product_id = $${idx++}`);
      values.push(Number(product_id));
    } else {
      conditions.push(`LOWER(p.name) LIKE LOWER($${idx++})`);
      values.push(`%${product_name}%`);
    }

    // 🏬 فلترة المخزن
    if (warehouse_id) {
      conditions.push(`sm.warehouse_id = $${idx++}`);
      values.push(warehouse_id);
    }

    // 📅 من تاريخ
    if (from) {
      conditions.push(`DATE(sm.created_at) >= $${idx++}`);
      values.push(from);
    }

    // 📅 إلى تاريخ
    if (to) {
      conditions.push(`DATE(sm.created_at) <= $${idx++}`);
      values.push(to);
    }

    // 👤 فلترة باسم العميل / المورد
    if (party_name) {
      conditions.push(`LOWER(i.customer_name) LIKE LOWER($${idx++})`);
      values.push(`%${party_name}%`);
    }

    const result = await pool.query(
      `
      SELECT
        sm.created_at,
        p.name AS product_name,
        p.manufacturer AS manufacturer_name,
        w.name AS warehouse_name,
        sm.movement_type,
        sm.quantity,
        sm.note,
        sm.invoice_id,
        sm.variant_id,

        -- اسم العميل أو المورد من الفاتورة
        i.customer_name AS party_name,

        -- نوع الفاتورة (بيع / شراء)
        i.invoice_type,

        -- نوع الحركة من الفاتورة (sale / purchase)
        i.movement_type AS invoice_movement_type,

        -- العبوة: من الفاتورة أو من العبوة الفرعية أو من المنتج الأساسي
        COALESCE(
          ii.package,
          CASE WHEN sm.variant_id > 0 THEN pv.wholesale_package END,
          p.wholesale_package
        ) AS package_name

      FROM stock_movements sm
      JOIN products p ON p.id = sm.product_id
      JOIN warehouses w ON w.id = sm.warehouse_id
      LEFT JOIN invoices i ON i.id = sm.invoice_id
      LEFT JOIN invoice_items ii ON ii.invoice_id = sm.invoice_id AND ii.product_id = sm.product_id AND ii.variant_id = sm.variant_id
      LEFT JOIN product_variants pv ON pv.id = sm.variant_id

      WHERE ${conditions.join(" AND ")}
      ORDER BY sm.created_at ASC
      `,
      values,
    );

    res.json(result.rows);
  } catch (err) {
    console.error("PRODUCT MOVEMENT ERROR:", err);
    res.status(500).json({ error: "Server error", details: err.message });
  }
};

exports.getProductCurrentStock = async (req, res) => {
  try {
    const { product_id, warehouse_id } = req.query;

    if (!product_id) {
      return res.status(400).json({ error: "product_id مطلوب" });
    }

    let where = "WHERE s.product_id = $1";
    const values = [product_id];

    if (warehouse_id) {
      where += " AND s.warehouse_id = $2";
      values.push(warehouse_id);
    }

    const result = await pool.query(
      `
      SELECT
        w.id AS warehouse_id,
        w.name AS warehouse_name,
        s.variant_id,
        COALESCE(SUM(s.quantity), 0) AS current_stock,
        p.wholesale_package,
        p.retail_package
      FROM stock s
      JOIN warehouses w ON w.id = s.warehouse_id
      JOIN products p ON p.id = s.product_id
      ${where}
      GROUP BY w.id, w.name, s.variant_id, p.wholesale_package, p.retail_package
      ORDER BY w.id, s.variant_id
      `,
      values,
    );

    const variantsRes = await pool.query(
      `SELECT id, product_id, wholesale_package, retail_package FROM product_variants ORDER BY id`,
    );
    const variantsById = {};
    for (const v of variantsRes.rows) {
      variantsById[v.id] = v;
    }

    const rows = result.rows.map((row) => {
      const vid = Number(row.variant_id) || 0;
      let pkgLabel;
      if (vid === 0) {
        pkgLabel =
          [row.wholesale_package, row.retail_package]
            .filter(Boolean)
            .join(" / ") || "-";
      } else {
        const v = variantsById[vid];
        pkgLabel = v
          ? [v.wholesale_package, v.retail_package].filter(Boolean).join(" / ")
          : "-";
      }

      return {
        ...row,
        current_stock: Number(row.current_stock || 0),
        package_name: pkgLabel,
      };
    });

    const totalCurrentStock = rows.reduce(
      (sum, row) => sum + Number(row.current_stock || 0),
      0,
    );

    res.json({
      product_id: Number(product_id),
      total_current_stock: totalCurrentStock,
      rows,
    });
  } catch (err) {
    console.error("PRODUCT CURRENT STOCK ERROR:", err);
    res.status(500).json({ error: "Server error", details: err.message });
  }
};

/* ===============================
   ⚠️ تقرير نقص المخزون
================================ */
exports.getLowStock = async (req, res) => {
  try {
    const { limit_quantity = 5, warehouse_id } = req.query;

    let where = "WHERE s.quantity <= $1 AND p.is_active = true";
    let values = [limit_quantity];
    let index = 2;

    if (warehouse_id) {
      where += ` AND s.warehouse_id = $${index++}`;
      values.push(warehouse_id);
    }

    const result = await pool.query(
      `
      SELECT
        p.id AS product_id,
        p.name AS product_name,
        p.manufacturer AS manufacturer_name,
        w.name AS warehouse_name,
        s.quantity AS current_stock,
        s.variant_id,
        p.wholesale_package,
        p.retail_package
      FROM stock s
      JOIN products p ON p.id = s.product_id
      JOIN warehouses w ON w.id = s.warehouse_id
      ${where}
      ORDER BY CASE WHEN s.quantity <= 0 THEN 1 ELSE 0 END, s.quantity ASC
      `,
      values,
    );

    // Get all variants to map variant_id → package names
    const variantsRes = await pool.query(
      `SELECT id, product_id, wholesale_package, retail_package FROM product_variants ORDER BY id`,
    );
    const variantsById = {};
    for (const v of variantsRes.rows) {
      variantsById[v.id] = v;
    }

    const rows = result.rows.map((row) => {
      const vid = Number(row.variant_id) || 0;
      let pkgLabel;
      if (vid === 0) {
        pkgLabel =
          [row.wholesale_package, row.retail_package]
            .filter(Boolean)
            .join(" / ") || "-";
      } else {
        const v = variantsById[vid];
        pkgLabel = v
          ? [v.wholesale_package, v.retail_package].filter(Boolean).join(" / ")
          : "-";
      }
      return { ...row, package_name: pkgLabel };
    });

    res.json(rows);
  } catch (err) {
    console.error("LOW STOCK ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
};

/* ===============================
   ⚠️ أصناف سالبة (كمية < 0)
   — يحسب الرصيد الفعلي من حركات المخزون
================================ */
exports.getNegativeStock = async (req, res) => {
  try {
    const { warehouse_id } = req.query;

    let warehouseFilter = "";
    let values = [];
    let index = 1;

    if (warehouse_id) {
      warehouseFilter = `AND sm.warehouse_id = $${index++}`;
      values.push(warehouse_id);
    }

    const result = await pool.query(
      `
      SELECT
        p.id AS product_id,
        p.name AS product_name,
        p.barcode,
        p.manufacturer AS manufacturer_name,
        w.name AS warehouse_name,
        COALESCE(SUM(sm.quantity), 0) AS current_stock,
        sm.variant_id,
        p.wholesale_package,
        p.retail_package
      FROM stock_movements sm
      JOIN products p ON p.id = sm.product_id
      JOIN warehouses w ON w.id = sm.warehouse_id
      WHERE p.is_active = true ${warehouseFilter}
      GROUP BY p.id, p.name, p.barcode, p.manufacturer, w.id, w.name,
               sm.variant_id, p.wholesale_package, p.retail_package
      HAVING COALESCE(SUM(sm.quantity), 0) < 0
      ORDER BY COALESCE(SUM(sm.quantity), 0) ASC
      `,
      values,
    );

    // Get all variants to map variant_id -> package names
    const variantsRes = await pool.query(
      `SELECT id, product_id, wholesale_package, retail_package FROM product_variants ORDER BY id`,
    );
    const variantsById = {};
    for (const v of variantsRes.rows) {
      variantsById[v.id] = v;
    }

    const rows = result.rows.map((row) => {
      const vid = Number(row.variant_id) || 0;
      let pkgLabel;
      if (vid === 0) {
        pkgLabel =
          [row.wholesale_package, row.retail_package]
            .filter(Boolean)
            .join(" / ") || "-";
      } else {
        const v = variantsById[vid];
        pkgLabel = v
          ? [v.wholesale_package, v.retail_package].filter(Boolean).join(" / ")
          : "-";
      }
      return { ...row, package_name: pkgLabel };
    });

    res.json(rows);
  } catch (err) {
    console.error("NEGATIVE STOCK ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
};

/* ===============================
   💰 قيمة المخزون
================================ */
exports.getInventoryValue = async (req, res) => {
  try {
    const { warehouse_id } = req.query;

    let where = "";
    let values = [];

    if (warehouse_id) {
      where = "WHERE w.id = $1";
      values.push(warehouse_id);
    }

    const result = await pool.query(
      `
      SELECT
        w.id AS warehouse_id,
        w.name AS warehouse_name,

        COUNT(DISTINCT s.product_id) AS total_products,   -- 🆕 عدد الأصناف
        SUM(s.quantity) AS total_quantity,                -- 🆕 إجمالي الكمية

        SUM(s.quantity * CASE WHEN w.id = 1 THEN p.retail_purchase_price ELSE p.purchase_price END) AS total_value -- 💰 قيمة المخزون

      FROM stock s
      JOIN products p ON p.id = s.product_id
      JOIN warehouses w ON w.id = s.warehouse_id

      ${where}

      GROUP BY w.id, w.name
      ORDER BY total_value DESC
      `,
      values,
    );

    res.json(result.rows);
  } catch (err) {
    console.error("INVENTORY VALUE ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
};

exports.getInventoryDetails = async (req, res) => {
  try {
    const { warehouse_id, manufacturer } = req.query;

    let conditions = ["s.quantity > 0"];
    let values = [];
    let idx = 1;

    if (warehouse_id) {
      conditions.push(`w.id = $${idx++}`);
      values.push(warehouse_id);
    }

    if (manufacturer) {
      conditions.push(`p.manufacturer = $${idx++}`);
      values.push(manufacturer);
    }

    const where = `WHERE ${conditions.join(" AND ")}`;

    const result = await pool.query(
      `
      SELECT
        p.id AS product_id,
        p.name AS product_name,
        p.manufacturer,
        s.quantity,
        s.variant_id,
        p.purchase_price,
        p.retail_purchase_price,
        p.wholesale_package,
        p.retail_package,
        (s.quantity * CASE WHEN w.id = 1 THEN p.retail_purchase_price ELSE p.purchase_price END) AS total_value,
        w.id AS warehouse_id,
        w.name AS warehouse_name
      FROM stock s
      JOIN products p ON p.id = s.product_id
      JOIN warehouses w ON w.id = s.warehouse_id
      ${where}
      ORDER BY w.name, p.name
      `,
      values,
    );

    // Get all variants to map variant_id → package + purchase_price
    const variantsRes = await pool.query(
      `SELECT id, product_id, wholesale_package, retail_package, purchase_price, retail_purchase_price FROM product_variants ORDER BY id`,
    );
    const variantsById = {};
    for (const v of variantsRes.rows) {
      variantsById[v.id] = v;
    }

    const rows = result.rows.map((row) => {
      const vid = Number(row.variant_id) || 0;
      let pkgLabel;
      let purchasePrice =
        row.warehouse_id === 1 ? row.retail_purchase_price : row.purchase_price;
      if (vid === 0) {
        pkgLabel =
          [row.wholesale_package, row.retail_package]
            .filter(Boolean)
            .join(" / ") || "-";
      } else {
        const v = variantsById[vid];
        if (v) {
          pkgLabel =
            [v.wholesale_package, v.retail_package]
              .filter(Boolean)
              .join(" / ") || "-";
          purchasePrice =
            row.warehouse_id === 1 ? v.retail_purchase_price : v.purchase_price;
        } else {
          pkgLabel = "-";
        }
      }
      return {
        ...row,
        package_name: pkgLabel,
        purchase_price: purchasePrice,
        total_value: row.quantity * Number(purchasePrice),
      };
    });

    res.json(rows);
  } catch (err) {
    console.error("INVENTORY DETAILS ERROR:", err);
    res.status(500).json({ error: "Server error", details: err.message });
  }
};

exports.getManufacturers = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT TRIM(LOWER(manufacturer)) AS manufacturer
      FROM products
      WHERE manufacturer IS NOT NULL AND TRIM(manufacturer) <> ''
      ORDER BY manufacturer ASC
    `);

    res.json(result.rows);
  } catch (err) {
    console.error("MANUFACTURERS ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
};

exports.getAllProducts = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, manufacturer
      FROM products
      ORDER BY name ASC
    `);

    res.json(result.rows);
  } catch (err) {
    console.error("GET PRODUCTS ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
};

exports.getCustomerBalances = async (req, res) => {
  try {
    const { from, to, customer_name, warehouse_id } = req.query;

    let conditions_main = ["i.movement_type = 'sale'", "i.is_void = false"];
    let conditions_cte = ["movement_type = 'sale'", "is_void = false"];

    let values = [];
    let idx = 1;

    if (from) {
      const p = "$" + idx++;
      conditions_main.push("i.invoice_date >= " + p);
      conditions_cte.push("invoice_date >= " + p);
      values.push(from);
    }

    if (to) {
      const p = "$" + idx++;
      conditions_main.push("i.invoice_date <= " + p);
      conditions_cte.push("invoice_date <= " + p);
      values.push(to);
    }

    if (customer_name) {
      const p = "$" + idx++;
      conditions_main.push("i.customer_name ILIKE " + p);
      conditions_cte.push("customer_name ILIKE " + p);
      values.push("%" + customer_name + "%");
    }

    if (warehouse_id) {
      const p = "$" + idx++;
      conditions_main.push("i.branch_id = " + p);
      conditions_cte.push("branch_id = " + p);
      values.push(warehouse_id);
    }

    const mainWhere = "WHERE " + conditions_main.join(" AND ");
    const cteWhere = "WHERE " + conditions_cte.join(" AND ");

    const result = await pool.query(
      `
      WITH opening AS (
        SELECT DISTINCT ON (customer_name)
          customer_name,
          COALESCE(previous_balance, 0) AS opening_balance
        FROM invoices
        ${cteWhere}
        ORDER BY customer_name, invoice_date ASC, id ASC
      )
      SELECT
        i.customer_name,
        COALESCE(ob.opening_balance, 0) AS opening_balance,
        SUM(i.total) AS total_sales,
        SUM(i.paid_amount) + COALESCE(cp.extra_paid, 0) AS total_paid,
        GREATEST(
          COALESCE(ob.opening_balance, 0) + SUM(i.total) - SUM(i.paid_amount) - COALESCE(cp.extra_paid, 0),
          0
        ) AS balance_due,
        MAX(i.invoice_date) AS last_invoice_date
      FROM invoices i
      LEFT JOIN opening ob ON ob.customer_name = i.customer_name
      LEFT JOIN (
        SELECT customer_name, SUM(amount) AS extra_paid
        FROM cash_in
        WHERE source_type = 'customer_payment'
        GROUP BY customer_name
      ) cp ON cp.customer_name = i.customer_name
      ${mainWhere}
      GROUP BY i.customer_name, cp.extra_paid, ob.opening_balance
      HAVING GREATEST(
        COALESCE(ob.opening_balance, 0) + SUM(i.total) - SUM(i.paid_amount) - COALESCE(cp.extra_paid, 0),
        0
      ) > 0
      ORDER BY balance_due DESC
      `,
      values,
    );

    res.json(result.rows);
  } catch (err) {
    console.error("CUSTOMER BALANCES ERROR:", err);
    res.status(500).json({ error: "Server error", details: err.message });
  }
};

/* ===============================
   📄 كشف حساب عميل تفصيلي
================================ */
exports.getCustomerDebtDetails = async (req, res) => {
  try {
    const { customer_name, from, to, warehouse_id } = req.query;

    if (!customer_name) {
      return res.status(400).json({ error: "customer_name مطلوب" });
    }

    let conditions = [
      "i.customer_name = $1",
      "i.movement_type = 'sale'",
      "i.is_void = false",
    ];

    let values = [customer_name];
    let idx = 2;

    if (from) {
      conditions.push(`i.invoice_date >= $${idx++}`);
      values.push(from);
    }

    if (to) {
      conditions.push(`i.invoice_date <= $${idx++}`);
      values.push(to);
    }

    if (warehouse_id) {
      conditions.push(`i.branch_id = $${idx++}`);
      values.push(warehouse_id);
    }

    const invoiceWhere = `WHERE ${conditions.join(" AND ")}`;

    const result = await pool.query(
      `
      -- 🧾 الفواتير
      SELECT
        'invoice' AS record_type,
        i.id AS invoice_id,
        i.invoice_date,
        COALESCE(i.subtotal, i.total) AS subtotal,
        COALESCE(i.discount_total, 0) AS discount_total,
        i.total,
        i.paid_amount,
        i.remaining_amount
      FROM invoices i
      ${invoiceWhere}

      UNION ALL

      -- 💰 سندات الدفع
      SELECT
        'payment' AS record_type,
        cp.id AS invoice_id,
        cp.created_at AS invoice_date,
        0 AS subtotal,
        0 AS discount_total,
        0 AS total,
        cp.amount AS paid_amount,
        0 AS remaining_amount
      FROM cash_in cp
      WHERE cp.source_type = 'customer_payment'
      AND cp.customer_name = $1
      ${from ? `AND cp.created_at >= '${from}'` : ""}
      ${to ? `AND cp.created_at <= '${to}'` : ""}

      ORDER BY invoice_date ASC
      `,
      values,
    );

    res.json(result.rows);
  } catch (err) {
    console.error("CUSTOMER DEBT DETAILS ERROR:", err);
    res.status(500).json({ error: "Server error", details: err.message });
  }
};

/* =========================================================
   كشف حساب الموردين - Supplier Balances
   ========================================================= */

exports.getSupplierBalances = async (req, res) => {
  try {
    const { supplier_name, warehouse_id } = req.query;

    let conditions = [];
    let invConditions = ["movement_type = 'purchase'", "is_void IS NOT TRUE"];
    let payConditions = [
      "entry_type = 'supplier_payment'",
      "supplier_id IS NOT NULL",
    ];
    let cteConditions = [
      "movement_type = 'purchase'",
      "is_void IS NOT TRUE",
      "supplier_id IS NOT NULL",
    ];
    let values = [];
    let idx = 1;

    if (supplier_name) {
      conditions.push(`s.name ILIKE $${idx++}`);
      values.push(`%${supplier_name}%`);
    }

    if (warehouse_id) {
      const p = `$${idx++}`;
      invConditions.push(`branch_id = ${p}`);
      payConditions.push(`branch_id = ${p}`);
      cteConditions.push(`branch_id = ${p}`);
      // Only show suppliers that have activity in this branch
      conditions.push(
        `(EXISTS (SELECT 1 FROM invoices WHERE supplier_id = s.id AND movement_type = 'purchase' AND is_void IS NOT TRUE AND branch_id = ${p})
          OR EXISTS (SELECT 1 FROM cash_out WHERE supplier_id = s.id AND entry_type = 'supplier_payment' AND branch_id = ${p}))`,
      );
      values.push(warehouse_id);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const invWhere = invConditions.join(" AND ");
    const payWhere = payConditions.join(" AND ");
    const cteWhere = cteConditions.join(" AND ");

    const result = await pool.query(
      `
      WITH opening AS (
        SELECT DISTINCT ON (supplier_id)
          supplier_id,
          COALESCE(previous_balance, 0) AS opening_balance
        FROM invoices
        WHERE ${cteWhere}
        ORDER BY supplier_id, invoice_date ASC, id ASC
      )
      SELECT
        s.id AS supplier_id,
        s.name AS supplier_name,
        COALESCE(inv.total_purchases, 0) AS total_purchases,
        COALESCE(inv.total_paid_invoices, 0) AS total_paid_invoices,
        COALESCE(pay.total_payments, 0) AS total_payments,
        COALESCE(o.opening_balance, 0) AS opening_balance,
        COALESCE(o.opening_balance, 0)
          + COALESCE(inv.total_purchases, 0)
          - COALESCE(inv.total_paid_invoices, 0)
          - COALESCE(pay.total_payments, 0)
        AS balance_due,
        inv.last_invoice_date
      FROM suppliers s
      LEFT JOIN (
        SELECT
          supplier_id,
          SUM(total) AS total_purchases,
          SUM(paid_amount) AS total_paid_invoices,
          MAX(invoice_date) AS last_invoice_date
        FROM invoices
        WHERE ${invWhere}
        GROUP BY supplier_id
      ) inv ON inv.supplier_id = s.id
      LEFT JOIN (
        SELECT
          supplier_id,
          SUM(amount) AS total_payments
        FROM cash_out
        WHERE ${payWhere}
        GROUP BY supplier_id
      ) pay ON pay.supplier_id = s.id
      LEFT JOIN opening o ON o.supplier_id = s.id
      ${whereClause}
      ORDER BY balance_due DESC, s.name ASC
      `,
      values,
    );

    res.json(result.rows);
  } catch (err) {
    console.error("SUPPLIER BALANCES ERROR:", err);
    res.status(500).json({ error: "Server error", details: err.message });
  }
};

exports.getSupplierDebtDetails = async (req, res) => {
  try {
    const { supplier_id, from, to, warehouse_id } = req.query;

    if (!supplier_id) {
      return res.status(400).json({ error: "supplier_id مطلوب" });
    }

    let invoiceConditions = [
      "i.supplier_id = $1",
      "i.movement_type = 'purchase'",
      "i.is_void IS NOT TRUE",
    ];
    let paymentExtra = "";
    let values = [supplier_id];
    let idx = 2;

    if (warehouse_id) {
      invoiceConditions.push(`i.branch_id = $${idx}`);
      paymentExtra += ` AND co.branch_id = $${idx}`;
      values.push(warehouse_id);
      idx++;
    }

    if (from) {
      invoiceConditions.push(`i.invoice_date >= $${idx++}`);
      values.push(from);
    }
    if (to) {
      invoiceConditions.push(`i.invoice_date <= $${idx++}`);
      values.push(to);
    }

    const invoiceWhere = `WHERE ${invoiceConditions.join(" AND ")}`;

    const result = await pool.query(
      `
      -- فواتير مشتريات
      SELECT
        'invoice' AS record_type,
        i.id AS record_id,
        i.invoice_date AS record_date,
        i.total,
        i.paid_amount,
        i.remaining_amount,
        COALESCE(i.previous_balance, 0) AS previous_balance,
        NULL AS notes,
        NULL AS permission_number
      FROM invoices i
      ${invoiceWhere}

      UNION ALL

      -- دفعات المورد
      SELECT
        'payment' AS record_type,
        co.id AS record_id,
        co.transaction_date AS record_date,
        0 AS total,
        co.amount AS paid_amount,
        0 AS remaining_amount,
        0 AS previous_balance,
        co.notes,
        co.permission_number
      FROM cash_out co
      WHERE co.supplier_id = $1
        AND co.entry_type = 'supplier_payment'
      ${paymentExtra}
      ${from ? `AND co.transaction_date >= '${from}'` : ""}
      ${to ? `AND co.transaction_date <= '${to}'` : ""}

      ORDER BY record_date ASC, record_id ASC
      `,
      values,
    );

    res.json(result.rows);
  } catch (err) {
    console.error("SUPPLIER DEBT DETAILS ERROR:", err);
    res.status(500).json({ error: "Server error", details: err.message });
  }
};

/* ===============================
   📈 ربحية المبيعات حسب الفواتير
   - فواتير بيع فقط
  - قيمة البيع المعتمدة = الإجمالي النهائي للفواتير بعد استبعاد الحساب السابق
  - صافي الربح = قيمة البيع المعتمدة - إجمالي تكلفة الشراء
  - بنود المرتجع لا تدخل في تكلفة التقرير
================================ */
exports.getInvoiceSalesProfit = async (req, res) => {
  try {
    await ensureInvoiceItemsCostPriceColumn();

    const {
      branch_id,
      invoice_type,
      customer_name,
      date_from,
      date_to,
      invoice_id,
    } = req.query;

    const conditions = ["i.movement_type = 'sale'", "i.is_void IS NOT TRUE"];
    const values = [];
    let idx = 1;

    if (invoice_id) {
      conditions.push(`i.id = $${idx++}`);
      values.push(Number(invoice_id));
    }

    if (branch_id) {
      conditions.push(`i.branch_id = $${idx++}`);
      values.push(Number(branch_id));
    }

    if (invoice_type) {
      conditions.push(`i.invoice_type = $${idx++}`);
      values.push(invoice_type);
    }

    if (customer_name) {
      conditions.push(`i.customer_name ILIKE $${idx++}`);
      values.push(`%${customer_name}%`);
    }

    if (date_from) {
      conditions.push(
        `COALESCE(i.invoice_date::date, i.created_at::date) >= $${idx++}::date`,
      );
      values.push(date_from);
    }

    if (date_to) {
      conditions.push(
        `COALESCE(i.invoice_date::date, i.created_at::date) <= $${idx++}::date`,
      );
      values.push(date_to);
    }

    const whereClause = `WHERE ${conditions.join(" AND ")}`;

    const result = await pool.query(
      `
      SELECT
        i.id AS invoice_id,
        i.branch_id,
        i.invoice_type,
        COALESCE(i.invoice_date::date, i.created_at::date) AS invoice_date,
        COALESCE(NULLIF(TRIM(i.customer_name), ''), 'عميل نقدي') AS customer_name,

        (COALESCE(i.total, 0) + COALESCE(i.previous_balance, 0)) AS final_total_with_previous,
        COALESCE(i.previous_balance, 0) AS previous_balance,

        SUM(
          CASE
            WHEN COALESCE(ii.is_return, false) THEN 0
            ELSE COALESCE(ii.quantity, 0)
              * COALESCE(
                  ii.cost_price,
                  CASE
                    WHEN i.invoice_type = 'retail'
                      THEN COALESCE(p.retail_purchase_price, p.purchase_price, 0)
                    ELSE COALESCE(p.purchase_price, 0)
                  END
                )
          END
        ) AS total_cost

      FROM invoices i
      JOIN invoice_items ii ON ii.invoice_id = i.id
      JOIN products p ON p.id = ii.product_id
      ${whereClause}
      GROUP BY i.id, i.branch_id, i.invoice_type, COALESCE(i.invoice_date::date, i.created_at::date), i.customer_name, i.total, i.previous_balance
      ORDER BY i.id DESC
      `,
      values,
    );

    const rows = result.rows.map((row) => {
      const finalTotalWithPrevious = Number(row.final_total_with_previous || 0);
      const previousBalance = Number(row.previous_balance || 0);
      const itemsTotal =
        Math.round((finalTotalWithPrevious - previousBalance) * 100) / 100;
      const totalCost = Number(row.total_cost || 0);

      return {
        invoice_id: Number(row.invoice_id),
        branch_id: Number(row.branch_id),
        invoice_type: row.invoice_type,
        invoice_date: row.invoice_date,
        customer_name: row.customer_name,
        items_total_after_discount: itemsTotal,
        total_cost: totalCost,
        net_profit: itemsTotal - totalCost,
      };
    });

    res.json(rows);
  } catch (err) {
    console.error("INVOICE SALES PROFIT ERROR:", err);
    res.status(500).json({ error: "Server error", details: err.message });
  }
};
