const { localPool, cloudPool } = require('../db');

async function migratePool(pool, poolName) {
  console.log(`\n🚀 Starting migration on ${poolName}...`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. تحديث تفاصيل الفواتير: أي سطر في فاتورة قطاعي نرجعه للكود الأساسي (0)
    const res1 = await client.query(`
      UPDATE invoice_items
      SET variant_id = 0
      FROM invoices
      WHERE invoice_items.invoice_id = invoices.id
        AND invoices.invoice_type = 'retail'
        AND invoice_items.variant_id > 0
    `);
    console.log(`✅ [${poolName}] Updated ${res1.rowCount} retail invoice_items to variant_id = 0`);

    // 2. تحديث حركة المخزون: أي حركة تمت على مخزن القطاعي (1) نرجعها للكود الأساسي (0)
    const res2 = await client.query(`
      UPDATE stock_movements
      SET variant_id = 0
      WHERE warehouse_id = 1 AND variant_id > 0
    `);
    console.log(`✅ [${poolName}] Updated ${res2.rowCount} stock_movements in retail warehouse back to variant_id = 0`);

    // 3. دمج أرصدة المخزن: إضافة الكميات الموجودة في الأكواد الفرعية إلى الكود الأساسي (0) داخل القطاعي
    const res3 = await client.query(`
      INSERT INTO stock (warehouse_id, product_id, variant_id, quantity)
      SELECT warehouse_id, product_id, 0 as variant_id, SUM(quantity) as quantity
      FROM stock
      WHERE warehouse_id = 1 AND variant_id > 0
      GROUP BY warehouse_id, product_id
      ON CONFLICT (warehouse_id, product_id, variant_id)
      DO UPDATE SET quantity = stock.quantity + EXCLUDED.quantity
    `);
    console.log(`✅ [${poolName}] Consolidated ${res3.rowCount} product stocks to variant_id = 0`);

    // 4. حذف سجلات الأكواد الفرعية نهائياً من مخزن القطاعي بعد ما نقلنا رصيدها
    const res4 = await client.query(`
      DELETE FROM stock
      WHERE warehouse_id = 1 AND variant_id > 0
    `);
    console.log(`✅ [${poolName}] Deleted ${res4.rowCount} deprecated variant stock records in retail warehouse`);

    await client.query('COMMIT');
    console.log(`🎉 [${poolName}] Migration completed successfully!`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`❌ [${poolName}] Migration failed:`, err);
  } finally {
    client.release();
  }
}

async function run() {
  await migratePool(localPool, 'LOCAL_DB');
  // يمكن تشغيلها على السحابي فوراً لضمان عدم حدوث تعارض من المزامنة
  await migratePool(cloudPool, 'CLOUD_DB');
  process.exit(0);
}

run();
