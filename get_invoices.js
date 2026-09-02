require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST_CLOUD,
  port: process.env.DB_PORT_CLOUD,
  user: process.env.DB_USER_CLOUD,
  password: process.env.DB_PASSWORD_CLOUD,
  database: process.env.DB_NAME_CLOUD
});

async function getInvoices() {
  const userId = 14;
  try {
    const res = await pool.query('SELECT invoice_number, invoice_type, total, created_at FROM invoices WHERE created_by = ' + userId + ' ORDER BY created_at DESC');
    console.log(JSON.stringify(res.rows, null, 2));
  } catch(e) {
    console.error(e);
  } finally {
    pool.end();
  }
}

getInvoices();
