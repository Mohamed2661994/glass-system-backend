const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST_LOCAL,
  port: process.env.DB_PORT_LOCAL,
  user: process.env.DB_USER_LOCAL,
  password: process.env.DB_PASSWORD_LOCAL,
  database: process.env.DB_NAME_LOCAL,
  connectionTimeoutMillis: 5000,
});

async function run() {
  try {
    const res = await pool.query("SELECT pid, state, wait_event_type, wait_event, query FROM pg_stat_activity WHERE state != 'idle';");
    console.log("Active Queries:");
    console.table(res.rows);
  } catch (err) {
    console.error("Error connecting to DB:", err.message);
  } finally {
    pool.end();
  }
}

run();
