const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false,
});

// Set timezone to Africa/Cairo for every new connection
// so CURRENT_DATE, NOW(), etc. return Egypt local time
pool.on("connect", (client) => {
  client.query("SET timezone = 'Africa/Cairo'");
});

module.exports = pool;
