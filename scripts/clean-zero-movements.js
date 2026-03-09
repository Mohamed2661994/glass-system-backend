const pool = require("../db");

/**
 * مسح الحركات ذات الكمية صفر وإعادة حساب الأرصدة
 */

async function cleanZeroMovements() {
  try {
    console.log("\n🧹 بدء تنظيف الحركات ذات الكمية صفر...\n");

    // جيب عدد الحركات الصفرية
    const countResult = await pool.query(
      `SELECT COUNT(*) FROM stock_movements WHERE quantity = 0`
    );
    const zeroCount = parseInt(countResult.rows[0].count);

    if (zeroCount === 0) {
      console.log("✅ لا توجد حركات بكمية صفر\n");
      process.exit(0);
    }

    console.log(`⚠️  تم العثور على ${zeroCount} حركة بكمية صفر\n`);
    console.log("هل تريد حذف هذه الحركات؟ (y/n)");

    const readline = require("readline").createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    readline.question("تأكيد (y/n): ", async (answer) => {
      if (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes") {
        console.log("❌ تم إلغاء العملية");
        readline.close();
        process.exit(0);
      }

      console.log("\n🗑️  جاري حذف الحركات الصفرية...");

      // احذف الحركات الصفرية
      const deleteResult = await pool.query(
        `DELETE FROM stock_movements WHERE quantity = 0`
      );

      console.log(`✅ تم حذف ${deleteResult.rowCount} حركة\n`);

      // اعد حساب الأرصدة
      console.log("📊 إعادة حساب جميع الأرصدة...\n");

      // امسح جدول stock
      await pool.query(`TRUNCATE TABLE stock`);
      console.log("✅ تم مسح جدول stock");

      // اعد البناء من stock_movements
      await pool.query(`
        INSERT INTO stock (warehouse_id, product_id, variant_id, quantity, created_at, updated_at)
        SELECT
          warehouse_id,
          product_id,
          COALESCE(variant_id, 0) AS variant_id,
          COALESCE(SUM(
            CASE 
              WHEN movement_type IN ('purchase', 'transfer_in', 'replace_in', 'return_sale')
              THEN quantity
              WHEN movement_type IN ('sale', 'transfer_out', 'replace_out', 'return_purchase')
              THEN -quantity
              ELSE 0
            END
          ), 0) AS quantity,
          NOW() AS created_at,
          NOW() AS updated_at
        FROM stock_movements
        GROUP BY warehouse_id, product_id, variant_id
        HAVING COALESCE(SUM(
          CASE 
            WHEN movement_type IN ('purchase', 'transfer_in', 'replace_in', 'return_sale')
            THEN quantity
            WHEN movement_type IN ('sale', 'transfer_out', 'replace_out', 'return_purchase')
            THEN -quantity
            ELSE 0
          END
        ), 0) != 0
      `);

      console.log("✅ تم إعادة بناء جدول stock من الحركات\n");

      // احسب الإحصائيات
      const statsResult = await pool.query(`
        SELECT COUNT(*) AS total_items,
               SUM(CASE WHEN quantity > 0 THEN 1 ELSE 0 END) AS positive,
               SUM(CASE WHEN quantity < 0 THEN 1 ELSE 0 END) AS negative,
               SUM(CASE WHEN quantity = 0 THEN 1 ELSE 0 END) AS zero
        FROM stock
      `);

      const stats = statsResult.rows[0];
      console.log("📊 الإحصائيات النهائية:");
      console.log(`   - إجمالي السجلات: ${stats.total_items}`);
      console.log(`   - رصيد موجب: ${stats.positive}`);
      console.log(`   - رصيد سالب: ${stats.negative} ⚠️`);
      console.log(`   - رصيد صفر: ${stats.zero}\n`);

      if (parseInt(stats.negative) > 0) {
        console.log("⚠️  هناك أصناف برصيد سالب - قد تحتاج لمراجعة الحركات\n");
      }

      console.log("🎉 انتهى التنظيف بنجاح!\n");

      readline.close();
      process.exit(0);
    });
  } catch (err) {
    console.error("❌ خطأ:", err);
    process.exit(1);
  }
}

cleanZeroMovements();
