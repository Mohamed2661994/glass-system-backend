const express = require("express");
const cors = require("cors");
require("dotenv").config();
const { exec } = require("child_process");
const path = require("path");
const fs = require("fs");
const puppeteer = require("puppeteer");
const pool = require("./db");
const {
  convertWholesaleToRetail,
} = require("./services/wholesaleToRetailConverter");
function normalizeNumbers(text) {
  if (!text) return text;

  const arabic = "٠١٢٣٤٥٦٧٨٩";
  const english = "0123456789";

  return text.replace(/[٠-٩]/g, (d) => english[arabic.indexOf(d)]);
}

const app = express();
app.use(
  cors({
    origin: "*", // مؤقتًا للتجربة
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  }),
);

app.use("/assets", express.static(path.join(__dirname, "assets")));

app.use(express.json());

const reportsRoutes = require("./reports/reports.routes");
app.use("/reports", reportsRoutes);

const productsRoutes = require("./modules/products/products.routes");

//app.use("/products", productsRoutes);

app.get("/", (req, res) => {
  res.send("Glass System Backend Running 🚀");
});

function getWarehouseIdByInvoiceType(invoice_type) {
  if (invoice_type === "retail") {
    return 1; // مخزن المعرض
  }

  if (invoice_type === "wholesale") {
    return 2; // المخزن الرئيسي
  }
  if (invoice_type === "transfer") return null; // 👈 مهم
  throw new Error("invoice_type غير معروف");
}

async function getWholesaleWarehouseByBranch(branch_id, client = pool) {
  const res = await client.query(
    `
    SELECT id
    FROM warehouses
    WHERE branch_id = $1
    ORDER BY id DESC
    LIMIT 1
    `,
    [branch_id],
  );

  if (!res.rows.length) {
    throw new Error("لا يوجد مخزن للفرع");
  }

  return res.rows[0].id;
}

app.get("/products", async (req, res) => {
  try {
    const { branch_id, invoice_type, movement_type } = req.query;

    if (!branch_id || !invoice_type || !movement_type) {
      return res.status(400).json({
        error: "branch_id و invoice_type و movement_type مطلوبين",
      });
    }

    // نجيب المخزن بتاع الفرع
    const warehouseId = getWarehouseIdByInvoiceType(invoice_type);

    // نجيب الأصناف + الرصيد + السعر حسب نوع الفاتورة
    let productsResult;

    if (movement_type === "sale") {
      // 🔹 بيع → لازم رصيد
      productsResult = await pool.query(
        `
     SELECT
      p.id,
      p.name,
      p.wholesale_package,
      p.retail_package,
      p.manufacturer,
      CASE
        WHEN $1 = 'wholesale' THEN p.wholesale_price
        ELSE p.retail_price
      END AS price,
      p.discount_amount,
      s.quantity AS available_quantity
    FROM products p
    JOIN stock s
      ON s.product_id = p.id
      AND s.warehouse_id = $2
    WHERE p.is_active = true
      AND s.quantity > 0
    ORDER BY p.name
    `,
        [invoice_type, warehouseId],
      );
    } else {
      // 🔹 شراء → كل الأصناف حتى لو الرصيد صفر
      productsResult = await pool.query(
        `
   SELECT
      p.id,
      p.name,
      p.wholesale_package,
      p.retail_package,
      p.manufacturer,
      CASE
        WHEN $1 = 'wholesale' THEN p.purchase_price
        ELSE p.retail_purchase_price
      END AS price,
      p.discount_amount,
     COALESCE(s.quantity, 0) AS available_quantity
    FROM products p
    LEFT JOIN stock s
      ON s.product_id = p.id
      AND s.warehouse_id = $2
    WHERE p.is_active = true
    ORDER BY p.name
    `,
        [invoice_type, warehouseId],
      );
    }

    res.json(productsResult.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/customers/search", async (req, res) => {
  try {
    const { name } = req.query;
    if (!name || name.length < 2) return res.json([]);

    const result = await pool.query(
      `
      SELECT c.id, c.name,
             (SELECT phone FROM customer_phones 
              WHERE customer_id = c.id 
              ORDER BY id ASC LIMIT 1) AS phone
      FROM customers c
      WHERE c.name ILIKE $1
      ORDER BY c.name
      LIMIT 5
      `,
      [`%${name}%`],
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/customers/:id/phones", async (req, res) => {
  try {
    const { id } = req.params;
    const { phone } = req.body;

    if (!phone) return res.status(400).json({ error: "رقم الهاتف مطلوب" });

    await pool.query(
      `INSERT INTO customer_phones (customer_id, phone) VALUES ($1, $2)`,
      [id, phone],
    );

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: "الرقم مسجل بالفعل" });
  }
});

app.get("/customers/:id/phones", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT phone FROM customer_phones WHERE customer_id = $1`,
      [req.params.id],
    );

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/customers/by-phone", async (req, res) => {
  try {
    const { phone } = req.query;
    if (!phone) return res.json(null);

    const customerResult = await pool.query(
      `
      SELECT c.id, c.name
      FROM customer_phones cp
      JOIN customers c ON c.id = cp.customer_id
      WHERE cp.phone = $1
      LIMIT 1
      `,
      [phone],
    );

    if (customerResult.rows.length === 0) return res.json(null);

    const customer = customerResult.rows[0];

    const phonesResult = await pool.query(
      `SELECT phone FROM customer_phones WHERE customer_id = $1`,
      [customer.id],
    );

    res.json({
      id: customer.id,
      name: customer.name,
      phones: phonesResult.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/invoices", authMiddleware, async (req, res) => {
  console.log("USER FROM TOKEN:", req.user);

  const userBranchId = req.user.branch_id;
  req.body.branch_id = userBranchId;
  const client = await pool.connect();

  try {
    if (req.body.id || req.body.invoice_id) {
      return res.status(400).json({
        error: "لا يمكن إنشاء فاتورة جديدة أثناء التعديل",
      });
    }
    const {
      branch_id,
      invoice_type, // retail | wholesale
      movement_type, // sale | purchase
      invoice_date, // 👈 لازم
      customer_name,
      customer_phone,
      previous_balance = 0,
      paid_amount = 0,
      created_by,
      notes,
      items,
      apply_items_discount = false,
      manual_discount = 0,
    } = req.body;
    // ✅ نخليه جملة فقط
    if (invoice_type !== "wholesale") {
      return res.status(400).json({
        error: "هذا المسار مخصص لفواتير الجملة فقط",
      });
    }
    if (
      !branch_id ||
      !invoice_type ||
      !movement_type ||
      !items ||
      items.length === 0
    ) {
      return res.status(400).json({ error: "بيانات ناقصة" });
    }

    await client.query("BEGIN");

    /* ================== الحسابات ================== */
    let subtotal = 0;
    let items_discount = 0;

    for (const item of items) {
      subtotal += item.price * item.quantity;
      items_discount += (item.discount || 0) * item.quantity;
    }

    const extra_discount = Number(manual_discount || 0);

    const discount_total = apply_items_discount
      ? items_discount + extra_discount
      : extra_discount;

    const total = subtotal - discount_total;

    const totalWithPrevious = total + Number(previous_balance || 0);

    const remaining_amount = totalWithPrevious - paid_amount;

    const payment_status =
      remaining_amount <= 0 ? "paid" : paid_amount > 0 ? "partial" : "unpaid";

    const checkExisting = await client.query(
      "SELECT id FROM invoices WHERE customer_name = $1 AND total = $2 AND paid_amount = $3 AND created_at >= NOW() - INTERVAL '5 seconds'",
      [customer_name, total, paid_amount],
    );

    if (checkExisting.rows.length) {
      throw new Error("تم منع إنشاء فاتورة مكررة");
    }

    let customerId = null;

    if (customer_name) {
      // 1️⃣ هل العميل موجود بالاسم؟
      const existingCustomer = await client.query(
        `SELECT id FROM customers WHERE name = $1 LIMIT 1`,
        [customer_name],
      );

      if (existingCustomer.rows.length > 0) {
        customerId = existingCustomer.rows[0].id;
      } else {
        // 2️⃣ إنشاء عميل جديد بدون رقم
        const newCustomer = await client.query(
          `INSERT INTO customers (name, customer_type)
       VALUES ($1, $2)
       RETURNING id`,
          [customer_name, invoice_type],
        );
        customerId = newCustomer.rows[0].id;
      }

      // 3️⃣ إضافة الرقم في جدول customer_phones لو مش موجود
      if (customer_phone) {
        await client.query(
          `
      INSERT INTO customer_phones (customer_id, phone)
      VALUES ($1, $2)
      ON CONFLICT (phone) DO NOTHING
      `,
          [customerId, customer_phone],
        );
      }
    }

    /* ================== إنشاء الفاتورة ================== */
    const invoiceRes = await client.query(
      `
     INSERT INTO invoices (
  branch_id,
  invoice_type,
  movement_type,
  invoice_date,
  customer_id,
  customer_name,
  customer_phone,
  previous_balance,
  subtotal,
  manual_discount,
  discount_total,
  total,
  paid_amount,
  remaining_amount,
  payment_status,
  apply_items_discount
)
VALUES
($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      RETURNING id
      `,
      [
        branch_id,
        invoice_type,
        movement_type,
        invoice_date || new Date(),
        customerId,
        customer_name,
        customer_phone,
        Number(previous_balance) || 0,
        subtotal,
        extra_discount,
        discount_total,
        total,
        paid_amount,
        remaining_amount,
        payment_status,
        apply_items_discount,
      ],
    );

    const invoiceId = invoiceRes.rows[0].id;
    // ✅ تسجيل العميل تلقائي لو فيه رقم

    /* ================== المخزن ================== */
    const warehouseId = getWarehouseIdByInvoiceType(invoice_type);

    for (const item of items) {
      const itemTotal =
        item.price * item.quantity - (item.discount || 0) * item.quantity;
      const packageText = item.package || "";

      // إضافة item للفاتورة
      await client.query(
        `
        INSERT INTO invoice_items
        (
          invoice_id,
          product_id,
          product_name,
          package, 
          price,
          quantity,
          discount,
          total
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        `,
        [
          invoiceId,
          item.product_id,
          item.product_name,
          packageText,
          item.price,
          item.quantity,
          item.discount || 0,
          itemTotal,
        ],
      );

      /* ===== تحديث المخزن ===== */
      if (movement_type === "purchase") {
        // 🟢 شراء → زيادة المخزون
        await client.query(
          `
          INSERT INTO stock (warehouse_id, product_id, quantity)
          VALUES ($1,$2,$3)
          ON CONFLICT (warehouse_id, product_id)
          DO UPDATE SET quantity = stock.quantity + $3
          `,
          [warehouseId, item.product_id, item.quantity],
        );

        await client.query(
          `
       INSERT INTO stock_movements
       (invoice_id, warehouse_id, product_id, quantity, movement_type)
       VALUES ($1,$2,$3,$4,'purchase')
       `,
          [invoiceId, warehouseId, item.product_id, item.quantity],
        );
      }

      if (movement_type === "sale") {
        // 🔴 بيع → خصم من المخزون
        await client.query(
          `
          UPDATE stock
          SET quantity = quantity - $1
          WHERE warehouse_id = $2 AND product_id = $3
          `,
          [item.quantity, warehouseId, item.product_id],
        );

        await client.query(
          `
        INSERT INTO stock_movements
        (invoice_id, warehouse_id, product_id, quantity, movement_type)
        VALUES ($1,$2,$3,$4,'sale')
         `,
          [invoiceId, warehouseId, item.product_id, item.quantity],
        );
      }
    }

    // 🔔 إشعار للمخزن لو المعرض عمل فاتورة جملة
    const MAIN_WAREHOUSE_ID = 2;
    const SHOWROOM_BRANCH_ID = 1;

    if (invoice_type === "wholesale" && branch_id === SHOWROOM_BRANCH_ID) {
      const title = "فاتورة جملة جديدة";

      const message = `تم إنشاء فاتورة جملة رقم #${invoiceId} للعميل ${customer_name || "عميل نقدي"}`;

      // 🗃️ تخزين في الداتابيز
      await client.query(
        `INSERT INTO notifications 
     (title, message, from_user_id, to_branch_id, type, reference_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          title,
          message,
          req.user.id,
          MAIN_WAREHOUSE_ID,
          "invoice_wholesale", // نوع الإشعار
          invoiceId, // رقم الفاتورة
        ],
      );

      // 🚀 إرسال لحظي
      const io = req.app.get("io");
      io.to(`branch_${MAIN_WAREHOUSE_ID}`).emit("new_notification", {
        title,
        message,
        type: "invoice_wholesale",
        reference_id: invoiceId,
      });
    }

    await client.query("COMMIT");

    res.json({
      success: true,
      invoice_id: invoiceId,
      total,
      paid_amount,
      remaining_amount,
    });
  } catch (err) {
    console.error("INVOICE SAVE ERROR:", err); // 👈 مهم
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post("/invoices/retail", async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      branch_id,
      movement_type,
      invoice_date,
      customer_name,
      customer_phone,

      total_before_discount,
      items_discount = 0,
      extra_discount = 0,
      final_total,

      items,
      paid_amount = 0,
      previous_balance = 0,
      apply_items_discount = false,
    } = req.body;

    if (
      !branch_id ||
      !movement_type ||
      !items ||
      !items.length ||
      final_total === undefined
    ) {
      return res.status(400).json({ error: "بيانات ناقصة" });
    }

    await client.query("BEGIN");

    const totalWithPrevious =
      Number(final_total) + Number(previous_balance || 0);

    const remaining_amount = totalWithPrevious - Number(paid_amount || 0);

    const payment_status =
      remaining_amount <= 0 ? "paid" : paid_amount > 0 ? "partial" : "unpaid";

    let customerId = null;

    if (customer_name) {
      const existingCustomer = await client.query(
        `SELECT id FROM customers WHERE name = $1 LIMIT 1`,
        [customer_name],
      );

      if (existingCustomer.rows.length > 0) {
        customerId = existingCustomer.rows[0].id;
      } else {
        const newCustomer = await client.query(
          `INSERT INTO customers (name, customer_type)
       VALUES ($1, 'retail')
       RETURNING id`,
          [customer_name],
        );
        customerId = newCustomer.rows[0].id;
      }

      if (customer_phone) {
        await client.query(
          `INSERT INTO customer_phones (customer_id, phone)
       VALUES ($1, $2)
       ON CONFLICT (phone) DO NOTHING`,
          [customerId, customer_phone],
        );
      }
    }
    /* ================== إنشاء الفاتورة ================== */
    const invoiceRes = await client.query(
      `
      INSERT INTO invoices (
        branch_id,
        invoice_type,
        movement_type,
        invoice_date,
        customer_id,
        customer_name,
        customer_phone,
        previous_balance,
        subtotal,
        manual_discount,  
        discount_total,
        total,
        paid_amount,
        remaining_amount,
        payment_status,
        apply_items_discount
      )
      VALUES
      ($1,'retail',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      RETURNING id
      `,
      [
        branch_id,
        movement_type,
        invoice_date || new Date(),
        customerId,
        customer_name,
        customer_phone,
        Number(previous_balance) || 0,
        Number(total_before_discount),
        Number(extra_discount || 0), // ✅ manual_discount
        Number(items_discount) + Number(extra_discount),
        Number(final_total),
        Number(paid_amount),
        remaining_amount,
        payment_status,
        apply_items_discount,
      ],
    );

    const invoiceId = invoiceRes.rows[0].id;
    // ✅ تسجيل العميل تلقائي لو فيه رقم

    const warehouseId = getWarehouseIdByInvoiceType("retail");

    /* ================== الأصناف + المخزن ================== */
    for (const item of items) {
      const itemTotal =
        item.price * item.quantity - (item.discount || 0) * item.quantity;

      await client.query(
        `
        INSERT INTO invoice_items
        (
          invoice_id,
          product_id,
          product_name,
          package,
          price,
          quantity,
          discount,
          total
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        `,
        [
          invoiceId,
          item.product_id,
          item.product_name,
          item.package || "",
          item.price,
          item.quantity,
          item.discount || 0,
          itemTotal,
        ],
      );

      if (movement_type === "sale") {
        await client.query(
          `
          UPDATE stock
          SET quantity = quantity - $1
          WHERE warehouse_id = $2 AND product_id = $3
          `,
          [item.quantity, warehouseId, item.product_id],
        );
      } else {
        await client.query(
          `
          INSERT INTO stock (warehouse_id, product_id, quantity)
          VALUES ($1,$2,$3)
          ON CONFLICT (warehouse_id, product_id)
          DO UPDATE SET quantity = stock.quantity + $3
          `,
          [warehouseId, item.product_id, item.quantity],
        );
      }

      await client.query(
        `
        INSERT INTO stock_movements
        (invoice_id, warehouse_id, product_id, quantity, movement_type)
        VALUES ($1,$2,$3,$4,$5)
        `,
        [invoiceId, warehouseId, item.product_id, item.quantity, movement_type],
      );
    }

    await client.query("COMMIT");

    res.json({
      success: true,
      invoice_id: invoiceId,
      total: final_total,
      remaining_amount,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.put("/invoices/retail/:id", async (req, res) => {
  const client = await pool.connect();
  const invoiceId = Number(req.params.id);

  try {
    await client.query("BEGIN");

    /* ================================
       0️⃣ هات بيانات الفاتورة القديمة
    ================================= */
    const invoiceRes = await client.query(
      `
      SELECT movement_type, previous_balance
      FROM invoices
      WHERE id = $1 AND invoice_type = 'retail'
      FOR UPDATE
      `,
      [invoiceId],
    );

    if (!invoiceRes.rows.length) {
      throw new Error("فاتورة قطاعي غير موجودة");
    }

    const { movement_type, previous_balance } = invoiceRes.rows[0];
    const warehouseId = getWarehouseIdByInvoiceType("retail");

    /* ================================
       1️⃣ رجّع المخزن (الأصناف القديمة)
    ================================= */
    const oldItemsRes = await client.query(
      `
      SELECT product_id, quantity
      FROM invoice_items
      WHERE invoice_id = $1
      `,
      [invoiceId],
    );

    for (const oldItem of oldItemsRes.rows) {
      if (movement_type === "sale") {
        await client.query(
          `
          UPDATE stock
          SET quantity = quantity + $1
          WHERE warehouse_id = $2 AND product_id = $3
          `,
          [oldItem.quantity, warehouseId, oldItem.product_id],
        );
      } else {
        await client.query(
          `
          UPDATE stock
          SET quantity = quantity - $1
          WHERE warehouse_id = $2 AND product_id = $3
          `,
          [oldItem.quantity, warehouseId, oldItem.product_id],
        );
      }
    }

    /* ================================
       2️⃣ نظافة القديم
    ================================= */
    await client.query(`DELETE FROM stock_movements WHERE invoice_id = $1`, [
      invoiceId,
    ]);

    await client.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [
      invoiceId,
    ]);

    /* ================================
       3️⃣ الداتا الجديدة
    ================================= */
    const {
      customer_name,
      customer_phone,

      total_before_discount,
      extra_discount = 0,
      final_total,

      items,
      paid_amount = 0,
      previous_balance: bodyPrevBalance,
      apply_items_discount = false,
    } = req.body;

    if (!items || !items.length || final_total === undefined) {
      throw new Error("بيانات غير مكتملة");
    }

    const prevBalance =
      bodyPrevBalance !== undefined
        ? Number(bodyPrevBalance)
        : Number(previous_balance || 0);

    /* ================================
       4️⃣ إضافة الأصناف الجديدة
    ================================= */
    for (const item of items) {
      const itemTotal =
        item.price * item.quantity - (item.discount || 0) * item.quantity;

      await client.query(
        `
        INSERT INTO invoice_items
        (
          invoice_id,
          product_id,
          product_name,
          package,
          price,
          quantity,
          discount,
          total
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        `,
        [
          invoiceId,
          item.product_id,
          item.product_name,
          item.package,
          item.price,
          item.quantity,
          item.discount || 0,
          itemTotal,
        ],
      );

      if (movement_type === "sale") {
        await client.query(
          `
          UPDATE stock
          SET quantity = quantity - $1
          WHERE warehouse_id = $2 AND product_id = $3
          `,
          [item.quantity, warehouseId, item.product_id],
        );
      } else {
        await client.query(
          `
          INSERT INTO stock (warehouse_id, product_id, quantity)
          VALUES ($1,$2,$3)
          ON CONFLICT (warehouse_id, product_id)
          DO UPDATE SET quantity = stock.quantity + $3
          `,
          [warehouseId, item.product_id, item.quantity],
        );
      }

      await client.query(
        `
        INSERT INTO stock_movements
        (invoice_id, warehouse_id, product_id, quantity, movement_type)
        VALUES ($1,$2,$3,$4,$5)
        `,
        [invoiceId, warehouseId, item.product_id, item.quantity, movement_type],
      );
    }

    /* ================================
   5️⃣ حسابات الفاتورة (موحّد مع الجملة)
================================ */
    const subtotal = Number(total_before_discount);
    const manualDiscount = Number(extra_discount || 0);
    const discountTotal = manualDiscount;
    const total = Number(final_total);

    const totalWithPrevious = total + Number(prevBalance || 0);
    const remaining_amount = totalWithPrevious - Number(paid_amount || 0);

    const payment_status =
      remaining_amount <= 0 ? "paid" : paid_amount > 0 ? "partial" : "unpaid";

    await client.query(
      `
    UPDATE invoices
SET
  customer_name = $1,
  customer_phone = $2,
  previous_balance = $3,
  subtotal = $4,
  manual_discount = $5,
  discount_total = $6,
  total = $7,
  paid_amount = $8,
  remaining_amount = $9,
  payment_status = $10,
  apply_items_discount = $11   -- ✅ جديد
WHERE id = $12
      `,
      [
        customer_name,
        customer_phone,
        prevBalance,
        subtotal,
        manualDiscount,
        discountTotal,
        total,
        Number(paid_amount),
        remaining_amount,
        payment_status,
        apply_items_discount, // ✅
        invoiceId,
      ],
    );

    /* ================================
   6️⃣ تحديث / إنشاء قيد اليومية (قطاعي)
================================ */

    if (movement_type === "sale" && Number(paid_amount) > 0) {
      const cashInRes = await client.query(
        `
    SELECT id
    FROM cash_in
    WHERE invoice_id = $1
      AND source_type = 'invoice'
    `,
        [invoiceId],
      );

      if (cashInRes.rows.length) {
        // 🟡 تحديث قيد موجود
        await client.query(
          `
      UPDATE cash_in
      SET
        amount = $1,
        paid_amount = $1,
        remaining_amount = $2,
        customer_name = $3,
        transaction_date = CURRENT_DATE
      WHERE invoice_id = $4
        AND source_type = 'invoice'
      `,
          [Number(paid_amount), remaining_amount, customer_name, invoiceId],
        );
      } else {
        // 🟢 إنشاء قيد جديد
        await client.query(
          `
      INSERT INTO cash_in
      (
        branch_id,
        invoice_id,
        customer_name,
        amount,
        paid_amount,
        remaining_amount,
        description,
        source_type,
        transaction_date
      )
      VALUES
      ($1,$2,$3,$4,$4,$5,$6,'invoice',CURRENT_DATE)
      `,
          [
            2, // أو branch_id لو عندك
            invoiceId,
            customer_name,
            Number(paid_amount),
            remaining_amount,
            `تحصيل تعديل فاتورة قطاعي رقم ${invoiceId}`,
          ],
        );
      }
    }

    await client.query("COMMIT");

    res.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 📦 فواتير جملة
app.get("/invoices/wholesale", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM invoices
      WHERE invoice_type = 'wholesale'
      ORDER BY created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// 🛒 فواتير قطاعي
app.get("/invoices/retail", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM invoices
      WHERE invoice_type = 'retail'
      ORDER BY created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/invoices/:id/edit", async (req, res) => {
  const { id } = req.params;

  try {
    const invoiceRes = await pool.query(
      `SELECT * FROM invoices WHERE id = $1`,
      [id],
    );

    if (!invoiceRes.rows.length) {
      return res.status(404).json({ error: "Invoice not found" });
    }

    const invoice = invoiceRes.rows[0];

    const itemsRes = await pool.query(
      `
      SELECT
        ii.product_id,
        ii.product_name,
        ii.package,
        ii.price,
        ii.quantity,
        ii.discount,
        ii.total,
        p.manufacturer
      FROM invoice_items ii
      JOIN products p ON p.id = ii.product_id
      WHERE ii.invoice_id = $1
      `,
      [id],
    );

    /* ================================
       حساب تفصيل الخصم
    ================================= */
    let items_discount = 0;
    let extra_discount = 0;

    if (invoice.invoice_type === "wholesale") {
      items_discount = itemsRes.rows.reduce(
        (sum, it) => sum + (it.discount || 0) * it.quantity,
        0,
      );

      extra_discount = Number(invoice.manual_discount || 0);
    } else {
      // القطاعي → الأرقام جاهزة
      // لو مخزّنتهم لاحقًا في أعمدة يبقوا direct
      items_discount = itemsRes.rows.reduce(
        (sum, it) => sum + (it.discount || 0) * it.quantity,
        0,
      );

      extra_discount = Number(invoice.manual_discount || 0);
    }

    res.json({
      id: invoice.id,
      invoice_type: invoice.invoice_type,
      movement_type: invoice.movement_type,
      invoice_date: invoice.invoice_date,

      customer_name: invoice.customer_name,
      customer_phone: invoice.customer_phone,

      subtotal: invoice.subtotal,

      items_discount,

      extra_discount: Number(invoice.manual_discount || 0), // ✅ السطر المهم
      manual_discount: Number(invoice.manual_discount || 0), // (اختياري لو محتاجه)

      discount_total: invoice.discount_total,
      total: invoice.total,

      paid_amount: invoice.paid_amount,
      previous_balance: invoice.previous_balance,
      remaining_amount: invoice.remaining_amount,
      payment_status: invoice.payment_status,
      apply_items_discount: invoice.apply_items_discount,

      items: itemsRes.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/invoices/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const invoiceRes = await pool.query(
      "SELECT * FROM invoices WHERE id = $1",
      [id],
    );

    if (invoiceRes.rows.length === 0) {
      return res.status(404).json({ error: "Invoice not found" });
    }

    const invoice = invoiceRes.rows[0];

    // ✅ هنا
    if (invoice.invoice_type !== "wholesale") {
      return res
        .status(400)
        .json({ error: "هذا المسار مخصص لفواتير الجملة فقط" });
    }

    const itemsRes = await pool.query(
      `
  SELECT
    ii.product_id,
    ii.product_name,
    ii.package,
    ii.price,
    ii.quantity,
    ii.discount,
    ii.total,
    p.manufacturer
  FROM invoice_items ii
  JOIN products p ON p.id = ii.product_id
  WHERE ii.invoice_id = $1
  `,
      [id],
    );

    const total_due =
      Number(invoice.total || 0) + Number(invoice.previous_balance || 0);

    res.json({
      ...invoice,
      manual_discount: Number(invoice.manual_discount || 0),
      total_due,
      items: itemsRes.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error" });
  }
});

app.put("/invoices/:id", async (req, res) => {
  const client = await pool.connect();
  const invoiceId = Number(req.params.id);

  try {
    await client.query("BEGIN");

    /* ================================
       0️⃣ هات بيانات الفاتورة
    ================================= */
    const invoiceRes = await client.query(
      `
      SELECT invoice_type, movement_type
      FROM invoices
      WHERE id = $1
      `,
      [invoiceId],
    );

    if (!invoiceRes.rows.length) {
      throw new Error("فاتورة غير موجودة");
    }

    const invoice = invoiceRes.rows[0];

    // ✅ هنا
    if (invoice.invoice_type !== "wholesale") {
      throw new Error("هذا المسار مخصص لتعديل فواتير الجملة فقط");
    }

    const { invoice_type, movement_type } = invoiceRes.rows[0];
    const warehouseId = getWarehouseIdByInvoiceType(invoice_type);

    /* ================================
       فك بيانات البودي (بدون حذف أي حاجة)
    ================================= */
    const {
      items,
      customer_name,
      customer_phone,
      previous_balance = 0,
      paid_amount = 0,
      apply_items_discount = false,
      manual_discount = 0,
    } = req.body;

    if (!items || !items.length) {
      throw new Error("لا يوجد أصناف في الفاتورة");
    }

    /* =========================================
       1️⃣ رجّع المخزن (الأصناف القديمة)
    ========================================= */
    const movementsRes = await client.query(
      `
  SELECT product_id, quantity, movement_type
  FROM stock_movements
  WHERE invoice_id = $1
  FOR UPDATE
`,
      [invoiceId],
    );

    for (const m of movementsRes.rows) {
      if (m.movement_type === "purchase" || m.movement_type === "transfer_in") {
        // كان فيه زيادة → نعكسها بخصم
        await client.query(
          `
      UPDATE stock
      SET quantity = quantity - $1
      WHERE warehouse_id = $2 AND product_id = $3
    `,
          [m.quantity, warehouseId, m.product_id],
        );
      }

      if (m.movement_type === "sale" || m.movement_type === "transfer_out") {
        // كان فيه خصم → نعكسه بإضافة
        await client.query(
          `
      UPDATE stock
      SET quantity = quantity + $1
      WHERE warehouse_id = $2 AND product_id = $3
    `,
          [m.quantity, warehouseId, m.product_id],
        );
      }
    }

    /* ================================
       2️⃣ امسح الحركات القديمة
    ================================= */
    await client.query(`DELETE FROM stock_movements WHERE invoice_id = $1`, [
      invoiceId,
    ]);

    /* ================================
       3️⃣ امسح أصناف الفاتورة القديمة
    ================================= */
    await client.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [
      invoiceId,
    ]);

    /* =========================================
       4️⃣ إدخال الأصناف الجديدة وتحديث المخزن
    ========================================= */
    for (const item of items) {
      const itemTotal =
        item.price * item.quantity - (item.discount || 0) * item.quantity;

      // ➕ invoice_items
      await client.query(
        `
        INSERT INTO invoice_items
        (
          invoice_id,
          product_id,
          product_name,
          package,
          price,
          quantity,
          discount,
          total
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        `,
        [
          invoiceId,
          item.product_id,
          item.product_name,
          item.package,
          item.price,
          item.quantity,
          item.discount || 0,
          itemTotal,
        ],
      );

      // 🔄 المخزن
      if (movement_type === "sale") {
        await client.query(
          `
          UPDATE stock
          SET quantity = quantity - $1
          WHERE warehouse_id = $2
            AND product_id = $3
          `,
          [item.quantity, warehouseId, item.product_id],
        );
      } else {
        await client.query(
          `
          INSERT INTO stock (warehouse_id, product_id, quantity)
          VALUES ($1,$2,$3)
          ON CONFLICT (warehouse_id, product_id)
          DO UPDATE SET quantity = stock.quantity + $3
          `,
          [warehouseId, item.product_id, item.quantity],
        );
      }

      // 🧾 stock_movements
      await client.query(
        `
        INSERT INTO stock_movements
        (invoice_id, warehouse_id, product_id, quantity, movement_type)
        VALUES ($1,$2,$3,$4,$5)
        `,
        [invoiceId, warehouseId, item.product_id, item.quantity, movement_type],
      );
    }

    /* ================================
       5️⃣ حسابات الفاتورة
    ================================= */
    let subtotal = 0;
    let itemsDiscount = 0;

    for (const item of items) {
      subtotal += item.price * item.quantity;
      itemsDiscount += (item.discount || 0) * item.quantity;
    }

    const extraDiscount = Number(manual_discount || 0);

    const discountTotal = apply_items_discount
      ? itemsDiscount + extraDiscount
      : extraDiscount;

    const total = subtotal - discountTotal;
    const totalWithPrevious = total + Number(previous_balance || 0);
    const remaining = totalWithPrevious - Number(paid_amount || 0);

    const payment_status =
      remaining <= 0 ? "paid" : paid_amount > 0 ? "partial" : "unpaid";

    /* ================================
       6️⃣ تحديث الفاتورة
    ================================= */
    await client.query(
      `
 UPDATE invoices
SET
  customer_name = $1,
  customer_phone = $2,
  previous_balance = $3,
  subtotal = $4,
  manual_discount = $5,
  discount_total = $6,
  total = $7,
  paid_amount = $8,
  remaining_amount = $9,
  payment_status = $10,
  apply_items_discount = $11   -- ✅
WHERE id = $12
  `,
      [
        customer_name,
        customer_phone,
        Number(previous_balance || 0),
        subtotal,
        extraDiscount,
        discountTotal,
        total,
        Number(paid_amount || 0),
        remaining,
        payment_status,
        apply_items_discount,
        invoiceId,
      ],
    );

    /* ================================
   7️⃣ تحديث / إنشاء قيد اليومية
================================ */

    if (movement_type === "sale" && Number(paid_amount) > 0) {
      const cashInRes = await client.query(
        `
    SELECT id
    FROM cash_in
    WHERE invoice_id = $1
      AND source_type = 'invoice'
    `,
        [invoiceId],
      );

      if (cashInRes.rows.length) {
        // 🟡 تحديث قيد موجود
        await client.query(
          `
      UPDATE cash_in
      SET
        amount = $1,
        paid_amount = $1,
        remaining_amount = $2,
        customer_name = $3,
        transaction_date = CURRENT_DATE
      WHERE invoice_id = $4
        AND source_type = 'invoice'
      `,
          [Number(paid_amount), remaining, customer_name, invoiceId],
        );
      } else {
        // 🟢 إنشاء قيد جديد
        await client.query(
          `
      INSERT INTO cash_in
      (
        branch_id,
        invoice_id,
        customer_name,
        amount,
        paid_amount,
        remaining_amount,
        description,
        source_type,
        transaction_date
      )
      VALUES
      ($1,$2,$3,$4,$4,$5,$6,'invoice',CURRENT_DATE)
      `,
          [
            /* branch_id */ 2, // أو خده من الفاتورة لو موجود
            invoiceId,
            customer_name,
            Number(paid_amount),
            remaining,
            `تحصيل تعديل فاتورة رقم ${invoiceId}`,
          ],
        );
      }
    }

    await client.query("COMMIT");

    res.json({
      success: true,
      invoice_id: invoiceId,
      remaining,
      payment_status,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("UPDATE INVOICE ERROR:", err);
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get("/invoices/:id/pdf", async (req, res) => {
  const invoiceId = req.params.id;

  try {
    /* =========================
       1) جلب البيانات (زي ما هي)
    ========================= */
    const invoiceRes = await pool.query(
      `SELECT * FROM invoices WHERE id = $1`,
      [invoiceId],
    );

    if (!invoiceRes.rows.length) {
      return res.status(404).send("Invoice not found");
    }

    const itemsRes = await pool.query(
      `
      SELECT
        ii.*,
        p.manufacturer
      FROM invoice_items ii
      LEFT JOIN products p ON p.id = ii.product_id
      WHERE ii.invoice_id = $1
      ORDER BY ii.id
      `,
      [invoiceId],
    );

    const invoice = invoiceRes.rows[0];
    const items = itemsRes.rows;

    /* =========================
       2) الحسابات (من غير أي تغيير)
    ========================= */
    const calcUnitPrice = (it) =>
      invoice.apply_items_discount
        ? Number(it.price) - Number(it.discount || 0)
        : Number(it.price);

    const calcItemTotal = (it) => calcUnitPrice(it) * Number(it.quantity || 0);

    const itemsSubtotal = items.reduce((sum, it) => sum + calcItemTotal(it), 0);

    const totalQty = items.reduce(
      (sum, it) => sum + Number(it.quantity || 0),
      0,
    );

    const previousBalance = Number(invoice.previous_balance) || 0;
    const paidAmount = Number(invoice.paid_amount) || 0;
    const extraDiscount = Number(invoice.manual_discount) || 0;

    const totalWithPrevious = itemsSubtotal + previousBalance;
    const netTotal = totalWithPrevious - extraDiscount;
    const remaining = netTotal - paidAmount;

    /* =========================
       3) HTML (RTL حقيقي)
    ========================= */
    const html = `
<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8" />
<style>
  body {
    font-family: 'Cairo', sans-serif;
    font-size: 14px;
    direction: rtl;
  }
  h2 {
    text-align: center;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 10px;
  }
  th, td {
    border-bottom: 1px solid #000;
    padding: 4px;
    text-align: center;
    white-space: nowrap;
  }
  th.name, td.name {
    text-align: right;
  }
  .summary {
    margin-top: 15px;
    text-align: left;
  }
</style>
</head>
<body>

<h2>فاتورة</h2>

<div>
  <div>رقم الفاتورة: ${invoice.id}</div>
  <div>التاريخ: ${new Date(invoice.created_at).toLocaleDateString("ar-EG")}</div>
  <div>العميل: ${invoice.customer_name || ""}</div>
  ${invoice.customer_phone ? `<div>تليفون: ${invoice.customer_phone}</div>` : ""}
</div>

<table>
<thead>
<tr>
  <th>م</th>
  <th class="name">الصنف</th>
  <th>العبوة</th>
  <th>الكمية</th>
  <th>السعر</th>
  <th>الإجمالي</th>
</tr>
</thead>
<tbody>
${items
  .map((it, i) => {
    const productName = [it.product_name, it.manufacturer]
      .filter(Boolean)
      .join(" ");
    const packText = it.package
      ? it.package.replace(/كرتونة\s*/g, "").trim()
      : "-";

    return `
<tr>
  <td>${i + 1}</td>
  <td class="name">${productName}</td>
  <td>${packText}</td>
  <td>${it.quantity}</td>
  <td>${calcUnitPrice(it).toFixed(2)}</td>
  <td>${calcItemTotal(it).toFixed(2)}</td>
</tr>
`;
  })
  .join("")}
</tbody>
</table>

<div class="summary">
  <div>إجمالي الكمية: ${totalQty}</div>
  <div>الإجمالي: ${itemsSubtotal.toFixed(2)}</div>
  ${previousBalance ? `<div>حساب سابق: ${previousBalance.toFixed(2)}</div>` : ""}
  ${extraDiscount ? `<div>خصم: ${extraDiscount.toFixed(2)}</div>` : ""}
  <div><strong>الصافي: ${netTotal.toFixed(2)}</strong></div>
  ${paidAmount ? `<div>المدفوع: ${paidAmount.toFixed(2)}</div>` : ""}
  ${remaining ? `<div><strong>المتبقي: ${remaining.toFixed(2)}</strong></div>` : ""}
</div>

</body>
</html>
`;

    /* =========================
       4) Puppeteer → PDF
    ========================= */
    const browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });

    const pdfBuffer = await page.pdf({
      format: "A5",
      printBackground: true,
    });

    await browser.close();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename=invoice-${invoiceId}.pdf`,
    );

    res.send(pdfBuffer);
  } catch (err) {
    console.error("PUPPETEER ERROR >>>", err);
    res.status(500).send(err.message);
  }
});

// Endpoint لطباعة الفاتورة كصفحة HTML (المتصفح هو اللي بيطبع / يحفظ PDF)
app.get("/invoices/:id/print", async (req, res) => {
  // رقم الفاتورة جاي من الـ URL
  const invoiceId = req.params.id;

  try {
    /* ======================================================
       1) جلب بيانات الفاتورة الأساسية (العميل – التاريخ …)
    ====================================================== */
    const invoiceRes = await pool.query(
      `SELECT * FROM invoices WHERE id = $1`,
      [invoiceId],
    );

    // لو الفاتورة مش موجودة
    if (!invoiceRes.rows.length) {
      return res.status(404).send("Invoice not found");
    }

    /* ======================================================
       2) جلب أصناف الفاتورة + اسم المصنع من جدول المنتجات
    ====================================================== */
    const itemsRes = await pool.query(
      `
      SELECT ii.*, p.manufacturer
      FROM invoice_items ii
      LEFT JOIN products p ON p.id = ii.product_id
      WHERE ii.invoice_id = $1
      ORDER BY ii.id
      `,
      [invoiceId],
    );

    const invoice = invoiceRes.rows[0];
    const items = itemsRes.rows;

    /* ======================================================
       3) دوال الحسابات (سعر – إجمالي – مجاميع)
    ====================================================== */

    // حساب سعر الوحدة (مع أو بدون خصم)
    const unitPrice = (it) =>
      invoice.apply_items_discount
        ? Number(it.price) - Number(it.discount || 0)
        : Number(it.price);

    // إجمالي الصنف = سعر الوحدة × الكمية
    const itemTotal = (it) => unitPrice(it) * Number(it.quantity || 0);

    // إجمالي كل الأصناف
    const subtotal = items.reduce((s, it) => s + itemTotal(it), 0);

    // إجمالي الكميات
    const totalQty = items.reduce((s, it) => s + Number(it.quantity || 0), 0);

    // قيم الفاتورة الإضافية
    const previousBalance = Number(invoice.previous_balance) || 0;
    const discount = Number(invoice.manual_discount) || 0;
    const paid = Number(invoice.paid_amount) || 0;

    // الصافي والمتبقي
    const netTotal = subtotal + previousBalance - discount;
    const remaining = netTotal - paid;

    /* ======================================================
       4) تجهيز صفوف جدول الأصناف (HTML ديناميكي)
    ====================================================== */
    const rowsHtml = items
      .map((it, i) => {
        // تنظيف نص العبوة (إزالة كلمة كرتونة)
        const pack = it.package
          ? it.package.replace(/كرتونة\s*/g, "").trim()
          : "";

        // اسم الصنف بالشكل:
        // اسم الصنف - المصنع (العبوة)
        const name = `
          ${it.product_name}
          ${it.manufacturer ? " - " + it.manufacturer : ""}
          ${pack ? " (" + pack + ")" : ""}
        `;

        // صف الجدول
        return `
<tr>
  <td>${i + 1}</td>
  <td class="name">${name}</td>
  <td>${it.quantity}</td>
  <td>${unitPrice(it).toFixed(2)}</td>
  <td>${itemTotal(it).toFixed(2)}</td>
</tr>`;
      })
      .join("");

    /* ======================================================
       5) إرسال صفحة HTML كاملة للطباعة
    ====================================================== */
    res.send(`
<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">

<style>
/* إعدادات حجم الورق للطباعة */
@page {
  size: A5 portrait;
  margin: 10mm;
}
html, body {
  width: 148mm;
  height: 210mm;
}

/* الإعدادات العامة */
body {
  font-family: Cairo, Arial, sans-serif;
  font-size: 14px;
  margin: 0;
  color: #000;
}

/* ===== Header ===== */
.header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
}

/* بيانات الفاتورة */
.info {
  text-align: right;
  font-size: 14px;
  line-height: 1.8;
}

/* اللوجو */
.logo img {
  width: 75px;
}

/* خط فاصل عريض */
.hr-bold {
  border-top: 2px solid #000;
  margin: 6px 0;
}

/* الجدول */
table {
  width: 100%;
  border-collapse: collapse;
}

th, td {
  padding: 5px;             /* ⬅️ زودنا الارتفاع */
  text-align: center;
  line-height: 1.3;         /* ⬅️ طول السطر */
}

th {
  border-bottom: 2px solid #000;
   font-size: 14px;
}

/* اسم الصنف */
td.name {
  text-align: center;       /* ⬅️ في وسط الحقل */
  white-space: normal;
  font-size: 13px;          /* ⬅️ أكبر شوية */
  line-height: 1.3;
}
tbody tr:not(.total-row) td {
  border-bottom: 1px solid #000;
}
.total-row td {
  font-weight: bold;
  border-top: 2px solid #000;
}

/* ملخص الفاتورة */
.summary {
  margin-top: 6px;
  border-top: 2px solid #000;
  padding-top: 6px;
  font-size: 13px;
}

.summary div {
  margin: 3px 0;
  text-align: left;
}

.summary strong {
  font-weight: bold;
}

/* إزالة الهوامش وقت الطباعة */
@media print {
  body { margin: 0; }
}
</style>
</head>

<body>

<!-- ===== HEADER ===== -->
<div class="header">
  <div class="info">
    <div><strong>رقم الفاتورة:</strong> ${invoice.id}</div>
    <div><strong>التاريخ:</strong> ${new Date(invoice.created_at).toLocaleDateString("ar-EG")}</div>
    <div><strong>العميل:</strong> ${invoice.customer_name || "نقدي"}</div>
    ${
      invoice.customer_phone
        ? `<div><strong>تليفون:</strong> ${invoice.customer_phone}</div>`
        : ""
    }
  </div>

  <div class="logo">
    <img src="/assets/logo.png">
  </div>
</div>

<div class="hr-bold"></div>

<!-- ===== جدول الأصناف ===== -->
<table>
  <thead>
    <tr>
      <th>م</th>
      <th class="name">الصنف</th>
      <th>الكمية</th>
      <th>السعر</th>
      <th>الإجمالي</th>
    </tr>
  </thead>
  <tbody>
    ${rowsHtml}

    <!-- صف إجمالي الكمية وإجمالي السعر -->
   <tr class="total-row">

      <td></td>
      <td></td>
      <td>${totalQty}</td>
      <td></td>
      <td>${subtotal.toFixed(2)}</td>
    </tr>
  </tbody>
   </table>


<!-- ===== ملخص الفاتورة ===== -->
<div class="summary">
  ${previousBalance ? `<div>حساب سابق: ${previousBalance.toFixed(2)}</div>` : ""}
  ${discount ? `<div>خصم: ${discount.toFixed(2)}</div>` : ""}
  <div><strong>الصافي: ${netTotal.toFixed(2)}</strong></div>
  ${paid ? `<div>المدفوع: ${paid.toFixed(2)}</div>` : ""}
  ${remaining ? `<div><strong>المتبقي: ${remaining.toFixed(2)}</strong></div>` : ""}
</div>

<script>
// فتح نافذة الطباعة تلقائيًا عند تحميل الصفحة
window.onload = () => window.print();
</script>

</body>
</html>
`);
  } catch (err) {
    console.error(err);
    res.status(500).send("Print failed");
  }
});

app.get("/customers/:id/last-balance", async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `
      SELECT remaining_amount
      FROM invoices
      WHERE customer_id = $1
        AND is_void = false
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [id],
    );

    res.json({
      previous_balance: result.rows.length
        ? result.rows[0].remaining_amount
        : 0,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error" });
  }
});

app.get("/customers/:id/balance", authMiddleware, async (req, res) => {
  try {
    const customerId = req.params.id;
    const { invoice_type } = req.query;
    const branch_id = req.user.branch_id;

    if (!invoice_type) {
      return res.status(400).json({ error: "invoice_type مطلوب" });
    }

    const result = await pool.query(
      `
      SELECT remaining_amount
      FROM invoices
      WHERE customer_id = $1
        AND branch_id = $2
        AND invoice_type = $3
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [customerId, branch_id, invoice_type],
    );

    res.json({
      balance: result.rows.length ? Number(result.rows[0].remaining_amount) : 0,
    });
  } catch (err) {
    console.error("GET CUSTOMER BALANCE ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/invoices", async (req, res) => {
  try {
    const {
      branch_id,
      invoice_type,
      movement_type,
      customer_name,
      limit = 50,
      offset = 0,
    } = req.query;

    let conditions = [];
    let values = [];
    let idx = 1;

    if (branch_id) {
      conditions.push(`branch_id = $${idx++}`);
      values.push(branch_id);
    }

    if (invoice_type) {
      conditions.push(`invoice_type = $${idx++}`);
      values.push(invoice_type);
    }

    if (movement_type) {
      conditions.push(`movement_type = $${idx++}`);
      values.push(movement_type);
    }

    if (customer_name) {
      conditions.push(`customer_name ILIKE  $${idx++}`);
      values.push(`%${customer_name}%`);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const result = await pool.query(
      `
      SELECT
        id,
        invoice_type,
        movement_type,
        customer_name,
        customer_phone,
        subtotal,
        discount_total,
        total,
        paid_amount,
        remaining_amount,
        payment_status,
        created_at
      FROM invoices
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
      `,
      [...values, limit, offset],
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error" });
  }
});

app.delete("/invoices/:id", async (req, res) => {
  const client = await pool.connect();
  const invoiceId = Number(req.params.id);

  try {
    await client.query("BEGIN");

    // 0️⃣ تحقق من اليومية
    const cashCheck = await client.query(
      `SELECT id FROM cash_in WHERE invoice_id = $1`,
      [invoiceId],
    );
    if (cashCheck.rowCount > 0) {
      throw new Error("لا يمكن مسح الفاتورة لأنها مرتبطة بقيد خزنة");
    }

    // 1️⃣ هات الحركات
    const movementsRes = await client.query(
      `
      SELECT warehouse_id, product_id, quantity, movement_type
      FROM stock_movements
      WHERE invoice_id = $1
      FOR UPDATE
    `,
      [invoiceId],
    );

    // 2️⃣ عكس الحركة (مرة واحدة فقط ✅)
    for (const m of movementsRes.rows) {
      if (m.movement_type === "purchase") {
        await client.query(
          `
          UPDATE stock
          SET quantity = quantity - $1
          WHERE warehouse_id = $2 AND product_id = $3
        `,
          [m.quantity, m.warehouse_id, m.product_id],
        );
      } else if (m.movement_type === "sale") {
        await client.query(
          `
          UPDATE stock
          SET quantity = quantity + $1
          WHERE warehouse_id = $2 AND product_id = $3
        `,
          [m.quantity, m.warehouse_id, m.product_id],
        );
      }
    }

    // 3️⃣ مسح الحركات
    await client.query(`DELETE FROM stock_movements WHERE invoice_id = $1`, [
      invoiceId,
    ]);

    // 4️⃣ مسح الأصناف
    await client.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [
      invoiceId,
    ]);

    // 5️⃣ مسح الفاتورة
    await client.query(`DELETE FROM invoices WHERE id = $1`, [invoiceId]);

    await client.query("COMMIT");
    res.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ===== إدارة الأصناف =====

// جلب كل الأصناف (للإدارة)
app.get("/admin/products", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
  id,
  name,
  wholesale_package,
  retail_package,
  manufacturer,
  purchase_price,
  retail_purchase_price,
  wholesale_price,
  retail_price,
  barcode,
  discount_amount,
  is_active
FROM products
ORDER BY name`,
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

console.log("TRANSFER ROUTE LOADED");

// إضافة صنف جديد
app.post("/admin/products", async (req, res) => {
  try {
    const {
      name,
      wholesale_package,
      retail_package,
      manufacturer,
      purchase_price,
      retail_purchase_price,
      wholesale_price,
      retail_price,
      barcode,
      discount_amount = 0,
    } = req.body;
    const nameNormalized = normalizeNumbers(name);
    const wholesalePackageNormalized = normalizeNumbers(wholesale_package);
    const retailPackageNormalized = normalizeNumbers(retail_package);

    if (
      !name ||
      !wholesale_package ||
      !retail_package ||
      purchase_price === undefined ||
      retail_purchase_price === undefined ||
      wholesale_price === undefined ||
      retail_price === undefined
    ) {
      return res.status(400).json({ error: "بيانات ناقصة" });
    }

    const insertRes = await pool.query(
      `
      INSERT INTO products
(
  name,
  wholesale_package,
  retail_package,
  manufacturer,
  retail_purchase_price,
  barcode,
  purchase_price,
  wholesale_price,
  retail_price,
  discount_amount
)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
RETURNING *

      `,
      [
        nameNormalized,
        wholesalePackageNormalized,
        retailPackageNormalized,
        manufacturer,
        retail_purchase_price,
        barcode || null,
        purchase_price,
        wholesale_price,
        retail_price,
        discount_amount,
      ],
    );

    let product = insertRes.rows[0];

    // 2️⃣ لو مفيش باركود → ولّد
    if (!product.barcode) {
      const generatedBarcode = `900000${product.id}`;

      const updateRes = await pool.query(
        `
        UPDATE products
        SET barcode = $1
        WHERE id = $2
        RETURNING *
        `,
        [generatedBarcode, product.id],
      );

      product = updateRes.rows[0];
    }

    res.json(product);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// تعديل صنف
app.put("/admin/products/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name,
      wholesale_package,
      retail_package,
      manufacturer,
      barcode,
      purchase_price,
      retail_purchase_price,
      wholesale_price,
      retail_price,
      discount_amount = 0,
    } = req.body;
    const nameNormalized = normalizeNumbers(name);
    const wholesalePackageNormalized = normalizeNumbers(wholesale_package);
    const retailPackageNormalized = normalizeNumbers(retail_package);

    if (
      !name ||
      !wholesale_package ||
      !retail_package ||
      purchase_price === undefined ||
      retail_purchase_price === undefined ||
      wholesale_price === undefined ||
      retail_price === undefined
    ) {
      return res.status(400).json({ error: "بيانات ناقصة" });
    }

    const result = await pool.query(
      `
      UPDATE products
SET
  name = $1,
  wholesale_package = $2,
  retail_package = $3,
  manufacturer = $4,
  barcode = $5,
  purchase_price = $6,
  retail_purchase_price = $7,
  wholesale_price = $8,
  retail_price = $9,
  discount_amount = $10
WHERE id = $11
RETURNING *
      `,
      [
        nameNormalized,
        wholesalePackageNormalized,
        retailPackageNormalized,
        manufacturer,
        barcode || null,
        purchase_price,
        retail_purchase_price,
        wholesale_price,
        retail_price,
        discount_amount,
        id,
      ],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "الصنف غير موجود" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// تفعيل / إيقاف الصنف
app.put("/admin/products/:id/toggle", async (req, res) => {
  try {
    const { id } = req.params;
    const { is_active } = req.body;

    if (typeof is_active !== "boolean") {
      return res.status(400).json({ error: "قيمة is_active غير صحيحة" });
    }

    const result = await pool.query(
      `
      UPDATE products
      SET is_active = $1
      WHERE id = $2
      RETURNING id, name, is_active
      `,
      [is_active, id],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "الصنف غير موجود" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// بحث باركود صنف
app.get("/products/by-barcode/:barcode", async (req, res) => {
  try {
    const { barcode } = req.params;
    const { invoice_type, movement_type } = req.query;

    if (!barcode || !invoice_type || !movement_type) {
      return res.status(400).json({
        error: "barcode و invoice_type و movement_type مطلوبين",
      });
    }
    if (invoice_type !== "retail") {
      return res.status(400).json({
        error: "البحث بالباركود متاح للقطاعي فقط",
      });
    }
    // نفس منطق المخزن
    const warehouseId = 1;

    let result;

    if (movement_type === "sale") {
      // 🔴 بيع → لازم رصيد
      result = await pool.query(
        `
        SELECT
          p.id,
          p.name,
          p.wholesale_package,
          p.retail_package,
          p.manufacturer,
          p.barcode,
          CASE
            WHEN $1 = 'wholesale' THEN p.wholesale_price
            ELSE p.retail_price
          END AS price,
          p.discount_amount,
          s.quantity AS available_quantity
        FROM products p
        JOIN stock s
          ON s.product_id = p.id
          AND s.warehouse_id = $2
        WHERE p.barcode = $3
          AND p.is_active = true
          AND s.quantity > 0
        LIMIT 1
        `,
        [invoice_type, warehouseId, barcode],
      );
    } else {
      // 🟢 شراء
      result = await pool.query(
        `
        SELECT
          p.id,
          p.name,
          p.wholesale_package,
          p.retail_package,
          p.manufacturer,
          p.barcode,
          CASE
            WHEN $1 = 'wholesale' THEN p.purchase_price
            ELSE p.retail_purchase_price
          END AS price,
          p.discount_amount,
          0 AS available_quantity
        FROM products p
        WHERE p.barcode = $2
          AND p.is_active = true
        LIMIT 1
        `,
        [invoice_type, barcode],
      );
    }

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "الصنف غير موجود" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/stock/transfer", async (req, res) => {
  const client = await pool.connect();
  try {
    const { from_branch_id, to_branch_id, items } = req.body;

    if (!from_branch_id || !to_branch_id || !items || items.length === 0) {
      return res.status(400).json({ error: "Invalid request data" });
    }

    await client.query("BEGIN");

    // مخزن المصدر
    const fromWarehouseRes = await client.query(
      "SELECT id FROM warehouses WHERE branch_id = $1",
      [from_branch_id],
    );
    const fromWarehouseId = fromWarehouseRes.rows[0].id;

    // مخزن الوجهة
    const toWarehouseRes = await client.query(
      "SELECT id FROM warehouses WHERE branch_id = $1",
      [to_branch_id],
    );
    const toWarehouseId = toWarehouseRes.rows[0].id;

    for (const item of items) {
      const { product_id, quantity } = item;

      // تحقق من رصيد المصدر
      const stockRes = await client.query(
        "SELECT quantity FROM stock WHERE warehouse_id = $1 AND product_id = $2",
        [fromWarehouseId, product_id],
      );

      const available = stockRes.rows.length ? stockRes.rows[0].quantity : 0;
      if (available < quantity) {
        throw new Error(`Insufficient stock for product ${product_id}`);
      }

      // خصم من المصدر
      await client.query(
        `
        UPDATE stock
        SET quantity = quantity - $1
        WHERE warehouse_id = $2 AND product_id = $3
        `,
        [quantity, fromWarehouseId, product_id],
      );

      // إضافة للوجهة (لو مش موجود ينشئه)
      await client.query(
        `
        INSERT INTO stock (warehouse_id, product_id, quantity)
        VALUES ($1, $2, $3)
        ON CONFLICT (warehouse_id, product_id)
        DO UPDATE SET quantity = stock.quantity + $3
        `,
        [toWarehouseId, product_id, quantity],
      );

      // حركة خروج
      await client.query(
        `
        INSERT INTO stock_movements
        (warehouse_id, product_id, quantity, movement_type)
        VALUES ($1, $2, $3, 'transfer_out')
        `,
        [fromWarehouseId, product_id, quantity],
      );

      // حركة دخول
      await client.query(
        `
        INSERT INTO stock_movements
        (warehouse_id, product_id, quantity, movement_type)
        VALUES ($1, $2, $3, 'transfer_in')
        `,
        [toWarehouseId, product_id, quantity],
      );
    }

    await client.query("COMMIT");

    res.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get("/stock/quantity", async (req, res) => {
  const { product_id, branch_id } = req.query;

  if (!product_id || !branch_id) {
    return res.status(400).json({ error: "بيانات ناقصة" });
  }

  try {
    const warehouse_id = await getWholesaleWarehouseByBranch(branch_id);

    const result = await pool.query(
      `
      SELECT quantity
      FROM stock
      WHERE product_id = $1 AND warehouse_id = $2
      `,
      [product_id, warehouse_id],
    );

    const quantity = result.rows.length ? result.rows[0].quantity : 0;

    res.json({ quantity });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/products/for-replace", async (req, res) => {
  try {
    const { branch_id } = req.query;

    if (!branch_id) {
      return res.status(400).json({ error: "branch_id مطلوب" });
    }

    // 👇 مخزن الجملة للفرع
    const warehouse_id = await getWholesaleWarehouseByBranch(branch_id);

    const result = await pool.query(
      `
      SELECT
        p.id,
        p.name,
        p.wholesale_package,
        p.retail_package,
        p.manufacturer,
        p.purchase_price AS wholesale_price,   -- ✅ سعر الشراء
        COALESCE(s.quantity, 0) AS available_quantity
      FROM products p
      LEFT JOIN stock s
        ON s.product_id = p.id
        AND s.warehouse_id = $1
      WHERE p.is_active = true
      ORDER BY p.name
      `,
      [warehouse_id],
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/stock/replace", async (req, res) => {
  const {
    branch_id,
    out_product_id,
    out_quantity,
    in_product_id,
    in_quantity,
    note,
  } = req.body;

  if (
    !branch_id ||
    !out_product_id ||
    !out_quantity ||
    !in_product_id ||
    !in_quantity
  ) {
    return res.status(400).json({ error: "بيانات ناقصة" });
  }

  const client = await pool.connect();

  try {
    const warehouse_id = await getWholesaleWarehouseByBranch(branch_id);
    await client.query("BEGIN");

    const result = await client.query(
      `SELECT quantity
     FROM stock
     WHERE product_id = $1 AND warehouse_id = $2
     FOR UPDATE`,
      [out_product_id, warehouse_id],
    );

    if (result.rows.length === 0) {
      throw new Error("الصنف غير موجود في المخزن");
    }

    const currentQuantity = result.rows[0].quantity;

    if (currentQuantity < out_quantity) {
      throw new Error("رصيد غير كافي");
    }

    // 1️⃣ خصم الصنف المكسور
    await client.query(
      `
  UPDATE stock
  SET quantity = quantity - $1
  WHERE product_id = $2 AND warehouse_id = $3
  `,
      [out_quantity, out_product_id, warehouse_id],
    );

    // 2️⃣ حركة خروج (كسر)
    await client.query(
      `
  INSERT INTO stock_movements
  (warehouse_id, product_id, quantity, movement_type, note)
  VALUES ($1, $2, $3, 'replace_out', $4)
  `,
      [warehouse_id, out_product_id, out_quantity, note],
    );

    // 3️⃣ إضافة الصنف البديل
    await client.query(
      `
  INSERT INTO stock (warehouse_id, product_id, quantity)
  VALUES ($1, $2, $3)
  ON CONFLICT (warehouse_id, product_id)
  DO UPDATE SET quantity = stock.quantity + $3
  `,
      [warehouse_id, in_product_id, in_quantity],
    );

    // 4️⃣ حركة دخول (بدل)
    await client.query(
      `
  INSERT INTO stock_movements
  (warehouse_id, product_id, quantity, movement_type, note)
  VALUES ($1, $2, $3, 'replace_in', $4)
  `,
      [warehouse_id, in_product_id, in_quantity, note],
    );

    await client.query("COMMIT");

    res.json({
      message: "تم استبدال المصنع بنجاح",
    });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

/* ===============================
   💸 CASH OUT - إضافة إذن صرف
================================ */
app.post("/cash/out", authMiddleware, async (req, res) => {
  try {
    const branch_id = req.user.branch_id; // ✅ من التوكن
    const { name, amount, notes, date, entry_type } = req.body;
    const safeEntryType =
      entry_type === "purchase" || entry_type === "expense"
        ? entry_type
        : "expense";

    if (!name || !amount || !date) {
      return res.status(400).json({ error: "بيانات ناقصة" });
    }

    // توليد رقم إذن (نفس منطق الفرونت)
    const datePart = date.replace(/-/g, "").slice(2);
    const randomPart = Math.floor(1000 + Math.random() * 9000);
    const permissionNumber = `${datePart}-${randomPart}`;

    const result = await pool.query(
      `
      INSERT INTO cash_out
      (
        branch_id,
        name,
        amount,
        notes,
        transaction_date,
       permission_number,
        entry_type

      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, permission_number
      `,
      [
        branch_id,
        name,
        Number(amount),
        notes || null,
        date,
        permissionNumber,
        safeEntryType,
      ],
    );

    res.json({
      success: true,
      id: result.rows[0].id,
      permission_number: result.rows[0].permission_number,
    });
  } catch (err) {
    console.error("CASH OUT ERROR:", err);
    res.status(500).json({ error: "خطأ في السيرفر" });
  }
});

/* ===============================
   ✏️ CASH OUT - تعديل إذن صرف
================================ */
app.put("/cash/out/:id", authMiddleware, async (req, res) => {
  try {
    const branch_id = req.user.branch_id;
    const { id } = req.params;
    const { name, amount, notes, date, entry_type } = req.body;
    const safeEntryType =
      entry_type === "purchase" || entry_type === "expense"
        ? entry_type
        : "expense";

    const result = await pool.query(
      `
      UPDATE cash_out
      SET name=$1, amount=$2, notes=$3, transaction_date=$4, entry_type=$5
      WHERE id=$6 AND branch_id=$7
      RETURNING *
      `,
      [name, Number(amount), notes || null, date, safeEntryType, id, branch_id],
    );

    if (!result.rows.length) {
      return res.status(403).json({ error: "غير مسموح بالتعديل" });
    }

    res.json({
      success: true,
      message: "تم تعديل إذن الصرف بنجاح",
      data: result.rows[0],
    });
  } catch (err) {
    console.error("UPDATE CASH OUT ERROR:", err);
    res.status(500).json({
      error: "خطأ في السيرفر",
    });
  }
});

/* ===============================
   📄 CASH OUT - عرض المنصرف
================================ */
app.get("/cash/out", authMiddleware, async (req, res) => {
  try {
    const { from_date, to_date, limit = 50, offset = 0 } = req.query;
    const branch_id = req.user.branch_id; // ✅ الفرع من التوكن

    let conditions = [`branch_id = $1`];
    let values = [branch_id];
    let idx = 2;

    //if (branch_id) {
    //conditions.push(`branch_id = $${idx++}`);
    //values.push(branch_id);
    // }

    if (from_date) {
      conditions.push(`transaction_date >= $${idx++}`);
      values.push(from_date);
    }

    if (to_date) {
      conditions.push(`transaction_date <= $${idx++}`);
      values.push(to_date);
    }

    //const whereClause =
    //conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const result = await pool.query(
      `
      SELECT
        id,
        permission_number,
        name,
        amount,
        notes,
        to_char(transaction_date, 'YYYY-MM-DD') AS transaction_date,
        created_at,
         entry_type
      FROM cash_out
      WHERE ${conditions.join(" AND ")}
      ORDER BY transaction_date DESC, created_at DESC, id DESC
      LIMIT $${idx++} OFFSET $${idx++}
      `,
      [...values, limit, offset],
    );

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (err) {
    console.error("GET CASH OUT ERROR:", err);
    res.status(500).json({ error: "خطأ في السيرفر" });
  }
});

/* ===============================
   🔎 CASH OUT - جلب منصرف واحد
================================ */
app.get("/cash/out/:id", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const branch_id = req.user.branch_id;

    const result = await pool.query(
      `
      SELECT
        id,
        permission_number,
        name,
        amount,
        notes,
        to_char(transaction_date, 'YYYY-MM-DD') AS transaction_date,
        entry_type
      FROM cash_out
      WHERE id = $1 AND branch_id = $2
      `,
      [id, branch_id],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "غير موجود أو غير مصرح" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("GET CASH OUT BY ID ERROR:", err);
    res.status(500).json({ error: "خطأ في السيرفر" });
  }
});

app.delete("/cash/out/:id", authMiddleware, async (req, res) => {
  try {
    const branch_id = req.user.branch_id;
    const { id } = req.params;

    const result = await pool.query(
      `DELETE FROM cash_out WHERE id=$1 AND branch_id=$2 RETURNING id`,
      [id, branch_id],
    );

    if (!result.rowCount) {
      return res.status(403).json({ error: "غير مسموح بالحذف" });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("DELETE CASH OUT ERROR:", err);
    res.status(500).json({ error: "خطأ أثناء الحذف" });
  }
});

app.post("/cash/in/from-invoice", authMiddleware, async (req, res) => {
  const client = await pool.connect();

  try {
    const { invoice_id } = req.body;
    const userBranchId = req.user.branch_id; // ✅ لازم السطر ده

    if (!invoice_id) {
      return res.status(400).json({ error: "invoice_id مطلوب" });
    }

    await client.query("BEGIN");

    // 1️⃣ جلب بيانات الفاتورة
    const invoiceRes = await client.query(
      `
     SELECT
  id,
  branch_id,
  customer_id,
  customer_name,
  paid_amount,
  total,
  previous_balance,
  movement_type
FROM invoices
WHERE id = $1
      `,
      [invoice_id],
    );

    if (!invoiceRes.rows.length) {
      throw new Error("الفاتورة غير موجودة");
    }

    const invoice = invoiceRes.rows[0];
    // 🔐 منع ترحيل فاتورة من فرع آخر
    if (invoice.branch_id !== userBranchId) {
      throw new Error("غير مسموح بترحيل فاتورة من فرع آخر");
    }

    if (invoice.movement_type !== "sale") {
      await client.query("COMMIT");
      return res.json({
        success: true,
        message: "فاتورة شراء - لا يتم ترحيلها إلى اليومية",
      });
    }

    const totalWithPrevious =
      Number(invoice.total || 0) + Number(invoice.previous_balance || 0);

    const remainingCash = totalWithPrevious - Number(invoice.paid_amount || 0);

    if (Number(invoice.paid_amount) <= 0) {
      await client.query(
        `
    UPDATE cash_in
    SET
      amount = 0,
      paid_amount = 0,
      remaining_amount = $1,
      transaction_date = CURRENT_DATE
    WHERE invoice_id = $2
      AND source_type = 'invoice'
      AND branch_id = $3
    `,
        [totalWithPrevious, invoice.id, userBranchId],
      );

      await client.query("COMMIT");
      return res.json({
        success: true,
        message: "تم تحديث اليومية (لا يوجد مبلغ مدفوع)",
      });
    }

    // 2️⃣ هل الفاتورة مترحلة؟
    const cashInRes = await client.query(
      `
     SELECT id
FROM cash_in
WHERE invoice_id = $1
  AND source_type = 'invoice'
  AND branch_id = $2
      `,
      [invoice_id, userBranchId],
    );

    const description = "فاتورة";

    let message = "";

    if (cashInRes.rows.length) {
      // ✅ تحديث القيد الموجود
      await client.query(
        `
  UPDATE cash_in
  SET
    amount = $1,
    paid_amount = $1,
    remaining_amount = $2,
    transaction_date = CURRENT_DATE,
    customer_name = $3
  WHERE invoice_id = $4
    AND source_type = 'invoice'
    AND branch_id = $5
  `,
        [
          invoice.paid_amount,
          remainingCash,
          invoice.customer_name,
          invoice.id,
          userBranchId,
        ],
      );

      message = "تم تحديث اليومية بنجاح";
    } else {
      // ➕ ترحيل جديد
      await client.query(
        `
  INSERT INTO cash_in
  (
    branch_id,
    invoice_id,
    customer_id,
    customer_name,
    amount,
    paid_amount,
    remaining_amount,
    description,
    source_type,
    transaction_date
  )
  VALUES
  ($1,$2,$3,$4,$5,$6,$7,$8,'invoice',CURRENT_DATE)
  `,
        [
          userBranchId,
          invoice.id,
          invoice.customer_id || null,
          invoice.customer_name,
          invoice.paid_amount, // amount
          invoice.paid_amount, // paid_amount
          remainingCash,
          description,
        ],
      );

      message = "تم ترحيل الفاتورة إلى اليومية";
    }

    await client.query("COMMIT");

    res.json({
      success: true,
      message,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("CASH IN FROM INVOICE ERROR:", err);
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post("/cash/in", authMiddleware, async (req, res) => {
  const client = await pool.connect();

  try {
    console.log("CASH IN BODY:", req.body);
    const branch_id = req.user.branch_id; // 🔐
    const {
      transaction_date,
      customer_name,
      description,
      amount,
      notes,
      source_type,
    } = req.body;

    if (!branch_id || !amount || Number(amount) <= 0) {
      return res
        .status(400)
        .json({ error: "بيانات غير مكتملة", body: req.body });
    }

    await client.query("BEGIN");

    const result = await client.query(
      `
  INSERT INTO cash_in
  (
    branch_id,
    transaction_date,
    source_type,
    customer_name,
    description,
    amount,
    paid_amount,
    remaining_amount,
    notes
  )
  VALUES
  (
    $1::integer,
    $2::date,
    $3::varchar,
    $4::varchar,
    $5::text,
    $6::numeric,
    $7::numeric,
    0::numeric,
    $8::text
  )
  RETURNING id
  `,
      [
        Number(branch_id), // 1
        transaction_date || new Date().toISOString().slice(0, 10), // 2
        source_type || "manual", // 3
        customer_name || "وارد يدوي", // 4
        description || "", // 5
        Number(amount), // 6
        Number(amount), // 7
        notes || null, // 8
      ],
    );

    // ✅ خصم سند الدفع من آخر مديونية للعميل (نظام الرصيد المرحّل)
    if (source_type === "customer_payment" && customer_name) {
      let paymentAmount = Number(amount);

      const lastInvoiceRes = await client.query(
        `
    SELECT id, remaining_amount, paid_amount
    FROM invoices
    WHERE customer_name = $1
      AND branch_id = $2
      AND remaining_amount > 0
    ORDER BY created_at DESC
    LIMIT 1
    `,
        [customer_name, branch_id],
      );

      if (lastInvoiceRes.rows.length) {
        const invoice = lastInvoiceRes.rows[0];

        const newRemaining = Math.max(
          0,
          Number(invoice.remaining_amount) - paymentAmount,
        );

        const newPaid = Number(invoice.paid_amount) + paymentAmount;

        await client.query(
          `
  UPDATE invoices
  SET
    paid_amount = $1::numeric,
    remaining_amount = $2::numeric,
    payment_status =
      CASE
        WHEN $2::numeric <= 0 THEN 'paid'
        ELSE 'partial'
      END
  WHERE id = $3::integer
  `,
          [newPaid, newRemaining, invoice.id],
        );
      }
    }

    await client.query("COMMIT");

    res.json({
      success: true,
      cash_in_id: result.rows[0].id,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("CASH IN ERROR:", err);
    res.status(500).json({ error: "فشل إضافة الوارد" });
  } finally {
    client.release();
  }
});

app.get("/cash-in", authMiddleware, async (req, res) => {
  const client = await pool.connect();

  try {
    const branch_id = req.user.branch_id; // 🔐 من التوكن

    const result = await client.query(
      `
      SELECT
        id,
        branch_id,
        customer_name,
        amount,
        paid_amount,
        remaining_amount,
        COALESCE(notes, description) AS notes,
        to_char(transaction_date, 'YYYY-MM-DD') AS transaction_date,
        source_type,
        invoice_id,
        created_at
      FROM cash_in
       WHERE branch_id = $1
      ORDER BY transaction_date DESC, id DESC
      `,
      [branch_id],
    );

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "فشل تحميل وارد الخزنة",
    });
  } finally {
    client.release();
  }
});
app.delete("/cash-in/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;
  const branch_id = req.user.branch_id;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const checkRes = await client.query(
      `SELECT id FROM cash_in WHERE id = $1 AND branch_id = $2`,
      [id, branch_id],
    );

    if (!checkRes.rows.length) {
      return res.status(404).json({ error: "القيد غير موجود" });
    }

    await client.query(`DELETE FROM cash_in WHERE id = $1 AND branch_id = $2`, [
      id,
      branch_id,
    ]);

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "تم حذف القيد بنجاح",
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("DELETE CASH IN ERROR:", err);
    res.status(500).json({ error: "فشل حذف القيد" });
  } finally {
    client.release();
  }
});

app.put("/cash-in/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { customer_name, description, amount, transaction_date } = req.body;
  const branch_id = req.user.branch_id;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const checkRes = await client.query(
      `
      SELECT id, source_type
      FROM cash_in
      WHERE id = $1 AND branch_id = $2
      `,
      [id, branch_id],
    );

    if (!checkRes.rows.length) {
      return res.status(403).json({ error: "غير مسموح بالتعديل" });
    }

    if (checkRes.rows[0].source_type !== "manual") {
      return res.status(400).json({ error: "لا يمكن تعديل قيد غير يدوي" });
    }

    await client.query(
      `
      UPDATE cash_in
      SET
        customer_name = $1,
        description = $2,
        amount = $3,
        paid_amount = $3,
        transaction_date = $4::date
      WHERE id = $5 AND branch_id = $6
      `,
      [
        customer_name,
        description,
        Number(amount),
        transaction_date,
        id,
        branch_id,
      ],
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "تم تعديل القيد بنجاح",
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("UPDATE CASH IN ERROR:", err);
    res.status(500).json({ error: "فشل تعديل القيد" });
  } finally {
    client.release();
  }
});

app.get("/cash-in/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;
  const branch_id = req.user.branch_id;
  const client = await pool.connect();

  try {
    const result = await client.query(
      `
      SELECT
        id,
        branch_id,
        customer_name,
        amount,
        paid_amount,
        remaining_amount,
        description,
        to_char(transaction_date, 'YYYY-MM-DD') AS transaction_date,
        source_type,
        invoice_id,
        created_at
      FROM cash_in
      WHERE id = $1 AND branch_id = $2
      `,
      [id, branch_id],
    );

    if (!result.rows.length) {
      return res.status(404).json({
        error: "القيد غير موجود",
      });
    }

    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (err) {
    console.error("GET CASH IN BY ID ERROR:", err);
    res.status(500).json({
      error: "فشل تحميل القيد",
    });
  } finally {
    client.release();
  }
});

app.post("/stock/wholesale-to-retail/preview", async (req, res) => {
  try {
    const { from_branch_id, to_branch_id, items } = req.body;

    if (
      !from_branch_id ||
      !to_branch_id ||
      !items ||
      !Array.isArray(items) ||
      items.length === 0
    ) {
      return res.status(400).json({ error: "بيانات ناقصة" });
    }

    // ✅ مخزن الجملة (المصدر)
    const wholesaleWarehouseId =
      await getWholesaleWarehouseByBranch(from_branch_id);

    const previewResults = [];

    for (const item of items) {
      const { product_id, quantity } = item;

      if (!product_id || !quantity || quantity <= 0) {
        previewResults.push({
          product_id,
          status: "rejected",
          reason: "INVALID_ITEM_DATA",
        });
        continue;
      }

      // 1️⃣ بيانات الصنف
      const productRes = await pool.query(
        `
       SELECT
  id,
  name,
  manufacturer,
  wholesale_package,
  retail_package
FROM products

        WHERE id = $1 AND is_active = true
        `,
        [product_id],
      );

      if (!productRes.rows.length) {
        previewResults.push({
          product_id,
          status: "rejected",
          reason: "PRODUCT_NOT_FOUND",
        });
        continue;
      }

      const product = productRes.rows[0];

      // 2️⃣ رصيد مخزن الجملة فقط
      const stockRes = await pool.query(
        `
        SELECT quantity
        FROM stock
        WHERE product_id = $1 AND warehouse_id = $2
        `,
        [product_id, wholesaleWarehouseId],
      );

      const availableQuantity = stockRes.rows.length
        ? Number(stockRes.rows[0].quantity)
        : 0;

      if (availableQuantity < quantity) {
        previewResults.push({
          product_id,
          product_name: product.name,
          status: "rejected",
          reason: "INSUFFICIENT_STOCK",
        });
        continue;
      }

      // 3️⃣ التحويل
      try {
        const result = convertWholesaleToRetail({
          wholesale_package: product.wholesale_package,
          retail_package: product.retail_package,
          wholesale_quantity: quantity,
        });

        previewResults.push({
          product_id,
          product_name: product.name,
          manufacturer: product.manufacturer, // ✅ هنا الحل
          from_quantity: quantity,
          to_quantity: result.retail_quantity,
          status: "ok",
        });
      } catch (err) {
        previewResults.push({
          product_id,
          product_name: product.name,
          status: "rejected",
          reason: err.message || "INVALID_PACKAGE",
        });
      }
    }

    res.json(previewResults);
  } catch (err) {
    console.error("PREVIEW ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/stock/wholesale-to-retail/execute", async (req, res) => {
  const client = await pool.connect();

  try {
    const { from_branch_id, to_branch_id, items, note, created_by } = req.body;

    if (
      !from_branch_id ||
      !to_branch_id ||
      !Array.isArray(items) ||
      items.length === 0
    ) {
      return res.status(400).json({ error: "بيانات ناقصة" });
    }

    await client.query("BEGIN");

    // ✅ مخزن الجملة (المصدر)
    const wholesaleWarehouseId = await getWholesaleWarehouseByBranch(
      from_branch_id,
      client,
    );

    // ✅ مخزن القطاعي (الوجهة)
    const retailWarehouseId = await getWholesaleWarehouseByBranch(
      to_branch_id,
      client,
    );

    // 1️⃣ إنشاء رأس التحويل
    const transferRes = await client.query(
      `
      INSERT INTO stock_transfers (branch_id, created_by, note)
      VALUES ($1, $2, $3)
      RETURNING id
      `,
      [from_branch_id, created_by || null, note || null],
    );

    const transferId = transferRes.rows[0].id;

    const resultItems = [];

    // 2️⃣ تنفيذ العناصر
    for (const item of items) {
      const product_id = Number(item.product_id);
      const quantity = Number(item.quantity);

      if (!product_id || quantity <= 0) {
        throw new Error("INVALID_ITEM_DATA");
      }

      // 🔹 بيانات الصنف
      const productRes = await client.query(
        `
        SELECT id, name, wholesale_package, retail_package
        FROM products
        WHERE id = $1 AND is_active = true
        `,
        [product_id],
      );

      if (!productRes.rows.length) {
        throw new Error(`PRODUCT_NOT_FOUND:${product_id}`);
      }

      const product = productRes.rows[0];

      // 🔹 رصيد الجملة (قفل الصف)
      const stockRes = await client.query(
        `
        SELECT quantity
        FROM stock
        WHERE warehouse_id = $1 AND product_id = $2
        FOR UPDATE
        `,
        [wholesaleWarehouseId, product_id],
      );

      const available = stockRes.rows.length
        ? Number(stockRes.rows[0].quantity)
        : 0;

      if (available < quantity) {
        throw new Error(`INSUFFICIENT_STOCK:${product.name}`);
      }

      // 🔹 التحويل
      const conversion = convertWholesaleToRetail({
        wholesale_package: product.wholesale_package,
        retail_package: product.retail_package,
        wholesale_quantity: quantity,
      });

      // 3️⃣ خصم من الجملة
      await client.query(
        `
        UPDATE stock
        SET quantity = quantity - $1
        WHERE warehouse_id = $2 AND product_id = $3
        `,
        [quantity, wholesaleWarehouseId, product_id],
      );

      // 4️⃣ إضافة للقطاعي
      await client.query(
        `
        INSERT INTO stock (warehouse_id, product_id, quantity)
        VALUES ($1, $2, $3)
        ON CONFLICT (warehouse_id, product_id)
        DO UPDATE SET quantity = stock.quantity + $3
        `,
        [retailWarehouseId, product_id, conversion.retail_quantity],
      );

      // 5️⃣ تفاصيل التحويل
      await client.query(
        `
        INSERT INTO stock_transfer_items
        (
          transfer_id,
          product_id,
          from_warehouse_id,
          to_warehouse_id,
          from_quantity,
          to_quantity,
          total_price
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        `,
        [
          transferId,
          product_id,
          wholesaleWarehouseId,
          retailWarehouseId,
          quantity,
          conversion.retail_quantity,
          item.final_price || 0,
        ],
      );

      // 6️⃣ حركة مخزون (خروج)
      await client.query(
        `
        INSERT INTO stock_movements
        (
          warehouse_id,
          product_id,
          quantity,
          movement_type,
          reference_type,
          reference_id,
          note
        )
        VALUES ($1,$2,$3,'transfer_out','transfer',$4,$5)
        `,
        [
          wholesaleWarehouseId,
          product_id,
          quantity,
          transferId,
          "تحويل من الجملة إلى القطاعي",
        ],
      );

      // 7️⃣ حركة مخزون (دخول)
      await client.query(
        `
        INSERT INTO stock_movements
        (
          warehouse_id,
          product_id,
          quantity,
          movement_type,
          reference_type,
          reference_id,
          note
        )
        VALUES ($1,$2,$3,'transfer_in','transfer',$4,$5)
        `,
        [
          retailWarehouseId,
          product_id,
          conversion.retail_quantity,
          transferId,
          "تحويل من الجملة إلى القطاعي",
        ],
      );

      resultItems.push({
        product_id,
        product_name: product.name,
        from_quantity: quantity,
        to_quantity: conversion.retail_quantity,
      });
    }

    await client.query("COMMIT");

    res.json({
      success: true,
      transfer_id: transferId,
      items: resultItems,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("EXECUTE TRANSFER ERROR:", err);

    res.status(400).json({
      success: false,
      error: err.message,
    });
  } finally {
    client.release();
  }
});

app.get("/stock-transfers", async (req, res) => {
  try {
    const { branch_id, limit = 50, offset = 0 } = req.query;

    let conditions = [];
    let values = [];
    let idx = 1;

    if (branch_id) {
      conditions.push(`st.branch_id = $${idx++}`);
      values.push(branch_id);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const result = await pool.query(
      `
      SELECT
        st.id,
        st.branch_id,
        st.note,
        st.created_at,
        st.status, 
        COUNT(sti.id) AS items_count,
        COALESCE(SUM(sti.from_quantity), 0) AS total_from_quantity
      FROM stock_transfers st
      LEFT JOIN stock_transfer_items sti
        ON sti.transfer_id = st.id
      ${whereClause}
      GROUP BY
       st.id,
       st.branch_id,
       st.note,
       st.created_at,
       st.status
      ORDER BY st.created_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
      `,
      [...values, limit, offset],
    );

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (err) {
    console.error("GET STOCK TRANSFERS ERROR:", err);
    res.status(500).json({ error: "فشل تحميل التحويلات" });
  }
});

app.get("/stock-transfers/summary/by-date", async (req, res) => {
  const { date } = req.query;

  const { rows } = await pool.query(
    `
    SELECT
      COALESCE(SUM(sti.from_quantity), 0) AS total_quantity
    FROM stock_transfer_items sti
    JOIN stock_transfers st ON st.id = sti.transfer_id
    WHERE st.created_at >= ($1::date)
      AND st.created_at <  ($1::date + INTERVAL '1 day')
      AND sti.status = 'active'
     AND st.status = 'active'

    `,
    [date],
  );

  res.json({
    date,
    total_quantity: rows[0].total_quantity,
  });
});

app.get("/stock-transfers/by-date", async (req, res) => {
  const { date } = req.query;

  if (!date) {
    return res.status(400).json({
      error: "date is required (YYYY-MM-DD)",
    });
  }

  try {
    const { rows } = await pool.query(
      `
      SELECT
        sti.id,
        sti.transfer_id,
        sti.product_id,
        p.name            AS product_name,
        p.manufacturer       AS manufacturer,        -- 👈 أضف ده
        p.wholesale_package  AS wholesale_package,   -- 👈 وده
        sti.from_quantity,
        sti.to_quantity,
        sti.total_price,
        fw.name           AS from_warehouse,
        tw.name           AS to_warehouse,
        sti.status,
        st.status         AS transfer_status,
        st.created_at
        
      FROM stock_transfer_items sti
      JOIN stock_transfers st ON st.id = sti.transfer_id
      JOIN products p ON p.id = sti.product_id
      JOIN warehouses fw ON fw.id = sti.from_warehouse_id
      JOIN warehouses tw ON tw.id = sti.to_warehouse_id
      WHERE st.created_at >= ($1::date)
        AND st.created_at <  ($1::date + INTERVAL '1 day')
      ORDER BY st.created_at ASC, sti.id ASC
      `,
      [date],
    );

    res.json({
      date,
      items_count: rows.length,
      items: rows,
    });
  } catch (err) {
    console.error("GET TRANSFERS BY DATE ERROR:", err);
    res.status(500).json({
      error: "Failed to load transfers by date",
    });
  }
});

app.get("/stock-transfers/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // رأس التحويل
    const transferRes = await pool.query(
      `
      SELECT
        id,
        branch_id,
        note,
        status,
        created_at
      FROM stock_transfers
      WHERE id = $1
      `,
      [id],
    );

    if (!transferRes.rows.length) {
      return res.status(404).json({ error: "التحويل غير موجود" });
    }

    // الأصناف
    const itemsRes = await pool.query(
      `
      SELECT
        sti.id,
  sti.product_id,
  sti.status,
  p.name AS product_name,
  sti.from_quantity,
  sti.to_quantity,
  w1.name AS from_warehouse,
  w2.name AS to_warehouse
FROM stock_transfer_items sti
JOIN products p ON p.id = sti.product_id
JOIN warehouses w1 ON w1.id = sti.from_warehouse_id
JOIN warehouses w2 ON w2.id = sti.to_warehouse_id
WHERE sti.transfer_id = $1
      `,
      [id],
    );

    res.json({
      success: true,
      transfer: transferRes.rows[0],
      items: itemsRes.rows,
    });
  } catch (err) {
    console.error("GET STOCK TRANSFER ERROR:", err);
    res.status(500).json({ error: "فشل تحميل تفاصيل التحويل" });
  }
});

app.post("/stock-transfers/:id/cancel", async (req, res) => {
  const client = await pool.connect();

  try {
    const transferId = Number(req.params.id);

    await client.query("BEGIN");

    // 1️⃣ هات التحويل
    const transferRes = await client.query(
      `
      SELECT id, status
      FROM stock_transfers
      WHERE id = $1
      FOR UPDATE
      `,
      [transferId],
    );

    if (!transferRes.rows.length) {
      throw new Error("التحويل غير موجود");
    }

    if (transferRes.rows[0].status === "cancelled") {
      throw new Error("التحويل ملغي بالفعل");
    }

    // 2️⃣ هات الأصناف
    const itemsRes = await client.query(
      `
      SELECT
        product_id,
        from_warehouse_id,
        to_warehouse_id,
        from_quantity,
        to_quantity
      FROM stock_transfer_items
      WHERE transfer_id = $1
      `,
      [transferId],
    );

    if (!itemsRes.rows.length) {
      throw new Error("لا يوجد أصناف للتحويل");
    }

    // 3️⃣ عكس التأثير
    for (const item of itemsRes.rows) {
      // ➕ رجوع للجملة
      await client.query(
        `
        UPDATE stock
        SET quantity = quantity + $1
        WHERE warehouse_id = $2 AND product_id = $3
        `,
        [item.from_quantity, item.from_warehouse_id, item.product_id],
      );

      // ➖ خصم من القطاعي
      const retailStockRes = await client.query(
        `
        SELECT quantity
        FROM stock
        WHERE warehouse_id = $1 AND product_id = $2
        FOR UPDATE
        `,
        [item.to_warehouse_id, item.product_id],
      );

      const available = retailStockRes.rows.length
        ? retailStockRes.rows[0].quantity
        : 0;

      if (available < item.to_quantity) {
        throw new Error(
          `لا يمكن إلغاء التحويل: رصيد القطاعي غير كافي للصنف ${item.product_id}`,
        );
      }

      await client.query(
        `
        UPDATE stock
        SET quantity = quantity - $1
        WHERE warehouse_id = $2 AND product_id = $3
        `,
        [item.to_quantity, item.to_warehouse_id, item.product_id],
      );

      // 🧾 حركة عكسية (دخول الجملة)
      await client.query(
        `
        INSERT INTO stock_movements
        (
          warehouse_id,
          product_id,
          quantity,
          movement_type,
          reference_type,
          reference_id,
          note
        )
        VALUES ($1,$2,$3,'transfer_in','transfer_cancel',$4,$5)
        `,
        [
          item.from_warehouse_id,
          item.product_id,
          item.from_quantity,
          transferId,
          "إلغاء تحويل – رجوع للجملة",
        ],
      );

      // 🧾 حركة عكسية (خروج القطاعي)
      await client.query(
        `
        INSERT INTO stock_movements
        (
          warehouse_id,
          product_id,
          quantity,
          movement_type,
          reference_type,
          reference_id,
          note
        )
        VALUES ($1,$2,$3,'transfer_out','transfer_cancel',$4,$5)
        `,
        [
          item.to_warehouse_id,
          item.product_id,
          item.to_quantity,
          transferId,
          "إلغاء تحويل – خصم من القطاعي",
        ],
      );
    }

    // 4️⃣ تحديث حالة التحويل
    await client.query(
      `
      UPDATE stock_transfers
      SET status = 'cancelled'
      WHERE id = $1
      `,
      [transferId],
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "تم إلغاء التحويل بنجاح",
    });
  } catch (err) {
    await client.query("ROLLBACK");

    console.error("CANCEL TRANSFER ERROR:", err);

    res.status(400).json({
      success: false,
      error: err.message,
    });
  } finally {
    client.release();
  }
});

app.post("/stock-transfers/items/:itemId/cancel", async (req, res) => {
  const client = await pool.connect();

  try {
    const itemId = Number(req.params.itemId);

    if (!itemId) {
      return res.status(400).json({ error: "معرف الصنف غير صحيح" });
    }

    await client.query("BEGIN");

    // 1️⃣ هات الصنف من التحويل
    const itemRes = await client.query(
      `
      SELECT
        sti.id,
        sti.transfer_id,
        sti.product_id,
        sti.from_warehouse_id,
        sti.to_warehouse_id,
        sti.from_quantity,
        sti.to_quantity,
        sti.status
      FROM stock_transfer_items sti
      WHERE sti.id = $1
      FOR UPDATE
      `,
      [itemId],
    );

    if (!itemRes.rows.length) {
      throw new Error("الصنف غير موجود داخل التحويل");
    }

    const item = itemRes.rows[0];

    if (item.status === "cancelled") {
      throw new Error("تم إلغاء هذا الصنف مسبقًا");
    }

    // 2️⃣ تأكد إن رصيد المخزن الهدف يسمح بالعكس
    const targetStockRes = await client.query(
      `
      SELECT quantity
      FROM stock
      WHERE warehouse_id = $1 AND product_id = $2
      FOR UPDATE
      `,
      [item.to_warehouse_id, item.product_id],
    );

    const availableTargetQty = targetStockRes.rows.length
      ? targetStockRes.rows[0].quantity
      : 0;

    if (availableTargetQty < item.to_quantity) {
      throw new Error("لا يمكن إلغاء الصنف: رصيد المخزن المستلم غير كافي");
    }

    // 3️⃣ عكس الكميات

    // ➕ رجوع للمخزن الأصلي
    await client.query(
      `
      UPDATE stock
      SET quantity = quantity + $1
      WHERE warehouse_id = $2 AND product_id = $3
      `,
      [item.from_quantity, item.from_warehouse_id, item.product_id],
    );

    // ➖ خصم من المخزن الهدف
    await client.query(
      `
      UPDATE stock
      SET quantity = quantity - $1
      WHERE warehouse_id = $2 AND product_id = $3
      `,
      [item.to_quantity, item.to_warehouse_id, item.product_id],
    );

    // 4️⃣ تسجيل حركات المخزن (عكسية)

    // دخول للمخزن الأصلي
    await client.query(
      `
      INSERT INTO stock_movements
      (
        warehouse_id,
        product_id,
        quantity,
        movement_type,
        reference_type,
        reference_id,
        note
      )
      VALUES ($1,$2,$3,'transfer_in','transfer_item_cancel',$4,$5)
      `,
      [
        item.from_warehouse_id,
        item.product_id,
        item.from_quantity,
        item.id,
        "إلغاء صنف من تحويل – رجوع للمخزن الأصلي",
      ],
    );

    // خروج من المخزن الهدف
    await client.query(
      `
      INSERT INTO stock_movements
      (
        warehouse_id,
        product_id,
        quantity,
        movement_type,
        reference_type,
        reference_id,
        note
      )
      VALUES ($1,$2,$3,'transfer_out','transfer_item_cancel',$4,$5)
      `,
      [
        item.to_warehouse_id,
        item.product_id,
        item.to_quantity,
        item.id,
        "إلغاء صنف من تحويل – خصم من المخزن المستلم",
      ],
    );

    // 5️⃣ تحديث حالة الصنف
    await client.query(
      `
      UPDATE stock_transfer_items
      SET status = 'cancelled'
      WHERE id = $1
      `,
      [itemId],
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "تم إلغاء الصنف بنجاح",
    });
  } catch (err) {
    await client.query("ROLLBACK");

    console.error("CANCEL TRANSFER ITEM ERROR:", err);

    res.status(400).json({
      success: false,
      error: err.message,
    });
  } finally {
    client.release();
  }
});

app.get("/system/tables", authMiddleware, async (req, res) => {
  res.json([
    { key: "cash_in", label: "وارد" },
    { key: "cash_out", label: "منصرف" },
    { key: "invoice_items", label: "عناصر الفواتير" },
    { key: "invoices", label: "الفواتير" },
    { key: "stock", label: "المخزون" },
    { key: "stock_movements", label: "حركات المخزون" },
    { key: "stock_transfer_items", label: "عناصر التحويلات" },
    { key: "stock_transfers", label: "تحويلات المخزون" },
  ]);
});

app.post("/system/factory-reset", authMiddleware, async (req, res) => {
  const client = await pool.connect();
  const { tables } = req.body;

  if (!Array.isArray(tables) || tables.length === 0) {
    return res.status(400).json({ error: "لم يتم تحديد جداول" });
  }

  // ✅ الجداول المسموح بمسحها فقط
  const allowedTables = [
    "cash_in",
    "cash_out",
    "invoice_items",
    "invoices",
    "stock",
    "stock_movements",
    "stock_transfer_items",
    "stock_transfers",
  ];

  // ✅ فلترة الجداول القادمة من الفرونت
  const safeTables = tables.filter((t) => allowedTables.includes(t));

  if (safeTables.length === 0) {
    return res.status(400).json({ error: "لا توجد جداول صالحة للمسح" });
  }

  try {
    await client.query("BEGIN");

    // 🧹 الفواتير
    if (safeTables.includes("invoice_items")) {
      await client.query("DELETE FROM invoice_items");
    }

    if (safeTables.includes("invoices")) {
      await client.query("DELETE FROM invoices");
    }

    // 🧹 التحويلات
    if (safeTables.includes("stock_transfer_items")) {
      await client.query("DELETE FROM stock_transfer_items");
    }

    if (safeTables.includes("stock_transfers")) {
      await client.query("DELETE FROM stock_transfers");
    }

    // 🧹 المخزون
    if (safeTables.includes("stock_movements")) {
      await client.query("DELETE FROM stock_movements");
    }

    if (safeTables.includes("stock")) {
      // نصفر الكميات بدل ما نحذف السجلات
      await client.query("UPDATE stock SET quantity = 0");
    }

    // 🧹 الخزنة
    if (safeTables.includes("cash_in")) {
      await client.query("DELETE FROM cash_in");
    }

    if (safeTables.includes("cash_out")) {
      await client.query("DELETE FROM cash_out");
    }

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "تم مسح البيانات المحددة بنجاح",
      cleared_tables: safeTables, // 👈 مفيد للفرونت
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("FACTORY RESET ERROR:", err);
    res.status(500).json({ error: "فشل تنفيذ عملية المسح" });
  } finally {
    client.release();
  }
});

const bcrypt = require("bcrypt");

app.post("/users", authMiddleware, async (req, res) => {
  try {
    const { username, password, branch_id } = req.body;

    if (!username || !password || !branch_id) {
      return res.status(400).json({ error: "بيانات ناقصة" });
    }

    const branchIdNum = Number(branch_id);
    if (isNaN(branchIdNum) || branchIdNum <= 0) {
      return res.status(400).json({ error: "branch_id غير صالح" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    await pool.query(
      "INSERT INTO users (username, password, branch_id) VALUES ($1,$2,$3)",
      [username, hashedPassword, branchIdNum],
    );

    res.json({ success: true });
  } catch (err) {
    console.error("CREATE USER ERROR:", err);

    if (err.code === "23505") {
      return res.status(400).json({ error: "اسم المستخدم مستخدم بالفعل" });
    }

    res.status(500).json({ error: "User creation error" });
  }
});

app.put("/users/theme", authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const { theme } = req.body;

  if (!["light", "dark", "system"].includes(theme)) {
    return res.status(400).json({ error: "قيمة ثيم غير صالحة" });
  }

  try {
    await pool.query("UPDATE users SET theme = $1 WHERE id = $2", [
      theme,
      userId,
    ]);

    res.json({ success: true });
  } catch (err) {
    console.error("SAVE THEME ERROR:", err);
    res.status(500).json({ error: "فشل حفظ الثيم" });
  }
});

app.get("/users", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, username, branch_id FROM users ORDER BY id DESC",
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET USERS ERROR:", err);
    res.status(500).json({ error: "فشل تحميل المستخدمين" });
  }
});

/* =========================
   📦 CREATE BACKUP
========================= */
app.post("/system/backup", authMiddleware, async (req, res) => {
  try {
    const backupDir = path.join(__dirname, "backups");
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir);

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupFile = `backup-${timestamp}.sql`;
    const backupPath = path.join(backupDir, backupFile);

    const cmd = `pg_dump "${process.env.DATABASE_URL}?sslmode=require" -f "${backupPath}"`;

    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        console.error("BACKUP ERROR:", stderr);
        return res.status(500).json({ error: "فشل إنشاء النسخة الاحتياطية" });
      }

      res.json({ success: true, file: backupFile });
    });
  } catch (err) {
    console.error("BACKUP CATCH ERROR:", err);
    res.status(500).json({ error: "Backup failed" });
  }
});

/* =========================
   📂 LIST BACKUPS
========================= */
app.get("/system/backups", authMiddleware, (req, res) => {
  try {
    const backupDir = path.join(__dirname, "backups");

    if (!fs.existsSync(backupDir)) {
      return res.json([]);
    }

    const files = fs
      .readdirSync(backupDir)
      .filter((f) => f.endsWith(".sql"))
      .sort(
        (a, b) =>
          fs.statSync(path.join(backupDir, b)).mtimeMs -
          fs.statSync(path.join(backupDir, a)).mtimeMs,
      );

    res.json(files);
  } catch (err) {
    console.error("LIST BACKUPS ERROR:", err);
    res.status(500).json({ error: "فشل تحميل النسخ الاحتياطية" });
  }
});

/* =========================
   ♻️ RESTORE BACKUP
========================= */
app.post("/system/restore", authMiddleware, (req, res) => {
  const { file } = req.body;

  if (!file) return res.status(400).json({ error: "اسم الملف مطلوب" });

  const backupDir = path.join(__dirname, "backups");

  // حماية من path traversal
  const safeFile = path.basename(file);
  const backupPath = path.join(backupDir, safeFile);

  if (!fs.existsSync(backupPath)) {
    return res.status(404).json({ error: "الملف غير موجود" });
  }

  // يمسح الداتا القديمة ويرجع الاستعادة نظيفة
  const cmd = `
  psql -U ${process.env.DB_USER} -h ${process.env.DB_HOST} -p ${process.env.DB_PORT} -d ${process.env.DB_NAME} -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" &&
  psql -U ${process.env.DB_USER} -h ${process.env.DB_HOST} -p ${process.env.DB_PORT} ${process.env.DB_NAME} < "${backupPath}"
  `;

  exec(
    cmd,
    { env: { ...process.env, PGPASSWORD: process.env.DB_PASSWORD } },
    (error) => {
      if (error) {
        console.error("RESTORE ERROR:", error);
        return res.status(500).json({ error: "فشل استعادة النسخة" });
      }

      res.json({ success: true });
    },
  );
});

app.get("/fix-admin", async (req, res) => {
  const bcrypt = require("bcrypt");
  const hash = await bcrypt.hash("123456", 10);

  await pool.query("UPDATE users SET password = $1 WHERE username = 'admin'", [
    hash,
  ]);

  res.send("admin password fixed");
});

/* =========================
   ⬇️ DOWNLOAD BACKUP
========================= */
app.get("/system/backup/download/:file", authMiddleware, (req, res) => {
  const backupDir = path.join(__dirname, "backups");

  // حماية من path traversal
  const safeFile = path.basename(req.params.file);
  const filePath = path.join(backupDir, safeFile);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "الملف غير موجود" });
  }

  res.download(filePath);
});

const jwt = require("jsonwebtoken");

app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    const result = await pool.query(`SELECT * FROM users WHERE username = $1`, [
      username,
    ]);

    if (!result.rows.length) {
      return res.status(400).json({ error: "بيانات الدخول غير صحيحة" });
    }

    const user = result.rows[0];

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(400).json({ error: "بيانات الدخول غير صحيحة" });
    }

    const token = jwt.sign(
      {
        id: user.id,
        branch_id: user.branch_id,
        username: user.username,
      },
      process.env.JWT_SECRET,
      { expiresIn: "7d" },
    );

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        branch_id: user.branch_id,
        theme: user.theme,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Login error" });
  }
});

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader) return res.status(401).json({ error: "Unauthorized" });

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Token غير صالح" });
  }
}

const http = require("http");
const { Server } = require("socket.io");

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" },
});

// نخلي io متاح في أي مكان
app.set("io", io);

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("register_user", async ({ user_id }) => {
    try {
      // 🧠 هات الفرع الحقيقي من الداتابيز
      const result = await pool.query(
        "SELECT branch_id FROM users WHERE id = $1",
        [user_id],
      );

      const branch_id = result.rows[0]?.branch_id;

      if (!branch_id) {
        console.log(`User ${user_id} has no branch_id`);
        return;
      }

      // 🧹 يخرج من أي رومات قديمة
      for (const room of socket.rooms) {
        if (room !== socket.id) socket.leave(room);
      }

      // ✅ يدخل روم الفرع الصح
      socket.join(`branch_${branch_id}`);

      console.log(`User ${user_id} joined ONLY branch_${branch_id}`);
    } catch (err) {
      console.error("Socket register error:", err);
    }
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 3001;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server + Socket running on port ${PORT}`);
});
