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
    const invoices = await pool.query('SELECT invoice_type, id, total, created_at FROM invoices WHERE user_id = 14 LIMIT 5');
    const cashIn = await pool.query('SELECT amount, name, created_at FROM cash_in WHERE user_id = 14 LIMIT 5');
    const cashOut = await pool.query('SELECT amount, name, created_at FROM cash_out WHERE user_id = 14 LIMIT 5');
    const transfers = await pool.query('SELECT id, created_at FROM stock_transfers WHERE user_id = 14 LIMIT 5');
    
    console.log('Invoices count: ' + (await pool.query('SELECT count(*) FROM invoices WHERE user_id = 14')).rows[0].count);
    if(invoices.rows.length) console.log(invoices.rows);
    
    console.log('Cash In count: ' + (await pool.query('SELECT count(*) FROM cash_in WHERE user_id = 14')).rows[0].count);
    if(cashIn.rows.length) console.log(cashIn.rows);
    
    console.log('Cash Out count: ' + (await pool.query('SELECT count(*) FROM cash_out WHERE user_id = 14')).rows[0].count);
    if(cashOut.rows.length) console.log(cashOut.rows);
    
    console.log('Transfers count: ' + (await pool.query('SELECT count(*) FROM stock_transfers WHERE user_id = 14')).rows[0].count);
    if(transfers.rows.length) console.log(transfers.rows);

  } catch(e) {
    console.error(e);
  } finally {
    pool.end();
  }
}

checkOperations();
