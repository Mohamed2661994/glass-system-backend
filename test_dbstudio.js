const { Pool } = require('pg');

const pool = new Pool({
  connectionString: "postgresql://glass_backend:SecGlass_2026_Postgres_HA@dbstudio.hg-alshour.online:5432/glass_system",
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

async function testConn() {
  try {
    console.log("Connecting to dbstudio.hg-alshour.online:5432/glass_system...");
    const client = await pool.connect();
    console.log("Connected successfully!");

    const info = await client.query(`
      SELECT current_database(), current_user, inet_server_addr(), version();
    `);
    console.log("DB Info:", info.rows[0]);

    const res = await client.query('SELECT id, invoice_number, total, created_at FROM invoices ORDER BY id DESC LIMIT 5');
    console.log("Latest Invoices:", res.rows);

    const tables = await client.query(`
      SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `);
    console.log("Table count:", tables.rows[0].count);

    client.release();
  } catch (err) {
    console.error("Connection failed:", err.message);
  } finally {
    await pool.end();
  }
}

testConn();
