const { Pool } = require("pg");
require("dotenv").config();

/* ── PostgreSQL Connection Pool ────────────────────────── */
const pool = new Pool({
  host: process.env.DB_HOST_LOCAL,
  port: Number(process.env.DB_PORT_LOCAL || 5432),
  user: process.env.DB_USER_LOCAL,
  password: process.env.DB_PASSWORD_LOCAL,
  database: process.env.DB_NAME_LOCAL,
  ssl:
    process.env.DB_SSL_LOCAL === "true" ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 5000,
});

// Set timezone to Africa/Cairo for every new connection
pool.on("connect", (client) => {
  client.query("SET timezone = 'Africa/Cairo'");
});

// Prevent unhandled error events from crashing the process
pool.on("error", (err) => {
  console.error("⚠️  Pool idle client error:", err.message);
});

module.exports = pool;
