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
