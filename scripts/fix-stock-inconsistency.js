const pool = require("../db");

/**
 * إصلاح تضارب البيانات بين جدول stock و stock_movements
 * - يحسب الرصيد الفعلي من حركات المخزون
 * - يطابقه مع جدول stock
 - يصلح أي فروقات
 */

async function fixStockInconsistency() {
  console.log("🔧 بدء إصلاح تضارب أرصدة المخزون...\n");

  try {
    // 1. احسب الرصيد الفعلي من stock_movements
    console.log("📊 حساب الأرصدة الفعلية من حركات المخزون...");
    
    const actualStockResult = await pool.query(`
      SELECT
        sm.warehouse_id,
        sm.product_id,
        COALESCE(sm.variant_id, 0) AS variant_id,
        
        -- حساب الرصيد الفعلي
        COALESCE(SUM(
          CASE 
            WHEN sm.movement_type IN ('purchase', 'transfer_in', 'replace_in', 'return_sale')
            THEN sm.quantity
            WHEN sm.movement_type IN ('sale', 'transfer_out', 'replace_out', 'return_purchase')
            THEN -sm.quantity
            ELSE 0
          END
        ), 0) AS actual_quantity
        
      FROM stock_movements sm
      GROUP BY sm.warehouse_id, sm.product_id, sm.variant_id
      HAVING COALESCE(SUM(
        CASE 
          WHEN sm.movement_type IN ('purchase', 'transfer_in', 'replace_in', 'return_sale')
          THEN sm.quantity
          WHEN sm.movement_type IN ('sale', 'transfer_out', 'replace_out', 'return_purchase')
          THEN -sm.quantity
          ELSE 0
        END
      ), 0) != 0
    `);

    const actualStock = actualStockResult.rows;
    console.log(`✅ تم حساب ${actualStock.length} سجل من الأرصدة الفعلية\n`);

    // 2. جيب الأرصدة الحالية من stock
    console.log("📋 جلب الأرصدة الحالية من جدول stock...");
    const currentStockResult = await pool.query(`
      SELECT warehouse_id, product_id, COALESCE(variant_id, 0) AS variant_id, quantity
      FROM stock
    `);

    const currentStockMap = new Map();
    currentStockResult.rows.forEach((row) => {
      const key = `${row.warehouse_id}-${row.product_id}-${row.variant_id}`;
      currentStockMap.set(key, Number(row.quantity));
    });

    console.log(`✅ تم جلب ${currentStockResult.rows.length} سجل من جدول stock\n`);

    // 3. ابحث عن الفروقات
    console.log("🔍 مقارنة الأرصدة...\n");
    let fixedCount = 0;
    let inconsistencies = [];

    for (const actual of actualStock) {
      const key = `${actual.warehouse_id}-${actual.product_id}-${actual.variant_id}`;
      const currentQty = currentStockMap.get(key) || 0;
      const actualQty = Number(actual.actual_quantity);

      if (currentQty !== actualQty) {
        inconsistencies.push({
          warehouse_id: actual.warehouse_id,
          product_id: actual.product_id,
          variant_id: actual.variant_id,
          current: currentQty,
          actual: actualQty,
          diff: actualQty - currentQty,
        });

        // احصل على اسم المنتج و المخزن
        const infoResult = await pool.query(
          `
          SELECT p.name AS product_name, w.name AS warehouse_name
          FROM products p, warehouses w
          WHERE p.id = $1 AND w.id = $2
          `,
          [actual.product_id, actual.warehouse_id]
        );

        const info = infoResult.rows[0] || { product_name: "غير معروف", warehouse_name: "غير معروف" };

        console.log(
          `⚠️  [${info.warehouse_name}] ${info.product_name} (ID: ${actual.product_id}):\n` +
          `   - الرصيد الحالي في stock: ${currentQty}\n` +
          `   - الرصيد الفعلي من الحركات: ${actualQty}\n` +
          `   - الفرق: ${actualQty - currentQty}\n`
        );
      }
    }

    if (inconsistencies.length === 0) {
      console.log("✅ لا توجد فروقات! جميع الأرصدة متطابقة.\n");
      return;
    }

    console.log(`\n📊 إجمالي الفروقات: ${inconsistencies.length} سجل\n`);

    // 4. اسأل المستخدم عن التأكيد
    console.log("⚠️  هل تريد تصحيح هذه الفروقات؟ (y/n)");
    console.log("⚠️  سيتم تحديث جدول stock ليطابق الأرصدة الفعلية من stock_movements\n");

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

      console.log("\n🔄 بدء تصحيح الأرصدة...\n");

      // 5. صحح الفروقات
      for (const item of inconsistencies) {
        try {
          // تحقق من وجود السجل في stock
          const existsResult = await pool.query(
            `SELECT 1 FROM stock 
             WHERE warehouse_id = $1 AND product_id = $2 AND COALESCE(variant_id, 0) = $3`,
            [item.warehouse_id, item.product_id, item.variant_id]
          );

          if (existsResult.rows.length > 0) {
            // تحديث الرصيد الموجود
            await pool.query(
              `UPDATE stock 
               SET quantity = $1, updated_at = NOW()
               WHERE warehouse_id = $2 AND product_id = $3 AND COALESCE(variant_id, 0) = $4`,
              [item.actual, item.warehouse_id, item.product_id, item.variant_id]
            );
          } else {
            // إضافة سجل جديد
            await pool.query(
              `INSERT INTO stock (warehouse_id, product_id, variant_id, quantity, created_at, updated_at)
               VALUES ($1, $2, $3, $4, NOW(), NOW())`,
              [item.warehouse_id, item.product_id, item.variant_id || null, item.actual]
            );
          }

          fixedCount++;
          console.log(`✅ تم تصحيح: المخزن ${item.warehouse_id} - الصنف ${item.product_id}`);
        } catch (err) {
          console.error(`❌ خطأ في تصحيح الصنف ${item.product_id}:`, err.message);
        }
      }

      console.log(`\n✅ تم تصحيح ${fixedCount} من ${inconsistencies.length} سجل بنجاح!\n`);
      console.log("🎉 انتهى إصلاح تضارب الأرصدة\n");

      readline.close();
      process.exit(0);
    });

  } catch (err) {
    console.error("❌ خطأ في العملية:", err);
    process.exit(1);
  }
}

// تشغيل السكريبت
fixStockInconsistency();
