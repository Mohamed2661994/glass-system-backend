const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgresql://glass_backend:SecGlass_2026_Postgres_HA@dbstudio.hg-alshour.online:5432/glass_system'
});

pool.on('connect', (client) => {
  client.query("SET timezone = 'Africa/Cairo'");
});

async function testAppQueries() {
  console.log("Testing core application queries against Data Studio DB...");
  const inv = await pool.query('SELECT id, invoice_number, total FROM invoices ORDER BY id DESC LIMIT 3');
  console.log('✅ Recent Invoices:', inv.rows);

  const st = await pool.query('SELECT COUNT(*) FROM stock WHERE quantity > 0');
  console.log('✅ Active Stock Items with Qty > 0:', st.rows[0].count);

  const c = await pool.query('SELECT COUNT(*) FROM customers');
  console.log('✅ Total Customers Count:', c.rows[0].count);

  const cash = await pool.query('SELECT id, amount, name, entry_type FROM cash_out ORDER BY id DESC LIMIT 2');
  console.log('✅ Latest Cash Out:', cash.rows);

  await pool.end();
  console.log("\n🎉 ALL APPLICATION QUERIES EXECUTED FLAWLESSLY!");
}

testAppQueries().catch(console.error);
