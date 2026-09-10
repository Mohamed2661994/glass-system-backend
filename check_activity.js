const { Pool } = require('pg');
require('dotenv').config();

const POOL_OPTS = { connectionTimeoutMillis: 10000, query_timeout: 60000 };

const localPool = new Pool({
  host: process.env.DB_HOST_LOCAL,
  port: process.env.DB_PORT_LOCAL,
  user: process.env.DB_USER_LOCAL,
  password: process.env.DB_PASSWORD_LOCAL,
  database: process.env.DB_NAME_LOCAL,
  ssl: process.env.DB_SSL_LOCAL === "true" ? { rejectUnauthorized: false } : false,
  ...POOL_OPTS
});

const cloudPool = new Pool({
  host: process.env.DB_HOST_CLOUD,
  port: process.env.DB_PORT_CLOUD,
  user: process.env.DB_USER_CLOUD,
  password: process.env.DB_PASSWORD_CLOUD,
  database: process.env.DB_NAME_CLOUD,
  ssl: process.env.DB_SSL_CLOUD === "true" ? { rejectUnauthorized: false } : false,
  ...POOL_OPTS
});

async function checkLatestActivity() {
  const query = `
    SELECT 'user_activity' as source, id, action, created_at FROM user_activity ORDER BY created_at DESC LIMIT 1;
  `;
  const invoiceQuery = `
    SELECT 'invoices' as source, id, total, created_at FROM invoices ORDER BY created_at DESC LIMIT 1;
  `;
  const stockQuery = `
    SELECT 'stock_movements' as source, id, operation, created_at FROM stock_movements ORDER BY created_at DESC LIMIT 1;
  `;

  async function getLatest(pool, name) {
    try {
      const act = await pool.query(query).catch(e => { console.error(e.message); return { rows: [] }; });
      const inv = await pool.query(invoiceQuery).catch(e => { console.error(e.message); return { rows: [] }; });
      const stk = await pool.query(stockQuery).catch(e => { console.error(e.message); return { rows: [] }; });
      
      const all = [...act.rows, ...inv.rows, ...stk.rows];
      all.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      
      if (all.length > 0) {
         console.log(`[${name}] Latest Record:`, all[0].source, 'ID:', all[0].id, 'Created At:', all[0].created_at);
      } else {
         console.log(`[${name}] No recent activity found.`);
      }
    } catch (e) {
      console.error(`[${name}] Error:`, e.message);
    }
  }

  console.log("Checking Local DB...");
  await getLatest(localPool, "LOCAL");
  
  console.log("Checking Cloud DB...");
  await getLatest(cloudPool, "CLOUD");
  
  localPool.end();
  cloudPool.end();
}

checkLatestActivity();
