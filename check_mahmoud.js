require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST_CLOUD,
  port: process.env.DB_PORT_CLOUD,
  user: process.env.DB_USER_CLOUD,
  password: process.env.DB_PASSWORD_CLOUD,
  database: process.env.DB_NAME_CLOUD
});

async function checkOperations() {
  const userId = 14;
  try {
    const invoices = await pool.query('SELECT invoice_type, total, created_at FROM invoices WHERE created_by =  LIMIT 2', [userId]);
    const cashOut = await pool.query('SELECT amount, name, created_at FROM cash_out WHERE created_by =  LIMIT 2', [userId]);
    const msgs = await pool.query('SELECT id, content FROM messages WHERE sender_id =  LIMIT 2', [userId]);
    const subs = await pool.query('SELECT endpoint FROM push_subscriptions WHERE user_id =  LIMIT 2', [userId]);
    
    console.log('Invoices count: ' + (await pool.query('SELECT count(*) FROM invoices WHERE created_by = ', [userId])).rows[0].count);
    console.log('Cash Out count: ' + (await pool.query('SELECT count(*) FROM cash_out WHERE created_by = ', [userId])).rows[0].count);
    console.log('Messages count: ' + (await pool.query('SELECT count(*) FROM messages WHERE sender_id = ', [userId])).rows[0].count);
    console.log('Push subs count: ' + (await pool.query('SELECT count(*) FROM push_subscriptions WHERE user_id = ', [userId])).rows[0].count);

  } catch(e) {
    console.error(e);
  } finally {
    pool.end();
  }
}

checkOperations();
