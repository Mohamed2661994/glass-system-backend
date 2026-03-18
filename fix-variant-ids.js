/**
 * سكريبت تصحيح variant_id في البيانات القديمة.
 *
 * الاستخدام:
 *   node fix-variant-ids.js        -> معاينة ثم تأكيد يدوي
 *   node fix-variant-ids.js --yes  -> تنفيذ مباشر
 */

const readline = require("readline");
const pool = require("./db");

const AUTO_CONFIRM = process.argv.includes("--yes");

const FIXABLE_ITEMS_CTE = `
WITH variant_packages AS (
  SELECT product_id, TRIM(wholesale_package) AS package_name, id AS expected_variant_id
  FROM product_variants
  WHERE TRIM(COALESCE(wholesale_package, '')) <> ''

  UNION ALL

  SELECT product_id, TRIM(retail_package) AS package_name, id AS expected_variant_id
  FROM product_variants
  WHERE TRIM(COALESCE(retail_package, '')) <> ''
),
unique_variant_packages AS (
  SELECT product_id, package_name, MIN(expected_variant_id) AS expected_variant_id
  FROM variant_packages
  GROUP BY product_id, package_name
  HAVING COUNT(DISTINCT expected_variant_id) = 1
),
variant_invoice_items AS (
  SELECT
    ii.id AS invoice_item_id,
    ii.invoice_id,
    ii.product_id,
    p.name AS product_name,
    TRIM(COALESCE(ii.package, '')) AS package_name,
    ii.quantity,
    COALESCE(ii.variant_id, 0) AS invoice_item_variant_id,
    unique_variant_packages.expected_variant_id,
    ROW_NUMBER() OVER (
      PARTITION BY ii.invoice_id, ii.product_id
      ORDER BY ii.id
    ) AS row_num
  FROM invoice_items ii
  JOIN products p ON p.id = ii.product_id
  JOIN unique_variant_packages
    ON unique_variant_packages.product_id = ii.product_id
   AND unique_variant_packages.package_name = TRIM(COALESCE(ii.package, ''))
),
candidate_movements AS (
  SELECT
    sm.id AS stock_movement_id,
    sm.invoice_id,
    sm.product_id,
    sm.quantity,
    COALESCE(sm.variant_id, 0) AS movement_variant_id,
    ROW_NUMBER() OVER (
      PARTITION BY sm.invoice_id, sm.product_id
      ORDER BY sm.id
    ) AS row_num
  FROM stock_movements sm
),
fix_targets AS (
  SELECT
    vii.invoice_item_id,
    cm.stock_movement_id,
    vii.invoice_id,
    vii.product_id,
    vii.product_name,
    vii.package_name,
    vii.quantity,
    vii.invoice_item_variant_id,
    COALESCE(cm.movement_variant_id, 0) AS movement_variant_id,
    vii.expected_variant_id
  FROM variant_invoice_items vii
  LEFT JOIN candidate_movements cm
    ON cm.invoice_id = vii.invoice_id
   AND cm.product_id = vii.product_id
   AND cm.row_num = vii.row_num
  WHERE vii.invoice_item_variant_id <> vii.expected_variant_id
     OR COALESCE(cm.movement_variant_id, 0) <> vii.expected_variant_id
)
`;

function askForConfirmation() {
  if (AUTO_CONFIRM) return Promise.resolve(true);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question("\n⚠️  هل تريد تنفيذ التصحيحات؟ (yes/no): ", (answer) => {
      rl.close();
      resolve(String(answer || "").trim().toLowerCase() === "yes");
    });
  });
}

async function fixVariantIds() {
  const client = await pool.connect();

  try {
    console.log("🔍 جاري البحث عن السجلات التي تحتاج تصحيح...\n");

    const previewResult = await client.query(`
      ${FIXABLE_ITEMS_CTE}
      SELECT
        invoice_item_id,
        stock_movement_id,
        invoice_id,
        product_id,
        product_name,
        package_name,
        quantity,
        invoice_item_variant_id,
        movement_variant_id,
        expected_variant_id
      FROM fix_targets
      ORDER BY invoice_id, invoice_item_id
    `);

    const fixes = previewResult.rows;

    if (fixes.length === 0) {
      console.log("✅ لا توجد سجلات تحتاج تصحيح!");
      return;
    }

    const unmatchedMovements = fixes.filter((row) => !row.stock_movement_id);
    if (unmatchedMovements.length > 0) {
      console.error("❌ تم إيقاف التنفيذ لأن بعض السجلات لم يتم ربطها بحركة مخزون مطابقة.");
      console.table(unmatchedMovements.slice(0, 20));
      throw new Error("Unmatched stock_movements detected");
    }

    const productSummaryMap = new Map();
    for (const fix of fixes) {
      const key = `${fix.product_id}`;
      if (!productSummaryMap.has(key)) {
        productSummaryMap.set(key, {
          product_id: fix.product_id,
          product_name: fix.product_name,
          rows: 0,
          total_quantity: 0,
        });
      }
      const entry = productSummaryMap.get(key);
      entry.rows += 1;
      entry.total_quantity += Number(fix.quantity || 0);
    }

    console.log(`📝 عدد السجلات التي تحتاج تصحيح: ${fixes.length}`);
    console.log(`📦 عدد الأصناف المتأثرة: ${productSummaryMap.size}\n`);
    console.table(Array.from(productSummaryMap.values()));
    console.log("\nعينة من السجلات:");
    console.table(
      fixes.slice(0, 20).map((row) => ({
        invoice_id: row.invoice_id,
        product_id: row.product_id,
        product_name: row.product_name,
        package_name: row.package_name,
        quantity: row.quantity,
        invoice_item_variant_id: row.invoice_item_variant_id,
        movement_variant_id: row.movement_variant_id,
        expected_variant_id: row.expected_variant_id,
      })),
    );

    const confirmed = await askForConfirmation();
    if (!confirmed) {
      console.log("❌ تم الإلغاء");
      return;
    }

    console.log("\n🔧 جاري تنفيذ التصحيحات...\n");

    await client.query("BEGIN");

    const invoiceItemsUpdate = await client.query(`
      ${FIXABLE_ITEMS_CTE}
      UPDATE invoice_items ii
      SET variant_id = fix_targets.expected_variant_id
      FROM fix_targets
      WHERE ii.id = fix_targets.invoice_item_id
        AND fix_targets.invoice_item_variant_id <> fix_targets.expected_variant_id
    `);

    const stockMovementsUpdate = await client.query(`
      ${FIXABLE_ITEMS_CTE}
      UPDATE stock_movements sm
      SET variant_id = fix_targets.expected_variant_id
      FROM fix_targets
      WHERE sm.id = fix_targets.stock_movement_id
        AND fix_targets.movement_variant_id <> fix_targets.expected_variant_id
    `);

    const affectedProductIds = Array.from(productSummaryMap.values()).map((row) =>
      Number(row.product_id),
    );

    await client.query(`DELETE FROM stock WHERE product_id = ANY($1::int[])`, [
      affectedProductIds,
    ]);

    await client.query(
      `
      INSERT INTO stock (warehouse_id, product_id, variant_id, quantity)
      SELECT
        sm.warehouse_id,
        sm.product_id,
        COALESCE(sm.variant_id, 0) AS variant_id,
        SUM(
          CASE
            WHEN sm.movement_type IN ('purchase', 'transfer_in', 'replace_in', 'return_sale') THEN sm.quantity
            WHEN sm.movement_type IN ('sale', 'transfer_out', 'replace_out', 'return_purchase') THEN -sm.quantity
            ELSE 0
          END
        ) AS quantity
      FROM stock_movements sm
      WHERE sm.product_id = ANY($1::int[])
      GROUP BY sm.warehouse_id, sm.product_id, COALESCE(sm.variant_id, 0)
      `,
      [affectedProductIds],
    );

    await client.query("COMMIT");

    console.log(`✅ تم تحديث invoice_items: ${invoiceItemsUpdate.rowCount}`);
    console.log(`✅ تم تحديث stock_movements: ${stockMovementsUpdate.rowCount}`);
    console.log(`✅ تم إعادة بناء stock لـ ${affectedProductIds.length} صنف`);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ خطأ:", err.message);
    throw err;
  } finally {
    client.release();
  }
}

fixVariantIds()
  .then(() => {
    console.log("\n🏁 انتهى السكريبت");
    process.exit(0);
  })
  .catch((err) => {
    console.error("\n❌ فشل السكريبت:", err.message);
    process.exit(1);
  });
