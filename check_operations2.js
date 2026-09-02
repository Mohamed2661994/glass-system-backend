require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST_LOCAL,
  port: process.env.DB_PORT_LOCAL,
  user: process.env.DB_USER_LOCAL,
  password: process.env.DB_PASSWORD_LOCAL,
  database: process.env.DB_NAME_LOCAL
});

async function checkOperations() {
  const userId = 14;
  try {
    const invoices = await pool.query('SELECT invoice_type, total, created_at FROM invoices WHERE created_by = 14');
    const cashOut = await pool.query('SELECT amount, name, created_at FROM cash_out WHERE created_by = 14');
    
    console.log('Invoices count: ' + invoices.rows.length);
    console.log('Cash Out count: ' + cashOut.rows.length);

  } catch(e) {
    console.error(e);
  } finally {
    pool.end();
  }
}

checkOperations();
