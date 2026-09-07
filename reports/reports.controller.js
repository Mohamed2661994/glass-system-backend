const pool = require("../db");

async function ensureInvoiceItemsCostPriceColumn() {
  // Column cost_price already exists in schema - avoid unnecessary DDL locks/permission errors
  return;
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
          WHEN sm.movement_type IN ('purchase','transfer_in','replace_in','return_sale','inter_branch_in')
          THEN sm.quantity ELSE 0 END
      ), 0) AS total_in,

      COALESCE(SUM(
        CASE 
          WHEN sm.movement_type IN ('sale','transfer_out','replace_out','return_purchase','inter_branch_out')
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

    WHERE p.is_active = true
    ${warehouse_id ? "AND s.warehouse_id = $1" : ""}

    GROUP BY p.id, p.name, p.manufacturer, w.name, p.wholesale_package, p.retail_package, s.quantity, s.variant_id

    HAVING 
      COALESCE(SUM(CASE WHEN sm.movement_type IN ('purchase','transfer_in','replace_in','return_sale','inter_branch_in') THEN sm.quantity ELSE 0 END),0) > 0
      OR COALESCE(SUM(CASE WHEN sm.movement_type IN ('sale','transfer_out','replace_out','return_purchase','inter_branch_out') THEN sm.quantity ELSE 0 END),0) > 0
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
      return res
        .status(400)
        .json({ error: "product_id أو product_name مطلوب" });
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
      conditions.push(`LOWER(TRIM(p.manufacturer)) = $${idx++}`);
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
    const { search, manufacturer, limit = 50 } = req.query;
    const normalizedSearch = String(search || "").trim();
    const normalizedManufacturer = String(manufacturer || "")
      .trim()
      .toLowerCase();
    const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 100));

    if (!normalizedSearch && !normalizedManufacturer) {
      return res.json([]);
    }

    const values = [];
    const conditions = [];
    let paramIdx = 1;

    if (normalizedSearch) {
      values.push(`%${normalizedSearch}%`);
      conditions.push(
        `(p.name ILIKE $${paramIdx} OR COALESCE(p.manufacturer, '') ILIKE $${paramIdx} OR COALESCE(p.barcode, '') ILIKE $${paramIdx} OR CAST(p.id AS TEXT) ILIKE $${paramIdx})`,
      );
      paramIdx++;
    }

    if (normalizedManufacturer) {
      values.push(`${normalizedManufacturer}`);
      conditions.push(
        `LOWER(TRIM(COALESCE(p.manufacturer, ''))) = $${paramIdx}`,
      );
      paramIdx++;
    }

    values.push(safeLimit);

    const result = await pool.query(
      `
      WITH first_purchase AS (
        SELECT
          ii.product_id,
          MIN(COALESCE(i.invoice_date::date, i.created_at::date)) AS first_purchase_date
        FROM invoice_items ii
        JOIN invoices i ON i.id = ii.invoice_id
        WHERE i.movement_type = 'purchase'
          AND i.is_void IS NOT TRUE
          AND COALESCE(ii.is_return, false) IS NOT TRUE
        GROUP BY ii.product_id
      )
      SELECT
        p.id,
        p.name,
        p.manufacturer,
        fp.first_purchase_date AS created_at
      FROM products p
      LEFT JOIN first_purchase fp ON fp.product_id = p.id
      WHERE ${conditions.join(" AND ")}
      ORDER BY p.name ASC
      LIMIT $${paramIdx}
      `,
      values,
    );

    res.json(result.rows);
  } catch (err) {
    console.error("GET PRODUCTS ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
};

exports.getProductSalesProfit = async (req, res) => {
  try {
    await ensureInvoiceItemsCostPriceColumn();

    const { product_ids, branch_id, invoice_type, date_from, date_to } =
      req.query;

    const parsedProductIds = String(product_ids || "")
      .split(",")
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isInteger(value) && value > 0);

    if (parsedProductIds.length === 0) {
      return res.status(400).json({ error: "product_ids مطلوبة" });
    }

    const values = [parsedProductIds];
    const invoiceConditions = [
      "i.movement_type = 'sale'",
      "i.is_void IS NOT TRUE",
    ];
    let idx = 2;

    if (branch_id) {
      invoiceConditions.push(`i.branch_id = $${idx++}`);
      values.push(Number(branch_id));
    }

    if (invoice_type) {
      invoiceConditions.push(`i.invoice_type = $${idx++}`);
      values.push(invoice_type);
    }

    if (date_from) {
      invoiceConditions.push(
        `COALESCE(i.invoice_date::date, i.created_at::date) >= $${idx++}::date`,
      );
      values.push(date_from);
    }

    if (date_to) {
      invoiceConditions.push(
        `COALESCE(i.invoice_date::date, i.created_at::date) <= $${idx++}::date`,
      );
      values.push(date_to);
    }

    const selectionStartDateParam = `$${idx++}`;
    values.push(date_from || null);

    const result = await pool.query(
      `
      WITH first_purchase AS (
        SELECT
          ii.product_id,
          MIN(COALESCE(i.invoice_date::date, i.created_at::date)) AS first_purchase_date
        FROM invoice_items ii
        JOIN invoices i ON i.id = ii.invoice_id
        WHERE i.movement_type = 'purchase'
          AND i.is_void IS NOT TRUE
          AND COALESCE(ii.is_return, false) IS NOT TRUE
        GROUP BY ii.product_id
      ),
      selected_products AS (
        SELECT
          p.id AS product_id,
          p.name AS product_name,
          COALESCE(NULLIF(TRIM(p.manufacturer), ''), 'بدون مصنع') AS manufacturer_name,
          fp.first_purchase_date AS product_created_at
        FROM products p
        LEFT JOIN first_purchase fp ON fp.product_id = p.id
        WHERE p.id = ANY($1::int[])
      ),
      invoice_scope AS (
        SELECT
          i.id AS invoice_id,
          i.branch_id,
          i.invoice_type,
          COALESCE(i.invoice_date::date, i.created_at::date) AS invoice_date,
          COALESCE(i.total, 0) AS invoice_total,
          COALESCE(i.apply_items_discount, true) AS apply_items_discount
        FROM invoices i
        WHERE ${invoiceConditions.join(" AND ")}
      ),
      selected_invoice_ids AS (
        SELECT DISTINCT ii.invoice_id
        FROM invoice_items ii
        JOIN selected_products sp ON sp.product_id = ii.product_id
        JOIN invoice_scope inv ON inv.invoice_id = ii.invoice_id
      ),
      invoice_items_scoped AS (
        SELECT
          ii.invoice_id,
          ii.product_id,
          inv.branch_id,
          inv.invoice_type,
          inv.invoice_date,
          inv.invoice_total,
          CASE
            WHEN COALESCE(inv.apply_items_discount, true) = false THEN
              CASE
                WHEN COALESCE(ii.is_return, false) THEN -(COALESCE(ii.quantity, 0) * COALESCE(ii.price, 0))
                ELSE (COALESCE(ii.quantity, 0) * COALESCE(ii.price, 0))
              END
            ELSE
              CASE
                WHEN COALESCE(ii.is_return, false)
                  THEN -COALESCE(
                    ii.total,
                    COALESCE(ii.quantity, 0)
                      * (COALESCE(ii.price, 0) - COALESCE(ii.discount, 0))
                  )
                ELSE COALESCE(
                  ii.total,
                  COALESCE(ii.quantity, 0)
                    * (COALESCE(ii.price, 0) - COALESCE(ii.discount, 0))
                )
              END
          END AS signed_item_total,
          CASE
            WHEN COALESCE(ii.is_return, false)
              THEN -COALESCE(ii.quantity, 0)
            ELSE COALESCE(ii.quantity, 0)
          END AS signed_quantity,
          CASE
            WHEN COALESCE(ii.is_return, false) THEN 0
            ELSE COALESCE(ii.quantity, 0)
              * COALESCE(
                  ii.cost_price,
                  CASE
                    WHEN inv.invoice_type = 'retail'
                      THEN COALESCE(p.retail_purchase_price, p.purchase_price, 0)
                    ELSE COALESCE(p.purchase_price, 0)
                  END
                )
          END AS total_cost,
          SUM(
            CASE
              WHEN COALESCE(inv.apply_items_discount, true) = false THEN
                CASE
                  WHEN COALESCE(ii.is_return, false) THEN -(COALESCE(ii.quantity, 0) * COALESCE(ii.price, 0))
                  ELSE (COALESCE(ii.quantity, 0) * COALESCE(ii.price, 0))
                END
              ELSE
                CASE
                  WHEN COALESCE(ii.is_return, false)
                    THEN -COALESCE(
                      ii.total,
                      COALESCE(ii.quantity, 0)
                        * (COALESCE(ii.price, 0) - COALESCE(ii.discount, 0))
                    )
                  ELSE COALESCE(
                    ii.total,
                    COALESCE(ii.quantity, 0)
                      * (COALESCE(ii.price, 0) - COALESCE(ii.discount, 0))
                  )
                END
            END
          ) OVER (PARTITION BY ii.invoice_id) AS invoice_items_total
        FROM invoice_scope inv
        JOIN selected_invoice_ids sii ON sii.invoice_id = inv.invoice_id
        JOIN invoice_items ii ON ii.invoice_id = inv.invoice_id
        JOIN products p ON p.id = ii.product_id
      ),
      selected_profit_rows AS (
        SELECT
          sp.product_id,
          sp.product_name,
          sp.manufacturer_name,
          sp.product_created_at,
          iis.invoice_id,
          iis.invoice_date,
          iis.signed_quantity,
          CASE
            WHEN iis.invoice_items_total = 0 THEN iis.signed_item_total
            ELSE iis.signed_item_total
              - (
                  (iis.invoice_items_total - iis.invoice_total)
                  * (iis.signed_item_total / iis.invoice_items_total)
                )
          END AS sales_total_after_discount,
          iis.total_cost
        FROM selected_products sp
        LEFT JOIN invoice_items_scoped iis ON iis.product_id = sp.product_id
        WHERE iis.invoice_id IS NULL
          OR iis.invoice_date >= COALESCE(
            ${selectionStartDateParam}::date,
            sp.product_created_at,
            iis.invoice_date
          )
      ),
      aggregated_profit AS (
        SELECT
          spr.product_id,
          COUNT(DISTINCT spr.invoice_id) FILTER (
            WHERE spr.invoice_id IS NOT NULL
          ) AS invoices_count,
          MIN(spr.invoice_date) AS first_sale_date,
          MAX(spr.invoice_date) AS last_sale_date,
          COALESCE(SUM(spr.signed_quantity), 0) AS sold_quantity,
          COALESCE(SUM(spr.sales_total_after_discount), 0) AS sales_total_after_discount,
          COALESCE(SUM(spr.total_cost), 0) AS total_cost
        FROM selected_profit_rows spr
        GROUP BY spr.product_id
      )
      SELECT
        sp.product_id,
        sp.product_name,
        sp.manufacturer_name,
        sp.product_created_at,
        COALESCE(ap.invoices_count, 0) AS invoices_count,
        ap.first_sale_date,
        ap.last_sale_date,
        COALESCE(ap.sold_quantity, 0) AS sold_quantity,
        COALESCE(ap.sales_total_after_discount, 0) AS sales_total_after_discount,
        COALESCE(ap.total_cost, 0) AS total_cost
      FROM selected_products sp
      LEFT JOIN aggregated_profit ap ON ap.product_id = sp.product_id
      ORDER BY sp.product_name ASC
      `,
      values,
    );

    const rows = result.rows.map((row) => {
      const salesTotal = Number(row.sales_total_after_discount || 0);
      const totalCost = Number(row.total_cost || 0);
      const netProfit = salesTotal - totalCost;

      return {
        product_id: Number(row.product_id),
        product_name: row.product_name,
        manufacturer_name: row.manufacturer_name,
        product_created_at: row.product_created_at,
        invoices_count: Number(row.invoices_count || 0),
        first_sale_date: row.first_sale_date,
        last_sale_date: row.last_sale_date,
        sold_quantity: Number(row.sold_quantity || 0),
        sales_total_after_discount: Math.round(salesTotal * 100) / 100,
        total_cost: Math.round(totalCost * 100) / 100,
        net_profit: Math.round(netProfit * 100) / 100,
      };
    });

    res.json(rows);
  } catch (err) {
    console.error("PRODUCT SALES PROFIT ERROR:", err);
    res.status(500).json({ error: "Server error", details: err.message });
  }
};

exports.getCustomerBalances = async (req, res) => {
  try {
    const { from, to, customer_name, warehouse_id } = req.query;

    let conditions_main = ["i.movement_type = 'sale'", "i.is_void = false"];
    let conditions_cte = ["movement_type = 'sale'", "is_void = false"];
    let conditions_cash = ["source_type = 'customer_payment'"];

    let values = [];
    let idx = 1;

    if (from) {
      const p = "$" + idx++;
      conditions_main.push("i.invoice_date >= " + p);
      conditions_cte.push("invoice_date >= " + p);
      conditions_cash.push("created_at >= " + p);
      values.push(from);
    }

    if (to) {
      const p = "$" + idx++;
      conditions_main.push("i.invoice_date <= " + p);
      conditions_cte.push("invoice_date <= " + p);
      conditions_cash.push("created_at <= " + p);
      values.push(to);
    }

    if (customer_name) {
      const p = "$" + idx++;
      conditions_main.push("i.customer_name ILIKE " + p);
      conditions_cte.push("customer_name ILIKE " + p);
      conditions_cash.push("customer_name ILIKE " + p);
      values.push("%" + customer_name + "%");
    }

    if (warehouse_id) {
      const p = "$" + idx++;
      conditions_main.push("i.branch_id = " + p);
      conditions_cte.push("branch_id = " + p);
      conditions_cash.push("branch_id = " + p);
      values.push(warehouse_id);
    }

    const mainWhere = "WHERE " + conditions_main.join(" AND ");
    const cteWhere = "WHERE " + conditions_cte.join(" AND ");
    const cashWhere = "WHERE " + conditions_cash.join(" AND ");

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
        ${cashWhere}
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

    let invoiceConditions = [
      "i.customer_name = $1",
      "i.movement_type = 'sale'",
      "i.is_void = false",
    ];
    let paymentConditions = [
      "cp.source_type = 'customer_payment'",
      "cp.customer_name = $1",
    ];

    let values = [customer_name];
    let idx = 2;

    if (from) {
      const param = `$${idx++}`;
      invoiceConditions.push(`i.invoice_date >= ${param}`);
      paymentConditions.push(`cp.created_at >= ${param}`);
      values.push(from);
    }

    if (to) {
      const param = `$${idx++}`;
      invoiceConditions.push(`i.invoice_date <= ${param}`);
      paymentConditions.push(`cp.created_at <= ${param}`);
      values.push(to);
    }

    if (warehouse_id) {
      const param = `$${idx++}`;
      invoiceConditions.push(`i.branch_id = ${param}`);
      paymentConditions.push(`cp.branch_id = ${param}`);
      values.push(warehouse_id);
    }

    const invoiceWhere = `WHERE ${invoiceConditions.join(" AND ")}`;
    const paymentWhere = `WHERE ${paymentConditions.join(" AND ")}`;

    const isBranch1 = Number(warehouse_id) === 1;
    const prevBalanceCol = isBranch1 ? "i.previous_balance" : "0 AS previous_balance";
    const additionalAmountCol = isBranch1 ? "i.additional_amount" : "0 AS additional_amount";

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
        i.remaining_amount,
        ${prevBalanceCol},
        ${additionalAmountCol}
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
        0 AS remaining_amount,
        0 AS previous_balance,
        0 AS additional_amount
      FROM cash_in cp
      ${paymentWhere}

      ORDER BY invoice_date ASC
      `,
      values,
    );

    let runningBalance = 0;
    const rows = result.rows.map((row) => {
      const paidAmount = Number(row.paid_amount || 0);
      const remainingAmount = Number(row.remaining_amount || 0);

      if (row.record_type === "invoice") {
        runningBalance = remainingAmount;
      } else {
        runningBalance -= paidAmount;
      }

      return {
        ...row,
        remaining_amount: runningBalance,
        running_balance: runningBalance,
      };
    });

    res.json(rows);
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

// ============================================================
//  حساب مديونية المخزن (عام واحد: المعرض ↔ المخزن)
//  balance_due = رصيد افتتاحي + Σ(قيمة التحويلات) − Σ(مدفوعات "سداد للمخزن")
//  الرصيد الافتتاحي وتاريخ البداية مخزّنين في app_settings.
// ============================================================
const WAREHOUSE_DEBT_OPENING_BALANCE_KEY = "warehouse_debt_opening_balance";
const WAREHOUSE_DEBT_OPENING_DATE_KEY = "warehouse_debt_opening_date";

async function readWarehouseAccountSettings() {
  const { rows } = await pool.query(
    `SELECT key, value FROM app_settings WHERE key = ANY($1)`,
    [[WAREHOUSE_DEBT_OPENING_BALANCE_KEY, WAREHOUSE_DEBT_OPENING_DATE_KEY]],
  );
  const map = {};
  for (const r of rows) map[r.key] = r.value;
  const opening_balance =
    Number(map[WAREHOUSE_DEBT_OPENING_BALANCE_KEY] || 0) || 0;
  const opening_date = map[WAREHOUSE_DEBT_OPENING_DATE_KEY] || null; // YYYY-MM-DD أو null
  return { opening_balance, opening_date };
}

exports.getWarehouseAccount = async (req, res) => {
  try {
    const { opening_balance, opening_date } = await readWarehouseAccountSettings();

    // لو فيه تاريخ بداية: نحسب التحويلات/المدفوعات من التاريخ ده فصاعدًا فقط
    const transferDateCond = opening_date
      ? `AND (st.created_at AT TIME ZONE 'Africa/Cairo')::date >= $1::date`
      : ``;
    const payDateCond = opening_date ? `AND co.transaction_date >= $1::date` : ``;
    const params = opening_date ? [opening_date] : [];

    // التحويلات (مدين) — قيمة البضاعة المسحوبة، باستثناء الملغيّة
    const transfersRes = await pool.query(
      `
      SELECT
        st.id                                             AS transfer_id,
        (st.created_at AT TIME ZONE 'Africa/Cairo')::date AS date,
        st.note                                           AS note,
        COALESCE(SUM(sti.total_price), 0)                 AS amount
      FROM stock_transfer_items sti
      JOIN stock_transfers st ON st.id = sti.transfer_id
      WHERE st.status IS DISTINCT FROM 'cancelled'
        AND sti.status IS DISTINCT FROM 'cancelled'
        ${transferDateCond}
      GROUP BY st.id, st.created_at, st.note
      ORDER BY st.created_at ASC, st.id ASC
      `,
      params,
    );

    // المدفوعات (دائن) — قيود "سداد للمخزن" من أي فرع
    const paymentsRes = await pool.query(
      `
      SELECT
        co.id,
        to_char(co.transaction_date, 'YYYY-MM-DD') AS date,
        co.permission_number,
        co.name,
        co.notes,
        co.branch_id,
        co.amount
      FROM cash_out co
      WHERE co.entry_type = 'warehouse_settlement'
        ${payDateCond}
      ORDER BY co.transaction_date ASC, co.id ASC
      `,
      params,
    );

    const transfers_total = transfersRes.rows.reduce(
      (s, r) => s + Number(r.amount || 0),
      0,
    );
    const payments_total = paymentsRes.rows.reduce(
      (s, r) => s + Number(r.amount || 0),
      0,
    );
    const balance_due = opening_balance + transfers_total - payments_total;

    // كشف حساب موحّد مرتّب بالتاريخ (التحويلات مدين، المدفوعات دائن)
    const ledger = [
      ...transfersRes.rows.map((r) => ({
        kind: "debit",
        date: r.date,
        ref: `تحويل #${r.transfer_id}`,
        transfer_id: r.transfer_id,
        note: r.note || null,
        amount: Number(r.amount || 0),
      })),
      ...paymentsRes.rows.map((r) => ({
        kind: "credit",
        date: r.date,
        ref: r.permission_number ? `إذن ${r.permission_number}` : `سداد #${r.id}`,
        cash_out_id: r.id,
        name: r.name || null,
        note: r.notes || null,
        branch_id: r.branch_id,
        amount: Number(r.amount || 0),
      })),
    ].sort((a, b) => {
      const da = new Date(a.date).getTime();
      const db = new Date(b.date).getTime();
      if (da !== db) return da - db;
      if (a.kind === b.kind) return 0;
      return a.kind === "debit" ? -1 : 1; // التحويل قبل السداد في نفس اليوم
    });

    res.json({
      opening_balance,
      opening_date,
      transfers_total,
      payments_total,
      balance_due,
      ledger,
    });
  } catch (err) {
    console.error("WAREHOUSE ACCOUNT ERROR:", err);
    res.status(500).json({ error: "Server error", details: err.message });
  }
};

exports.setWarehouseAccountOpening = async (req, res) => {
  try {
    const { opening_balance, opening_date } = req.body || {};

    const balanceNum = Number(opening_balance);
    if (!Number.isFinite(balanceNum)) {
      return res.status(400).json({ error: "الرصيد الافتتاحي غير صحيح" });
    }
    if (opening_date && !/^\d{4}-\d{2}-\d{2}$/.test(String(opening_date))) {
      return res.status(400).json({ error: "تاريخ البداية غير صحيح" });
    }

    await pool.query(
      `
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      `,
      [WAREHOUSE_DEBT_OPENING_BALANCE_KEY, String(balanceNum)],
    );
    await pool.query(
      `
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      `,
      [WAREHOUSE_DEBT_OPENING_DATE_KEY, opening_date ? String(opening_date) : null],
    );

    res.json({
      success: true,
      opening_balance: balanceNum,
      opening_date: opening_date || null,
    });
  } catch (err) {
    console.error("SET WAREHOUSE OPENING ERROR:", err);
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

/* ===============================
   🏭 تقرير تحليلات وتفاصيل المصانع الشاملة
   عرض الإحصائيات الكاملة، الأرباح، العدادات، المخزون، والشارات
================================ */
exports.getManufacturerAnalytics = async (req, res) => {
  try {
    await ensureInvoiceItemsCostPriceColumn();

    const {
      manufacturer,
      branch_id,
      invoice_type,
      date_from,
      date_to,
      search,
      page = 1,
      limit = 50,
      chart_invoice_type,
      timeline_interval,
      apply_distribution,
    } = req.query;

    const normalizedManufacturer = String(manufacturer || "").trim().toLowerCase();
    const isApplyDistribution = apply_distribution === 'true';

    // 1. Fetch products (either belonging to a specific manufacturer, or ALL if omitted/'all')
    let productsQuery = `
      SELECT
        p.id,
        p.name,
        p.id AS sku,
        p.manufacturer,
        p.purchase_price,
        p.retail_purchase_price,
        p.retail_price,
        p.wholesale_price,
        p.wholesale_package,
        p.retail_package,
        p.created_at,
        p.is_active
      FROM products p
      WHERE (p.is_active IS NOT FALSE OR EXISTS (SELECT 1 FROM stock s WHERE s.product_id = p.id AND s.quantity != 0))
    `;
    let queryParams = [];

    if (normalizedManufacturer && normalizedManufacturer !== "all") {
      productsQuery += ` AND LOWER(TRIM(p.manufacturer)) = LOWER(TRIM($1))`;
      queryParams.push(normalizedManufacturer);
    }

    productsQuery += ` ORDER BY p.name ASC`;

    const productsRes = await pool.query(productsQuery, queryParams);

    if (productsRes.rows.length === 0) {
      return res.json({
        summary: {
          manufacturer: manufacturer,
          total_products_count: 0,
          total_acquired_qty: 0,
          total_acquired_cost: 0,
          total_sold_qty: 0,
          total_sales_amount: 0,
          total_cost_of_goods_sold: 0,
          total_net_profit: 0,
          profit_margin_percent: 0,
          current_stock_qty: 0,
          current_stock_valuation_cost: 0,
          sell_through_percent: 0,
          remaining_stock_percent: 0,
          is_date_filtered: Boolean(date_from || date_to),
        },
        champions: {},
        products: [],
        pagination: { page: 1, limit: Number(limit), total_pages: 0, total_items: 0 }
      });
    }

    const productIds = productsRes.rows.map(p => p.id);

    let stockWhere = "WHERE 1=1";
    const stockValues = [];
    let stockIdx = 1;

    if (normalizedManufacturer && normalizedManufacturer !== "all") {
      stockWhere += ` AND s.product_id IN (SELECT id FROM products WHERE LOWER(TRIM(manufacturer)) = LOWER(TRIM($${stockIdx++})))`;
      stockValues.push(normalizedManufacturer);
    } else {
      stockWhere += ` AND s.product_id IN (SELECT id FROM products)`;
    }

    if (branch_id) {
      stockWhere += ` AND s.warehouse_id = $${stockIdx++}`;
      stockValues.push(Number(branch_id));
    }

    const stockRes = await pool.query(
      `
      SELECT
        s.product_id,
        COALESCE(SUM(s.quantity), 0) AS current_stock,
        COALESCE(SUM(CASE WHEN s.warehouse_id = 1 THEN s.quantity ELSE 0 END), 0) AS retail_stock,
        COALESCE(SUM(CASE WHEN s.warehouse_id = 2 THEN s.quantity ELSE 0 END), 0) AS wholesale_stock
      FROM stock s
      ${stockWhere}
      GROUP BY s.product_id
      `,
      stockValues
    );

    const stockMap = {};
    for (const row of stockRes.rows) {
      stockMap[row.product_id] = {
        total: Number(row.current_stock || 0),
        retail: Number(row.retail_stock || 0),
        wholesale: Number(row.wholesale_stock || 0)
      };
    }

    // 3. Fetch sales & profit per product from invoice_items + invoices
    const salesValues = [];
    let idx = 1;

    let manufacturerCondition = "WHERE (p.is_active IS NOT FALSE OR EXISTS (SELECT 1 FROM stock s WHERE s.product_id = p.id AND s.quantity != 0))";
    if (normalizedManufacturer && normalizedManufacturer !== "all") {
      manufacturerCondition += ` AND LOWER(TRIM(p.manufacturer)) = LOWER(TRIM($${idx++}))`;
      salesValues.push(normalizedManufacturer);
    }

    const invoiceConditions = [
      "i.movement_type = 'sale'",
      "i.is_void IS NOT TRUE"
    ];

    if (branch_id) {
      invoiceConditions.push(`i.branch_id = $${idx++}`);
      salesValues.push(Number(branch_id));
    }
    if (invoice_type) {
      invoiceConditions.push(`i.invoice_type = $${idx++}`);
      salesValues.push(invoice_type);
    }
    if (date_from) {
      invoiceConditions.push(`COALESCE(i.invoice_date::date, i.created_at::date) >= $${idx++}::date`);
      salesValues.push(date_from);
    }
    if (date_to) {
      invoiceConditions.push(`COALESCE(i.invoice_date::date, i.created_at::date) <= $${idx++}::date`);
      salesValues.push(date_to);
    }

    const salesQuery = `
      WITH selected_products AS (
        SELECT p.id AS product_id
        FROM products p
        ${manufacturerCondition}
      ),
      invoice_scope AS (
        SELECT 
          i.id AS invoice_id, 
          i.branch_id, 
          i.invoice_type, 
          COALESCE(i.invoice_date::date, i.created_at::date) AS invoice_date, 
          COALESCE(i.total, 0) AS invoice_total,
          COALESCE(i.apply_items_discount, true) AS apply_items_discount
        FROM invoices i
        WHERE ${invoiceConditions.join(" AND ")}
      ),
      selected_invoice_ids AS (
        SELECT DISTINCT ii.invoice_id
        FROM invoice_items ii
        JOIN selected_products sp ON sp.product_id = ii.product_id
        JOIN invoice_scope inv ON inv.invoice_id = ii.invoice_id
      ),
      invoice_items_scoped AS (
        SELECT
          ii.invoice_id,
          ii.product_id,
          ii.quantity, ii.price, ii.discount, ii.total, ii.is_return, ii.cost_price,
          inv.branch_id, inv.invoice_type, inv.invoice_date, inv.invoice_total, inv.apply_items_discount,
          p.purchase_price, p.retail_purchase_price,
          CASE
            WHEN COALESCE(inv.apply_items_discount, true) = false THEN
              CASE WHEN COALESCE(ii.is_return, false) THEN -(COALESCE(ii.quantity, 0) * COALESCE(ii.price, 0))
              ELSE (COALESCE(ii.quantity, 0) * COALESCE(ii.price, 0)) END
            ELSE
              CASE WHEN COALESCE(ii.is_return, false)
                THEN -COALESCE(ii.total, COALESCE(ii.quantity, 0) * (COALESCE(ii.price, 0) - COALESCE(ii.discount, 0)))
              ELSE COALESCE(ii.total, COALESCE(ii.quantity, 0) * (COALESCE(ii.price, 0) - COALESCE(ii.discount, 0))) END
          END AS signed_item_total,
          SUM(
            CASE
              WHEN COALESCE(inv.apply_items_discount, true) = false THEN
                CASE WHEN COALESCE(ii.is_return, false) THEN -(COALESCE(ii.quantity, 0) * COALESCE(ii.price, 0))
                ELSE (COALESCE(ii.quantity, 0) * COALESCE(ii.price, 0)) END
              ELSE
                CASE WHEN COALESCE(ii.is_return, false)
                  THEN -COALESCE(ii.total, COALESCE(ii.quantity, 0) * (COALESCE(ii.price, 0) - COALESCE(ii.discount, 0)))
                ELSE COALESCE(ii.total, COALESCE(ii.quantity, 0) * (COALESCE(ii.price, 0) - COALESCE(ii.discount, 0))) END
            END
          ) OVER (PARTITION BY ii.invoice_id) AS invoice_items_total
        FROM invoice_scope inv
        JOIN selected_invoice_ids sii ON sii.invoice_id = inv.invoice_id
        JOIN invoice_items ii ON ii.invoice_id = inv.invoice_id
        JOIN products p ON p.id = ii.product_id
      )
      SELECT
        iis.product_id,
        COUNT(DISTINCT iis.invoice_id) AS invoices_count,
        MIN(iis.invoice_date) AS first_sale_date,
        MAX(iis.invoice_date) AS last_sale_date,
        SUM(
          CASE WHEN COALESCE(iis.is_return, false) THEN -COALESCE(iis.quantity, 0)
          ELSE COALESCE(iis.quantity, 0) END
        ) AS signed_sold_quantity,
        SUM(
          CASE WHEN iis.branch_id = 1 THEN (CASE WHEN COALESCE(iis.is_return, false) THEN -COALESCE(iis.quantity, 0) ELSE COALESCE(iis.quantity, 0) END)
          ELSE 0 END
        ) AS retail_sold_quantity,
        SUM(
          CASE WHEN iis.branch_id = 2 THEN (CASE WHEN COALESCE(iis.is_return, false) THEN -COALESCE(iis.quantity, 0) ELSE COALESCE(iis.quantity, 0) END)
          ELSE 0 END
        ) AS wholesale_sold_quantity,
        SUM(
          CASE 
            WHEN ${isApplyDistribution ? 'true' : 'false'} THEN
              CASE
                WHEN iis.invoice_items_total = 0 THEN iis.signed_item_total
                ELSE iis.signed_item_total - ((iis.invoice_items_total - iis.invoice_total) * (iis.signed_item_total / iis.invoice_items_total))
              END
            ELSE
              iis.signed_item_total
          END
        ) AS signed_sales_total,
        SUM(
          CASE WHEN COALESCE(iis.is_return, false)
            THEN -(COALESCE(iis.quantity, 0) * COALESCE(iis.price, 0))
          ELSE (COALESCE(iis.quantity, 0) * COALESCE(iis.price, 0)) END
        ) AS signed_gross_sales,
        SUM(
          CASE
            WHEN COALESCE(iis.apply_items_discount, true) = false THEN 0
            WHEN COALESCE(iis.is_return, false)
              THEN -(COALESCE(iis.quantity, 0) * COALESCE(iis.discount, 0))
            ELSE (COALESCE(iis.quantity, 0) * COALESCE(iis.discount, 0)) END
        ) AS signed_item_discounts,
        SUM(
          CASE WHEN COALESCE(iis.is_return, false)
            THEN -(COALESCE(iis.quantity, 0) * COALESCE(iis.cost_price, CASE WHEN iis.invoice_type = 'retail' THEN COALESCE(iis.retail_purchase_price, iis.purchase_price, 0) ELSE COALESCE(iis.purchase_price, 0) END))
          ELSE COALESCE(iis.quantity, 0) * COALESCE(iis.cost_price, CASE WHEN iis.invoice_type = 'retail' THEN COALESCE(iis.retail_purchase_price, iis.purchase_price, 0) ELSE COALESCE(iis.purchase_price, 0) END) END
        ) AS total_cost
      FROM invoice_items_scoped iis
      JOIN selected_products sp ON sp.product_id = iis.product_id
      GROUP BY iis.product_id
    `;
    
    const salesRes = await pool.query(salesQuery, salesValues);

    const salesMap = {};
    for (const row of salesRes.rows) {
      salesMap[row.product_id] = {
        invoices_count: Number(row.invoices_count || 0),
        first_sale_date: row.first_sale_date,
        last_sale_date: row.last_sale_date,
        sold_quantity: Number(row.signed_sold_quantity || 0),
        retail_sold: Number(row.retail_sold_quantity || 0),
        wholesale_sold: Number(row.wholesale_sold_quantity || 0),
        sales_total: Number(row.signed_sales_total || 0),
        gross_sales: Number(row.signed_gross_sales || 0),
        item_discounts: Number(row.signed_item_discounts || 0),
        total_cost: Number(row.total_cost || 0),
      };
    }


    // 3.5 Build timeline data for charts
    let timeGroupFormat = "'YYYY-MM'";
    if (timeline_interval === 'daily') {
      timeGroupFormat = "'YYYY-MM-DD'";
    } else if (timeline_interval === 'monthly') {
      timeGroupFormat = "'YYYY-MM'";
    } else if (timeline_interval === 'yearly') {
      timeGroupFormat = "'YYYY'";
    } else {
      if (date_from && date_to) {
        const d1 = new Date(date_from);
        const d2 = new Date(date_to);
        const diffDays = Math.ceil(Math.abs(d2 - d1) / (1000 * 60 * 60 * 24)); 
        if (diffDays <= 45) {
          timeGroupFormat = "'YYYY-MM-DD'";
        }
      } else if (date_from && !date_to) {
        const d1 = new Date(date_from);
        const diffDays = Math.ceil(Math.abs(new Date() - d1) / (1000 * 60 * 60 * 24));
        if (diffDays <= 45) {
          timeGroupFormat = "'YYYY-MM-DD'";
        }
      }
    }

    const timelineConditions = [
      `i.movement_type = 'sale'`,
      `i.is_void IS NOT TRUE`,
    ];
    const timelineValues = [];
    let tIdx = 1;
    
    let timelineManufacturerCondition = "WHERE (p.is_active IS NOT FALSE OR EXISTS (SELECT 1 FROM stock s WHERE s.product_id = p.id AND s.quantity != 0))";
    if (normalizedManufacturer && normalizedManufacturer !== "all") {
      timelineManufacturerCondition += ` AND LOWER(TRIM(p.manufacturer)) = LOWER(TRIM($${tIdx++}))`;
      timelineValues.push(normalizedManufacturer);
    }

    // Chart specific invoice type logic
    const activeChartInvoiceType = chart_invoice_type || invoice_type;
    if (activeChartInvoiceType === 'retail') {
      timelineConditions.push(`i.branch_id = $${tIdx++}`);
      timelineValues.push(1);
      timelineConditions.push(`i.invoice_type = $${tIdx++}`);
      timelineValues.push('retail');
    } else if (activeChartInvoiceType === 'wholesale') {
      timelineConditions.push(`i.branch_id = $${tIdx++}`);
      timelineValues.push(2);
      timelineConditions.push(`i.invoice_type = $${tIdx++}`);
      timelineValues.push('wholesale');
    }

    if (date_from) {
      timelineConditions.push(`COALESCE(i.invoice_date::date, i.created_at::date) >= $${tIdx++}::date`);
      timelineValues.push(date_from);
    }
    if (date_to) {
      timelineConditions.push(`COALESCE(i.invoice_date::date, i.created_at::date) <= $${tIdx++}::date`);
      timelineValues.push(date_to);
    }

    const timelineQuery = `
      WITH selected_products AS (
        SELECT p.id AS product_id
        FROM products p
        ${timelineManufacturerCondition}
      ),
      invoice_scope AS (
        SELECT 
          i.id AS invoice_id, 
          i.branch_id, 
          i.invoice_type, 
          COALESCE(i.invoice_date::date, i.created_at::date) AS invoice_date, 
          COALESCE(i.total, 0) AS invoice_total,
          COALESCE(i.apply_items_discount, true) AS apply_items_discount
        FROM invoices i
        WHERE ${timelineConditions.join(" AND ")}
      ),
      selected_invoice_ids AS (
        SELECT DISTINCT ii.invoice_id
        FROM invoice_items ii
        JOIN selected_products sp ON sp.product_id = ii.product_id
        JOIN invoice_scope inv ON inv.invoice_id = ii.invoice_id
      ),
      invoice_items_scoped AS (
        SELECT
          ii.invoice_id,
          ii.product_id,
          ii.quantity, ii.price, ii.discount, ii.total, ii.is_return, ii.cost_price,
          inv.branch_id, inv.invoice_type, inv.invoice_date, inv.invoice_total, inv.apply_items_discount,
          p.purchase_price, p.retail_purchase_price,
          CASE
            WHEN COALESCE(inv.apply_items_discount, true) = false THEN
              CASE WHEN COALESCE(ii.is_return, false) THEN -(COALESCE(ii.quantity, 0) * COALESCE(ii.price, 0))
              ELSE (COALESCE(ii.quantity, 0) * COALESCE(ii.price, 0)) END
            ELSE
              CASE WHEN COALESCE(ii.is_return, false)
                THEN -COALESCE(ii.total, COALESCE(ii.quantity, 0) * (COALESCE(ii.price, 0) - COALESCE(ii.discount, 0)))
              ELSE COALESCE(ii.total, COALESCE(ii.quantity, 0) * (COALESCE(ii.price, 0) - COALESCE(ii.discount, 0))) END
          END AS signed_item_total,
          SUM(
            CASE
              WHEN COALESCE(inv.apply_items_discount, true) = false THEN
                CASE WHEN COALESCE(ii.is_return, false) THEN -(COALESCE(ii.quantity, 0) * COALESCE(ii.price, 0))
                ELSE (COALESCE(ii.quantity, 0) * COALESCE(ii.price, 0)) END
              ELSE
                CASE WHEN COALESCE(ii.is_return, false)
                  THEN -COALESCE(ii.total, COALESCE(ii.quantity, 0) * (COALESCE(ii.price, 0) - COALESCE(ii.discount, 0)))
                ELSE COALESCE(ii.total, COALESCE(ii.quantity, 0) * (COALESCE(ii.price, 0) - COALESCE(ii.discount, 0))) END
            END
          ) OVER (PARTITION BY ii.invoice_id) AS invoice_items_total
        FROM invoice_scope inv
        JOIN selected_invoice_ids sii ON sii.invoice_id = inv.invoice_id
        JOIN invoice_items ii ON ii.invoice_id = inv.invoice_id
        JOIN products p ON p.id = ii.product_id
      )
      SELECT
        TO_CHAR(iis.invoice_date, ${timeGroupFormat}) AS period,
        SUM(
          CASE 
            WHEN ${isApplyDistribution ? 'true' : 'false'} THEN
              CASE
                WHEN iis.invoice_items_total = 0 THEN iis.signed_item_total
                ELSE iis.signed_item_total - ((iis.invoice_items_total - iis.invoice_total) * (iis.signed_item_total / iis.invoice_items_total))
              END
            ELSE
              iis.signed_item_total
          END
        ) AS sales_revenue,
        SUM(
          CASE WHEN COALESCE(iis.is_return, false)
            THEN -(COALESCE(iis.quantity, 0) * COALESCE(iis.cost_price, CASE WHEN iis.invoice_type = 'retail' THEN COALESCE(iis.retail_purchase_price, iis.purchase_price, 0) ELSE COALESCE(iis.purchase_price, 0) END))
          ELSE COALESCE(iis.quantity, 0) * COALESCE(iis.cost_price, CASE WHEN iis.invoice_type = 'retail' THEN COALESCE(iis.retail_purchase_price, iis.purchase_price, 0) ELSE COALESCE(iis.purchase_price, 0) END) END
        ) AS cost_of_goods
      FROM invoice_items_scoped iis
      JOIN selected_products sp ON sp.product_id = iis.product_id
      GROUP BY period
      ORDER BY period ASC
    `;

    const timelineRes = await pool.query(timelineQuery, timelineValues);

    const expensesConditions = [`entry_type = 'expense'`];
    const expensesValues = [];
    let eIdx = 1;
    if (activeChartInvoiceType === 'retail') {
      expensesConditions.push(`branch_id = $${eIdx++}`);
      expensesValues.push(1);
    } else if (activeChartInvoiceType === 'wholesale') {
      expensesConditions.push(`branch_id = $${eIdx++}`);
      expensesValues.push(2);
    }
    if (date_from) {
      expensesConditions.push(`transaction_date >= $${eIdx++}::date`);
      expensesValues.push(date_from);
    }
    if (date_to) {
      expensesConditions.push(`transaction_date <= $${eIdx++}::date`);
      expensesValues.push(date_to);
    }

    const expensesQuery = `
      SELECT TO_CHAR(transaction_date, ${timeGroupFormat}) AS period, SUM(amount) AS total_expenses
      FROM cash_out
      WHERE ${expensesConditions.join(" AND ")}
      GROUP BY period
    `;
    const expensesRes = await pool.query(expensesQuery, expensesValues);
    const expensesMap = {};
    expensesRes.rows.forEach(r => {
      expensesMap[r.period] = Math.round(Number(r.total_expenses || 0) * 100) / 100;
    });

    const timeline = timelineRes.rows.map(r => {
      const sales = Math.round(Number(r.sales_revenue || 0) * 100) / 100;
      const cost = Math.round(Number(r.cost_of_goods || 0) * 100) / 100;
      return {
        period: r.period,
        sales: sales,
        cost: cost,
        profit: Math.round((sales - cost) * 100) / 100
      };
    });

    // 3.6 Fill missing periods with zeroes
    let filledTimeline = [];
    const allPeriods = [...timeline.map(t => t.period), ...Object.keys(expensesMap)];
    allPeriods.sort();

    if (allPeriods.length > 0 || (date_from && date_to)) {
      let startDateStr = date_from ? String(date_from) : allPeriods[0];
      let endDateStr = date_to ? String(date_to) : allPeriods[allPeriods.length - 1];
      
      const isDaily = timeGroupFormat === "'YYYY-MM-DD'";
      const isMonthly = timeGroupFormat === "'YYYY-MM'";
      const isYearly = timeGroupFormat === "'YYYY'";

      const getNextPeriod = (currentStr) => {
        const d = new Date(currentStr + (isYearly ? "-01-01" : isMonthly ? "-01" : "T12:00:00"));
        if (isDaily) d.setDate(d.getDate() + 1);
        if (isMonthly) d.setMonth(d.getMonth() + 1);
        if (isYearly) d.setFullYear(d.getFullYear() + 1);
        
        let year = d.getFullYear();
        let month = String(d.getMonth() + 1).padStart(2, '0');
        let day = String(d.getDate()).padStart(2, '0');
        
        if (isDaily) return `${year}-${month}-${day}`;
        if (isMonthly) return `${year}-${month}`;
        return `${year}`;
      };

      let currentPeriod = startDateStr;
      if (isMonthly) currentPeriod = currentPeriod.substring(0, 7);
      if (isYearly) currentPeriod = currentPeriod.substring(0, 4);

      let endPeriod = endDateStr;
      if (isMonthly) endPeriod = endPeriod.substring(0, 7);
      if (isYearly) endPeriod = endPeriod.substring(0, 4);

      const timelineMap = {};
      timeline.forEach(t => timelineMap[t.period] = t);

      let iterations = 0;
      while (currentPeriod <= endPeriod && iterations < 2000) {
        const periodExpenses = expensesMap[currentPeriod] || 0;
        if (timelineMap[currentPeriod]) {
          filledTimeline.push({
            ...timelineMap[currentPeriod],
            expenses: periodExpenses
          });
        } else {
          filledTimeline.push({
            period: currentPeriod,
            sales: 0,
            cost: 0,
            profit: 0,
            expenses: periodExpenses
          });
        }
        currentPeriod = getNextPeriod(currentPeriod);
        iterations++;
      }
    } else {
      filledTimeline = timeline;
    }

    // 4. Fetch total purchases/inbound per product
    let purchaseWhere = `
      WHERE i.movement_type = 'purchase'
        AND i.is_void IS NOT TRUE
        AND COALESCE(ii.is_return, false) IS NOT TRUE
    `;
    const purchaseValues = [];
    let purchaseIdx = 1;

    if (branch_id) {
      purchaseWhere += ` AND i.branch_id = $${purchaseIdx++}`;
      purchaseValues.push(Number(branch_id));
    }

    if (normalizedManufacturer && normalizedManufacturer !== "all") {
      purchaseWhere += ` AND ii.product_id IN (SELECT id FROM products WHERE LOWER(TRIM(manufacturer)) = LOWER(TRIM($${purchaseIdx++})))`;
      purchaseValues.push(normalizedManufacturer);
    } else {
      purchaseWhere += ` AND ii.product_id IN (SELECT id FROM products)`;
    }

    const purchaseRes = await pool.query(
      `
      SELECT
        ii.product_id,
        SUM(COALESCE(ii.quantity, 0)) AS purchased_qty,
        SUM(CASE WHEN i.branch_id = 1 THEN COALESCE(ii.quantity, 0) ELSE 0 END) AS retail_purchased,
        SUM(CASE WHEN i.branch_id = 2 THEN COALESCE(ii.quantity, 0) ELSE 0 END) AS wholesale_purchased
      FROM invoice_items ii
      JOIN invoices i ON i.id = ii.invoice_id
      ${purchaseWhere}
      GROUP BY ii.product_id
      `,
      purchaseValues
    );

    const purchaseMap = {};
    for (const row of purchaseRes.rows) {
      purchaseMap[row.product_id] = {
        total: Number(row.purchased_qty || 0),
        retail: Number(row.retail_purchased || 0),
        wholesale: Number(row.wholesale_purchased || 0)
      };
    }

    // 4.5 Fetch product variants purchase prices for fallback
    let variantsWhere = "WHERE 1=1";
    const variantsValues = [];
    let variantsIdx = 1;

    if (normalizedManufacturer && normalizedManufacturer !== "all") {
      variantsWhere += ` AND product_id IN (SELECT id FROM products WHERE LOWER(TRIM(manufacturer)) = LOWER(TRIM($${variantsIdx++})))`;
      variantsValues.push(normalizedManufacturer);
    } else {
      variantsWhere += ` AND product_id IN (SELECT id FROM products)`;
    }

    const variantsRes = await pool.query(
      `SELECT product_id, purchase_price, retail_purchase_price FROM product_variants ${variantsWhere}`,
      variantsValues
    );
    const variantCostMap = {};
    for (const v of variantsRes.rows) {
      const vRetailCost = Number(v.retail_purchase_price || 0);
      const vWholesaleCost = Number(v.purchase_price || 0);
      const chosenCost = branch_id == 2
        ? (vWholesaleCost > 0 ? vWholesaleCost : vRetailCost)
        : (vRetailCost > 0 ? vRetailCost : vWholesaleCost);

      if (!variantCostMap[v.product_id] || variantCostMap[v.product_id] === 0) {
        variantCostMap[v.product_id] = chosenCost;
      }
    }

    // 5. System Champion (Top sold product across all system)
    const sysChampRes = await pool.query(
      `
      SELECT ii.product_id, SUM(CASE WHEN COALESCE(ii.is_return, false) THEN -ii.quantity ELSE ii.quantity END) AS total_sold
      FROM invoice_items ii
      JOIN invoices i ON i.id = ii.invoice_id
      WHERE i.movement_type = 'sale' AND i.is_void IS NOT TRUE
      GROUP BY ii.product_id
      ORDER BY total_sold DESC
      LIMIT 1
      `
    );
    const systemChampionId = sysChampRes.rows.length > 0 ? Number(sysChampRes.rows[0].product_id) : null;

    // 6. Aggregate & Build rows per product
    let totalAcquiredQty = 0;
    let totalAcquiredCost = 0;
    let totalSoldQty = 0;
    let totalGrossSales = 0;
    let totalItemDiscounts = 0;
    let totalSalesAmount = 0;
    let totalCostOfGoodsSold = 0;
    let totalNetProfit = 0;
    let currentStockQty = 0;
    let currentStockValuationCost = 0;
    let activeStockValuationCost = 0;
    let inactiveStockValuationCost = 0;
    let factoryTopQtyId = null;
    let maxQty = -Infinity;
    let factoryTopSalesId = null;
    let maxSales = -Infinity;
    let factoryTopProfitId = null;
    let maxProfit = -Infinity;

    let allProductRows = productsRes.rows.map((p) => {
      const stockData = stockMap[p.id] || { total: 0, retail: 0, wholesale: 0 };
      const stockQty = stockData.total;
      const sales = salesMap[p.id] || {
        invoices_count: 0,
        first_sale_date: null,
        last_sale_date: null,
        sold_quantity: 0,
        retail_sold: 0,
        wholesale_sold: 0,
        sales_total: 0,
        gross_sales: 0,
        item_discounts: 0,
        total_cost: 0,
      };
      const purchasedData = purchaseMap[p.id] || { total: 0, retail: 0, wholesale: 0 };
      const purchasedQty = purchasedData.total;

      // Base unit cost price for current stock valuation
      const pRetailCost = Number(p.retail_purchase_price || 0);
      const pWholesaleCost = Number(p.purchase_price || 0);
      const variantCost = Number(variantCostMap[p.id] || 0);

      let currentUnitCost = 0;
      let localStockValuationCost = 0;
      let acquiredQty = 0;
      let acquiredCost = 0;

      if (branch_id == 1 || invoice_type === 'retail') {
        currentUnitCost = pRetailCost > 0 ? pRetailCost : (pWholesaleCost > 0 ? pWholesaleCost : variantCost);
        localStockValuationCost = stockQty * currentUnitCost;
        acquiredQty = Math.max(stockQty + Math.max(0, sales.sold_quantity), purchasedQty);
        acquiredCost = acquiredQty * currentUnitCost;
      } else if (branch_id == 2 || invoice_type === 'wholesale') {
        currentUnitCost = pWholesaleCost > 0 ? pWholesaleCost : (pRetailCost > 0 ? pRetailCost : variantCost);
        localStockValuationCost = stockQty * currentUnitCost;
        acquiredQty = Math.max(stockQty + Math.max(0, sales.sold_quantity), purchasedQty);
        acquiredCost = acquiredQty * currentUnitCost;
      } else {
        const retailUnitCost = pRetailCost > 0 ? pRetailCost : (pWholesaleCost > 0 ? pWholesaleCost : variantCost);
        const wholesaleUnitCost = pWholesaleCost > 0 ? pWholesaleCost : (pRetailCost > 0 ? pRetailCost : variantCost);
        
        const retailAcquired = Math.max(stockData.retail + Math.max(0, sales.retail_sold), purchasedData.retail);
        const wholesaleAcquired = Math.max(stockData.wholesale + Math.max(0, sales.wholesale_sold), purchasedData.wholesale);
        
        localStockValuationCost = (stockData.retail * retailUnitCost) + (stockData.wholesale * wholesaleUnitCost);
        acquiredQty = retailAcquired + wholesaleAcquired;
        acquiredCost = (retailAcquired * retailUnitCost) + (wholesaleAcquired * wholesaleUnitCost);
        
        // Default display cost for "all" is wholesale
        currentUnitCost = wholesaleUnitCost;
      }

      // Base unit selling price on system
      const pRetailSell = Number(p.retail_price || 0);
      const pWholesaleSell = Number(p.wholesale_price || 0);
      let currentSellingPrice = 0;
      if (branch_id == 2 || invoice_type === 'wholesale') {
        currentSellingPrice = pWholesaleSell > 0 ? pWholesaleSell : pRetailSell;
      } else {
        currentSellingPrice = pRetailSell > 0 ? pRetailSell : pWholesaleSell;
      }

      const netProfit = sales.sales_total - sales.total_cost;
      const profitMarginPercent = sales.sales_total > 0 ? (netProfit / sales.sales_total) * 100 : 0;
      const stockValuationCost = Math.max(0, localStockValuationCost);
      const sellThroughPercent = acquiredQty > 0 ? (sales.sold_quantity / acquiredQty) * 100 : 0;

      // Global totals accumulators
      totalAcquiredQty += acquiredQty;
      totalAcquiredCost += acquiredCost;
      totalSoldQty += sales.sold_quantity;
      totalGrossSales += sales.gross_sales;
      totalItemDiscounts += sales.item_discounts;
      totalSalesAmount += sales.sales_total;
      totalCostOfGoodsSold += sales.total_cost;
      totalNetProfit += netProfit;
      currentStockQty += stockQty;
      currentStockValuationCost += stockValuationCost;
      if (p.is_active !== false) {
        activeStockValuationCost += stockValuationCost;
      } else {
        inactiveStockValuationCost += stockValuationCost;
      }

      // Track Factory Champions
      if (sales.sold_quantity > maxQty && sales.sold_quantity > 0) {
        maxQty = sales.sold_quantity;
        factoryTopQtyId = p.id;
      }
      if (sales.sales_total > maxSales && sales.sales_total > 0) {
        maxSales = sales.sales_total;
        factoryTopSalesId = p.id;
      }
      if (netProfit > maxProfit && netProfit > 0) {
        maxProfit = netProfit;
        factoryTopProfitId = p.id;
      }

      const packageLabel = [p.wholesale_package, p.retail_package].filter(Boolean).join(" / ") || "1 قطعة";

      const avgSellingPrice = sales.sold_quantity > 0 ? sales.sales_total / sales.sold_quantity : 0;

      return {
        product_id: p.id,
        product_name: p.name,
        sku: p.id ? `PROD-${p.id}` : `-`,
        manufacturer_name: p.manufacturer,
        package_name: packageLabel,
        product_created_at: p.created_at,
        first_sale_date: sales.first_sale_date,
        last_sale_date: sales.last_sale_date,
        invoices_count: sales.invoices_count,
        total_acquired_qty: acquiredQty,
        sold_quantity: sales.sold_quantity,
        current_stock_qty: stockQty,
        purchase_price: currentUnitCost,
        selling_price: currentSellingPrice,
        avg_selling_price: Math.round(avgSellingPrice * 100) / 100,
        sales_total: Math.round(sales.sales_total * 100) / 100,
        gross_sales: Math.round(sales.gross_sales * 100) / 100,
        item_discounts: Math.round(sales.item_discounts * 100) / 100,
        total_cost: Math.round(sales.total_cost * 100) / 100,
        net_profit: Math.round(netProfit * 100) / 100,
        profit_margin_percent: Math.round(profitMarginPercent * 100) / 100,
        current_stock_value: Math.round(stockValuationCost * 100) / 100,
        sell_through_percent: Math.round(sellThroughPercent * 100) / 100,
        is_low_stock: stockQty <= 5,
        is_active: p.is_active !== false,
      };
    });

    // Filter out products with zero activity across all tracked metrics
    allProductRows = allProductRows.filter(
      (row) => row.total_acquired_qty !== 0 || row.sold_quantity !== 0 || row.current_stock_qty !== 0
    );

    // Apply search filter if search term provided
    if (search && String(search).trim()) {
      const q = String(search).trim().toLowerCase();
      allProductRows = allProductRows.filter(
        (row) =>
          row.product_name.toLowerCase().includes(q) ||
          String(row.sku).toLowerCase().includes(q)
      );
    }

    // Global summary totals
    const overallProfitMargin = totalSalesAmount > 0 ? (totalNetProfit / totalSalesAmount) * 100 : 0;
    const overallSellThrough = totalAcquiredQty > 0 ? (totalSoldQty / totalAcquiredQty) * 100 : 0;
    const overallRemainingPercent = totalAcquiredQty > 0 ? (currentStockQty / totalAcquiredQty) * 100 : 0;
    const overallAvgSoldUnitPrice = totalSoldQty > 0 ? totalSalesAmount / totalSoldQty : 0;

    // Apply pagination to products list
    const currentPage = Math.max(1, Number(page) || 1);
    const pageSize = Math.max(1, Math.min(Number(limit) || 50, 100));
    const totalItems = allProductRows.length;
    const totalPages = Math.ceil(totalItems / pageSize);
    const paginatedProducts = allProductRows.slice((currentPage - 1) * pageSize, currentPage * pageSize);

    res.json({
      summary: {
        manufacturer: manufacturer,
        total_products_count: allProductRows.length,
        total_acquired_qty: totalAcquiredQty,
        total_acquired_cost: Math.round(totalAcquiredCost * 100) / 100,
        total_sold_qty: totalSoldQty,
        total_gross_sales: Math.round(totalGrossSales * 100) / 100,
        total_item_discounts: Math.round(totalItemDiscounts * 100) / 100,
        total_sales_amount: Math.round(totalSalesAmount * 100) / 100,
        avg_sold_unit_price: Math.round(overallAvgSoldUnitPrice * 100) / 100,
        total_cost_of_goods_sold: Math.round(totalCostOfGoodsSold * 100) / 100,
        total_net_profit: Math.round(totalNetProfit * 100) / 100,
        profit_margin_percent: Math.round(overallProfitMargin * 100) / 100,
        current_stock_qty: currentStockQty,
        current_stock_valuation_cost: Math.round(currentStockValuationCost * 100) / 100,
        active_stock_value: Math.round(activeStockValuationCost * 100) / 100,
        inactive_stock_value: Math.round(inactiveStockValuationCost * 100) / 100,
        sell_through_percent: Math.round(overallSellThrough * 100) / 100,
        remaining_stock_percent: Math.round(overallRemainingPercent * 100) / 100,
        is_date_filtered: Boolean(date_from || date_to),
      },
      champions: {
        system_champion_product_id: systemChampionId,
        factory_top_qty_product_id: factoryTopQtyId,
        factory_top_sales_product_id: factoryTopSalesId,
        factory_top_profit_product_id: factoryTopProfitId,
      },
      products: paginatedProducts,
      timeline: filledTimeline,
      pagination: {
        page: currentPage,
        limit: pageSize,
        total_pages: totalPages,
        total_items: totalItems,
      },
    });
  } catch (err) {
    console.error("MANUFACTURER ANALYTICS ERROR:", err);
    res.status(500).json({ error: "Server error", details: err.message });
  }
};

