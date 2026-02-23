require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function fix() {
  try {
    const res = await pool.query(`
      UPDATE cash_in
      SET branch_id = 1
      WHERE source_type = 'invoice'
        AND branch_id = 2
        AND invoice_id IN (
          SELECT id FROM invoices WHERE invoice_type = 'retail'
        )
    `);
    console.log('Fixed rows:', res.rowCount);
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await pool.end();
  }
}

fix();
