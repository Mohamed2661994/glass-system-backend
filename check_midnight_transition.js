const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgresql://glass_backend:SecGlass_2026_Postgres_HA@dbstudio.hg-alshour.online:5432/glass_system'
});

async function check() {
  const timeRes = await pool.query(`
    SELECT 
      NOW() as now_raw,
      CURRENT_DATE as current_date_raw,
      (NOW() AT TIME ZONE 'Africa/Cairo')::date as cairo_date,
      (NOW() AT TIME ZONE 'UTC')::date as utc_date
  `);
  console.log("=== TIME / DATE DEBUG ===");
  console.log(timeRes.rows[0]);

  // Check 08-09-2026
  const inv08 = await pool.query(`
    SELECT count(*), COALESCE(sum(total), 0) as total 
    FROM invoices 
    WHERE invoice_date = '2026-09-08'
  `);
  console.log("\n=== Invoices on 2026-09-08 ===");
  console.log(`Count: ${inv08.rows[0].count}, Total: ${inv08.rows[0].total}`);

  // Check 09-09-2026
  const inv09 = await pool.query(`
    SELECT count(*), COALESCE(sum(total), 0) as total 
    FROM invoices 
    WHERE invoice_date = '2026-09-09'
  `);
  console.log("\n=== Invoices on 2026-09-09 (Today) ===");
  console.log(`Count: ${inv09.rows[0].count}, Total: ${inv09.rows[0].total}`);

  // Total Invoices in DB
  const invAll = await pool.query(`SELECT count(*), max(id) FROM invoices`);
  console.log(`\n=== Total Invoices in DB ===`);
  console.log(`Total Count: ${invAll.rows[0].count}, Max ID: ${invAll.rows[0].max}`);

  // Check Cash In/Out on 08 vs 09
  const cin08 = await pool.query(`SELECT count(*), sum(amount) FROM cash_in WHERE transaction_date = '2026-09-08'`);
  const cout08 = await pool.query(`SELECT count(*), sum(amount) FROM cash_out WHERE transaction_date = '2026-09-08'`);
  console.log("\n=== Cash on 2026-09-08 ===");
  console.log(`Cash In: ${cin08.rows[0].count} items (${cin08.rows[0].sum} EGP), Cash Out: ${cout08.rows[0].count} items (${cout08.rows[0].sum} EGP)`);

  const cin09 = await pool.query(`SELECT count(*), sum(amount) FROM cash_in WHERE transaction_date = '2026-09-09'`);
  const cout09 = await pool.query(`SELECT count(*), sum(amount) FROM cash_out WHERE transaction_date = '2026-09-09'`);
  console.log("\n=== Cash on 2026-09-09 (Today) ===");
  console.log(`Cash In: ${cin09.rows[0].count} items (${cin09.rows[0].sum || 0} EGP), Cash Out: ${cout09.rows[0].count} items (${cout09.rows[0].sum || 0} EGP)`);

  await pool.end();
}

check().catch(console.error);
