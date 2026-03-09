const pool = require("../db");

/**
 * ف حص فاتورة ومنتجاتها
 */

async function checkInvoiceProducts() {
  const invoiceId = 389;

  try {
    console.log(`\n🔍 فحص الفاتورة #${invoiceId}\n`);

    // جيب معلومات الفاتورة
    const invoiceResult = await pool.query(
      `SELECT * FROM invoices WHERE id = $1`,
      [invoiceId]
    );

    if (invoiceResult.rows.length === 0) {
      console.log(`❌ الفاتورة #${invoiceId} غير موجودة`);
      process.exit(1);
    }

    const invoice = invoiceResult.rows[0];
    console.log(`📄 الفاتورة #${invoiceId}`);
    console.log(`   النوع: ${invoice.invoice_type}`);
    console.log(`   الحركة: ${invoice.movement_type}`);
    console.log(`   العميل: ${invoice.customer_name || "—"}`);
    console.log(`   التاريخ: ${new Date(invoice.created_at).toLocaleDateString("ar-EG")}`);
    console.log("");

    // جيب المنتجات في الفاتورة
    const itemsResult = await pool.query(
      `
      SELECT
        ii.product_id,
        p.name AS product_name,
        ii.quantity,
        ii.package
      FROM invoice_items ii
      JOIN products p ON p.id = ii.product_id
      WHERE ii.invoice_id = $1
      `,
      [invoiceId]
    );

    console.log(`📦 المنتجات في الفاتورة:\n`);
    itemsResult.rows.forEach((item, idx) => {
      console.log(`${idx + 1}. ${item.product_name} (ID: ${item.product_id})`);
      console.log(`   الكمية: ${item.quantity}`);
      console.log(`   العبوة: ${item.package || "—"}`);
      console.log("");
    });

    process.exit(0);
  } catch (err) {
    console.error("❌ خطأ:", err);
    process.exit(1);
  }
}

checkInvoiceProducts();
