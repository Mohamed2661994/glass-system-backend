const pool = require("../db");

/**
 * فحص حركات صنف معين
 */

async function checkProductMovements() {
  const productName = "اية 50"; // اسم الصنف (بدون همزة)

  try {
    console.log(`\n🔍 فحص حركات الصنف: "${productName}"\n`);

    // جيب معلومات الصنف
    const productResult = await pool.query(
      `SELECT id, name, manufacturer FROM products WHERE name ILIKE $1 LIMIT 5`,
      [`%${productName}%`]
    );

    if (productResult.rows.length === 0) {
      console.log(`❌ الصنف "${productName}" غير موجود`);
      console.log(`\nجاري البحث عن أصناف مشابهة...`);
      const similarResult = await pool.query(
        `SELECT id, name FROM products WHERE name ILIKE $1 LIMIT 10`,
        [`%أية%`]
      );
      if (similarResult.rows.length > 0) {
        console.log(`\nأصناف مشابهة:`);
        similarResult.rows.forEach(p => {
          console.log(`  - ${p.name} (ID: ${p.id})`);
        });
      }
      process.exit(1);
    }

    if (productResult.rows.length > 1) {
      console.log(`⚠️  تم العثور على ${productResult.rows.length} أصناف متشابهة:\n`);
      productResult.rows.forEach((p, idx) => {
        console.log(`  ${idx + 1}. ${p.name} (ID: ${p.id})`);
      });
      console.log(`\nسيتم فحص الصنف الأول...\n`);
    }

    const product = productResult.rows[0];
    console.log(`📦 الصنف: ${product.name} (ID: ${product.id})`);
    if (product.manufacturer) {
      console.log(`🏭 المصنع: ${product.manufacturer}`);
    }
    console.log("");

    // جيب كل الحركات
    const movementsResult = await pool.query(
      `
      SELECT
        sm.created_at,
        sm.movement_type,
        sm.quantity,
        sm.warehouse_id,
        w.name AS warehouse_name,
        sm.invoice_id,
        i.customer_name,
        sm.note
      FROM stock_movements sm
      LEFT JOIN warehouses w ON w.id = sm.warehouse_id
      LEFT JOIN invoices i ON i.id = sm.invoice_id
      WHERE sm.product_id = $1
      ORDER BY sm.created_at ASC
      `,
      [product.id]
    );

    const movements = movementsResult.rows;

    if (movements.length === 0) {
      console.log("⚠️  لا توجد حركات لهذا الصنف\n");
      process.exit(0);
    }

    console.log(`📊 عدد الحركات: ${movements.length}\n`);
    console.log("=" .repeat(120));

    let totalIn = 0;
    let totalOut = 0;

    movements.forEach((m, idx) => {
      const date = new Date(m.created_at).toLocaleDateString("ar-EG", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });

      // تصنيف الحركة
      const isIn = [
        "purchase",
        "transfer_in",
        "replace_in",
        "return_sale",
      ].includes(m.movement_type);

      const typeLabel = {
        purchase: "شراء (وارد)",
        sale: "بيع (صادر)",
        transfer_in: "تحويل وارد",
        transfer_out: "تحويل صادر",
        replace_in: "استبدال وارد",
        replace_out: "استبدال صادر",
        return_sale: "مرتجع بيع (وارد)",
        return_purchase: "مرتجع شراء (صادر)",
      }[m.movement_type] || m.movement_type;

      const arrow = isIn ? "⬅️  " : "➡️  ";
      const color = isIn ? "+" : "-";

      if (isIn) {
        totalIn += Number(m.quantity);
      } else {
        totalOut += Number(m.quantity);
      }

      console.log(
        `${idx + 1}. ${date} | ${arrow}${typeLabel.padEnd(20)} | ${color}${m.quantity} | ${m.warehouse_name || "—"} | ${m.customer_name || m.note || "—"}`
      );
    });

    console.log("=" .repeat(120));
    console.log("");
    console.log(`✅ إجمالي الوارد: ${totalIn}`);
    console.log(`❌ إجمالي الصادر: ${totalOut}`);
    console.log(`📊 الرصيد الفعلي: ${totalIn - totalOut}`);
    console.log("");

    // جيب الرصيد من جدول stock
    const stockResult = await pool.query(
      `SELECT w.name AS warehouse_name, s.quantity
       FROM stock s
       JOIN warehouses w ON w.id = s.warehouse_id
       WHERE s.product_id = $1`,
      [product.id]
    );

    console.log("📋 الرصيد في جدول stock:");
    if (stockResult.rows.length === 0) {
      console.log("   (لا يوجد)");
    } else {
      stockResult.rows.forEach((row) => {
        console.log(`   - ${row.warehouse_name}: ${row.quantity}`);
      });
    }
    console.log("");

    process.exit(0);
  } catch (err) {
    console.error("❌ خطأ:", err);
    process.exit(1);
  }
}

checkProductMovements();
