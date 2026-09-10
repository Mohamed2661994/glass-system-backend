const { Pool } = require('pg');

const sourcePool = new Pool({
  host: '18.185.48.10',
  port: 5432,
  user: 'glass_admin',
  password: '@Hadysalah1',
  database: 'glass_system',
  max: 2,
  connectionTimeoutMillis: 10000
});

async function checkUpdatedToday() {
  const client = await sourcePool.connect();
  try {
    const res = await client.query(`
      SELECT id, invoice_number, total, updated_at 
      FROM invoices 
      WHERE updated_at >= '2026-09-08 00:00:00' AND id < 3390
      ORDER BY updated_at DESC
    `);
    console.log(`Invoices < 3390 updated today (${res.rows.length}):`, res.rows);
  } finally {
    client.release();
    await sourcePool.end();
  }
}

checkUpdatedToday();
