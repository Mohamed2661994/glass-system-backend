/**
 * سكريبت تصحيح variant_id في البيانات القديمة
 *
 * المشكلة: بعض الفواتير تم حفظها بـ variant_id = 0 رغم أن العبوة المستخدمة
 * هي عبوة فرعية (variant). هذا السكريبت يصحح هذه البيانات.
 *
 * الخطوات:
 * 1. البحث عن invoice_items حيث variant_id = 0 لكن package يطابق variant
 * 2. تحديث variant_id في invoice_items
 * 3. تحديث variant_id في stock_movements
 * 4. إعادة حساب جدول stock
 */

const pool = require("./db");

async function fixVariantIds() {
  const client = await pool.connect();

  try {
    console.log("🔍 جاري البحث عن السجلات التي تحتاج تصحيح...\n");

    // 1. جلب كل العبوات الفرعية
    const variantsRes = await client.query(`
      SELECT id, product_id, wholesale_package, retail_package
      FROM product_variants
    `);

    // بناء خريطة: product_id + package -> variant_id
    const variantMap = new Map();
    for (const v of variantsRes.rows) {
      if (v.wholesale_package) {
        variantMap.set(`${v.product_id}_${v.wholesale_package.trim()}`, v.id);
      }
      if (v.retail_package) {
        variantMap.set(`${v.product_id}_${v.retail_package.trim()}`, v.id);
      }
    }

    console.log(`📦 عدد العبوات الفرعية: ${variantsRes.rows.length}`);
    console.log(`🗺️  خريطة العبوات: ${variantMap.size} عنصر\n`);

    // 2. البحث عن invoice_items التي تحتاج تصحيح
    const itemsToFix = await client.query(`
      SELECT ii.id, ii.invoice_id, ii.product_id, ii.package, ii.variant_id,
             p.name as product_name
      FROM invoice_items ii
      JOIN products p ON p.id = ii.product_id
      WHERE ii.variant_id = 0 OR ii.variant_id IS NULL
      ORDER BY ii.invoice_id
    `);

    console.log(`🔎 عدد السجلات للفحص: ${itemsToFix.rows.length}\n`);

    let fixedCount = 0;
    const fixes = [];

    for (const item of itemsToFix.rows) {
      const pkg = (item.package || "").trim();
      const key = `${item.product_id}_${pkg}`;
      const correctVariantId = variantMap.get(key);

      if (correctVariantId && correctVariantId !== item.variant_id) {
        fixes.push({
          invoice_item_id: item.id,
          invoice_id: item.invoice_id,
          product_id: item.product_id,
          product_name: item.product_name,
          package: pkg,
          old_variant_id: item.variant_id || 0,
          new_variant_id: correctVariantId,
        });
        fixedCount++;
      }
    }

    if (fixes.length === 0) {
      console.log("✅ لا توجد سجلات تحتاج تصحيح!");
      return;
    }

    console.log(`📝 عدد السجلات التي تحتاج تصحيح: ${fixes.length}\n`);
    console.log("التفاصيل:");
    console.table(fixes.slice(0, 20)); // عرض أول 20 فقط
    if (fixes.length > 20) {
      console.log(`... و ${fixes.length - 20} سجل آخر\n`);
    }

    // السؤال قبل التنفيذ
    const readline = require("readline");
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const answer = await new Promise((resolve) => {
      rl.question("\n⚠️  هل تريد تنفيذ التصحيحات؟ (yes/no): ", resolve);
    });
    rl.close();

    if (answer.toLowerCase() !== "yes") {
      console.log("❌ تم الإلغاء");
      return;
    }

    console.log("\n🔧 جاري تنفيذ التصحيحات...\n");

    await client.query("BEGIN");

    for (const fix of fixes) {
      // 1. تحديث invoice_items
      await client.query(
        `UPDATE invoice_items SET variant_id = $1 WHERE id = $2`,
        [fix.new_variant_id, fix.invoice_item_id],
      );

      // 2. تحديث stock_movements
      await client.query(
        `UPDATE stock_movements 
         SET variant_id = $1 
         WHERE invoice_id = $2 AND product_id = $3 AND variant_id = $4`,
        [
          fix.new_variant_id,
          fix.invoice_id,
          fix.product_id,
          fix.old_variant_id,
        ],
      );

      console.log(
        `✅ فاتورة #${fix.invoice_id} - ${fix.product_name} - ${fix.package}: ${fix.old_variant_id} → ${fix.new_variant_id}`,
      );
    }

    // 3. إعادة حساب جدول stock
    console.log("\n🔄 جاري إعادة حساب المخزون...");

    // الحصول على الأصناف المتأثرة
    const affectedProducts = [...new Set(fixes.map((f) => f.product_id))];

    for (const productId of affectedProducts) {
      // إعادة حساب stock من stock_movements
      await client.query(
        `
        INSERT INTO stock (warehouse_id, product_id, variant_id, quantity)
        SELECT 
          sm.warehouse_id,
          sm.product_id,
          sm.variant_id,
          SUM(CASE 
            WHEN sm.movement_type IN ('purchase', 'transfer_in', 'replace_in', 'return_sale') THEN sm.quantity
            WHEN sm.movement_type IN ('sale', 'transfer_out', 'replace_out', 'return_purchase') THEN -sm.quantity
            ELSE 0
          END) as quantity
        FROM stock_movements sm
        WHERE sm.product_id = $1
        GROUP BY sm.warehouse_id, sm.product_id, sm.variant_id
        ON CONFLICT (warehouse_id, product_id, variant_id)
        DO UPDATE SET quantity = EXCLUDED.quantity
      `,
        [productId],
      );
    }

    await client.query("COMMIT");

    console.log(`\n✅ تم تصحيح ${fixes.length} سجل بنجاح!`);
    console.log(`✅ تم إعادة حساب المخزون لـ ${affectedProducts.length} صنف`);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ خطأ:", err.message);
    throw err;
  } finally {
    client.release();
  }
}

// تشغيل السكريبت
fixVariantIds()
  .then(() => {
    console.log("\n🏁 انتهى السكريبت");
    process.exit(0);
  })
  .catch((err) => {
    console.error("\n❌ فشل السكريبت:", err.message);
    process.exit(1);
  });
