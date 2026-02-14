const pool = require("../db");

/* ===============================
   📦 تقرير جرد المخزن الشامل
   وارد + منصرف + رصيد حالي
================================ */
exports.getInventorySummary = async (req, res) => {
  try {
    const { warehouse_id } = req.query;

    let filter = "";
    let values = [];

    if (warehouse_id) {
      filter = "WHERE s.warehouse_id = $1";
      values.push(warehouse_id);
    }

    const result = await pool.query(
      `
    SELECT
      p.id AS product_id,
      p.name AS product_name,
      p.manufacturer AS manufacturer_name, -- ✅ المصنع من جدول المنتجات
      w.name AS warehouse_name,

      COALESCE(SUM(
        CASE 
          WHEN sm.movement_type IN ('purchase','transfer_in','replace_in')
          THEN sm.quantity ELSE 0 END
      ), 0) AS total_in,

      COALESCE(SUM(
        CASE 
          WHEN sm.movement_type IN ('sale','transfer_out','replace_out')
          THEN sm.quantity ELSE 0 END
      ), 0) AS total_out,

      COALESCE(s.quantity, 0) AS current_stock,

      -- العبوات المستخدمة في الحركات
      (
        SELECT string_agg(DISTINCT ii.package, '، ')
        FROM stock_movements sm2
        JOIN invoice_items ii ON ii.invoice_id = sm2.invoice_id AND ii.product_id = sm2.product_id
        WHERE sm2.product_id = p.id AND sm2.warehouse_id = s.warehouse_id
        AND ii.package IS NOT NULL AND ii.package != ''
      ) AS packages,

      (
        COALESCE(SUM(
          CASE 
            WHEN sm.movement_type IN ('purchase','transfer_in','replace_in')
            THEN sm.quantity ELSE 0 END
        ), 0)
        -
        COALESCE(SUM(
          CASE 
            WHEN sm.movement_type IN ('sale','transfer_out','replace_out')
            THEN sm.quantity ELSE 0 END
        ), 0)
      ) AS expected_stock,

      (
        COALESCE(s.quantity, 0)
        -
        (
          COALESCE(SUM(
            CASE 
              WHEN sm.movement_type IN ('purchase','transfer_in','replace_in')
              THEN sm.quantity ELSE 0 END
          ), 0)
          -
          COALESCE(SUM(
            CASE 
              WHEN sm.movement_type IN ('sale','transfer_out','replace_out')
              THEN sm.quantity ELSE 0 END
          ), 0)
        )
      ) AS stock_difference

    FROM products p
    -- ❌ شلنا JOIN manufacturers لأنه مش موجود
    LEFT JOIN stock s ON s.product_id = p.id
    LEFT JOIN warehouses w ON w.id = s.warehouse_id
    LEFT JOIN stock_movements sm
      ON sm.product_id = p.id
      AND sm.warehouse_id = s.warehouse_id

    ${warehouse_id ? "WHERE s.warehouse_id = $1" : ""}

    GROUP BY p.id, p.name, p.manufacturer, w.name, s.quantity

    HAVING 
      COALESCE(SUM(CASE WHEN sm.movement_type IN ('purchase','transfer_in','replace_in') THEN sm.quantity ELSE 0 END),0) > 0
      OR COALESCE(SUM(CASE WHEN sm.movement_type IN ('sale','transfer_out','replace_out') THEN sm.quantity ELSE 0 END),0) > 0
      OR COALESCE(s.quantity,0) > 0

    ORDER BY ABS(
      COALESCE(s.quantity, 0)
      -
      (
        COALESCE(SUM(CASE WHEN sm.movement_type IN ('purchase','transfer_in','replace_in') THEN sm.quantity ELSE 0 END),0)
        -
        COALESCE(SUM(CASE WHEN sm.movement_type IN ('sale','transfer_out','replace_out') THEN sm.quantity ELSE 0 END),0)
      )
    ) DESC;
      `,
      warehouse_id ? [warehouse_id] : [],
    );

    res.json(result.rows);
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
    const { product_name, warehouse_id, from, to, party_name } = req.query;

    if (!product_name) {
      return res.status(400).json({ error: "product_name مطلوب" });
    }

    let conditions = ["LOWER(p.name) LIKE LOWER($1)"];
    let values = [`%${product_name}%`];
    let idx = 2;

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

        -- اسم العميل أو المورد من الفاتورة
        i.customer_name AS party_name,

        -- نوع الفاتورة (بيع / شراء)
        i.invoice_type,

        -- العبوة المستخدمة من بنود الفاتورة
        ii.package AS package_name

      FROM stock_movements sm
      JOIN products p ON p.id = sm.product_id
      JOIN warehouses w ON w.id = sm.warehouse_id
      LEFT JOIN invoices i ON i.id = sm.invoice_id
      LEFT JOIN invoice_items ii ON ii.invoice_id = sm.invoice_id AND ii.product_id = sm.product_id

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

/* ===============================
   ⚠️ تقرير نقص المخزون
================================ */
exports.getLowStock = async (req, res) => {
  try {
    const { limit_quantity = 5, warehouse_id } = req.query;

    let where = "WHERE s.quantity <= $1";
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
        (
          SELECT string_agg(DISTINCT ii.package, '\u060C ')
          FROM stock_movements sm2
          JOIN invoice_items ii ON ii.invoice_id = sm2.invoice_id AND ii.product_id = sm2.product_id
          WHERE sm2.product_id = p.id AND sm2.warehouse_id = s.warehouse_id
          AND ii.package IS NOT NULL AND ii.package != ''
        ) AS packages
      FROM stock s
      JOIN products p ON p.id = s.product_id
      JOIN warehouses w ON w.id = s.warehouse_id
      ${where}
      ORDER BY s.quantity ASC
      `,
      values,
    );

    res.json(result.rows);
  } catch (err) {
    console.error("LOW STOCK ERROR:", err);
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

        SUM(s.quantity * p.purchase_price) AS total_value -- 💰 قيمة المخزون

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
        p.purchase_price,
        (s.quantity * p.purchase_price) AS total_value,
        w.id AS warehouse_id,
        w.name AS warehouse_name,
        (
          SELECT string_agg(DISTINCT ii.package, '\u060C ')
          FROM stock_movements sm2
          JOIN invoice_items ii ON ii.invoice_id = sm2.invoice_id AND ii.product_id = sm2.product_id
          WHERE sm2.product_id = p.id AND sm2.warehouse_id = s.warehouse_id
          AND ii.package IS NOT NULL AND ii.package != ''
        ) AS packages
      FROM stock s
      JOIN products p ON p.id = s.product_id
      JOIN warehouses w ON w.id = s.warehouse_id
      ${where}
      ORDER BY w.name, p.name
      `,
      values,
    );

    res.json(result.rows);
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

    let conditions = [
      "i.movement_type = 'sale'",
      "i.remaining_amount > 0",
      "i.is_void = false",
    ];

    let values = [];
    let idx = 1;

    if (from) {
      conditions.push(`i.invoice_date >= $${idx++}`);
      values.push(from);
    }

    if (to) {
      conditions.push(`i.invoice_date <= $${idx++}`);
      values.push(to);
    }

    if (customer_name) {
      conditions.push(`i.customer_name ILIKE $${idx++}`);
      values.push(`%${customer_name}%`);
    }

    // ✅ الفصل بين الجملة والقطاعي عن طريق الفرع
    if (warehouse_id) {
      conditions.push(`i.branch_id = $${idx++}`);
      values.push(warehouse_id);
    }

    const whereClause = `WHERE ${conditions.join(" AND ")}`;

    const result = await pool.query(
      `
      SELECT
        i.customer_name,
        SUM(i.total) AS total_sales,
        SUM(i.paid_amount) + COALESCE(cp.extra_paid, 0) AS total_paid,
        GREATEST(
          SUM(i.remaining_amount) - COALESCE(cp.extra_paid, 0),
          0
        ) AS balance_due,
        MAX(i.invoice_date) AS last_invoice_date
      FROM invoices i
      LEFT JOIN (
        SELECT customer_name, SUM(amount) AS extra_paid
        FROM cash_in
        WHERE source_type = 'customer_payment'
        GROUP BY customer_name
      ) cp ON cp.customer_name = i.customer_name
      ${whereClause}
      GROUP BY i.customer_name, cp.extra_paid
      HAVING GREATEST(
        SUM(i.remaining_amount) - COALESCE(cp.extra_paid, 0),
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
