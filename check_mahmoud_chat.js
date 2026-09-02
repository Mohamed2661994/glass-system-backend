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
  try {
    console.log('Mahmoud Messages count: ' + (await pool.query('SELECT count(*) FROM messages WHERE sender_id = 14')).rows[0].count);
    console.log('Mahmoud push subs count: ' + (await pool.query('SELECT count(*) FROM push_subscriptions WHERE user_id = 14')).rows[0].count);
  } catch(e) {
    console.error(e);
  } finally {
    pool.end();
  }
}

checkOperations();
