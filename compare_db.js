const { Pool } = require('pg');
require('dotenv').config();

const localPool = new Pool({
  host: process.env.DB_HOST_LOCAL,
  port: process.env.DB_PORT_LOCAL,
  user: process.env.DB_USER_LOCAL,
  password: process.env.DB_PASSWORD_LOCAL,
  database: process.env.DB_NAME_LOCAL,
  connectionTimeoutMillis: 5000
});

const cloudPool = new Pool({
  host: process.env.DB_HOST_CLOUD,
  port: process.env.DB_PORT_CLOUD,
  user: process.env.DB_USER_CLOUD,
  password: process.env.DB_PASSWORD_CLOUD,
  database: process.env.DB_NAME_CLOUD,
  connectionTimeoutMillis: 5000
});

const TABLES = [
  'invoices',
  'invoice_items',
  'stock_movements',
  'cash_in',
  'cash_out',
  'stock_transfers',
  'app_settings'
];

async function compareTables() {
  console.log("Starting comparison...");
  const results = [];
  
  for (const table of TABLES) {
    try {
      const isSettings = table === 'app_settings';
      const timeCol = isSettings ? 'updated_at' : 'created_at';
      
      const localRes = await localPool.query(`SELECT COUNT(*) as count, MAX(${timeCol}) as max_time FROM ${table}`);
      const cloudRes = await cloudPool.query(`SELECT COUNT(*) as count, MAX(${timeCol}) as max_time FROM ${table}`);
      
      const localCount = localRes.rows[0].count;
      const cloudCount = cloudRes.rows[0].count;
      const localTime = localRes.rows[0].max_time;
      const cloudTime = cloudRes.rows[0].max_time;
      
      results.push({
        table,
        local_count: localCount,
        cloud_count: cloudCount,
        local_latest: localTime,
        cloud_latest: cloudTime,
        status: (localCount === cloudCount && localTime?.toString() === cloudTime?.toString()) ? 'SYNCED' : 'NOT SYNCED'
      });
      
    } catch (e) {
      console.error(`Error querying ${table}: ${e.message}`);
    }
  }
  
  console.table(results);
  
  await localPool.end();
  await cloudPool.end();
}

compareTables();
