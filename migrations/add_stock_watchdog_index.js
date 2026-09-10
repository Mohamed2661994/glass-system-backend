const { Pool } = require('pg');

async function applyIndex(host, user, password, dbname, label) {
  const pool = new Pool({
    host,
    port: 5432,
    user,
    password,
    database: dbname,
    max: 2,
    connectionTimeoutMillis: 10000
  });

  try {
    console.log(`Connecting to ${label} (${host}) as ${user}...`);
    const t0 = Date.now();
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_stock_movements_wh_prod 
      ON stock_movements (warehouse_id, product_id);
    `);
    console.log(`✅ [${label}] Index idx_stock_movements_wh_prod created in ${Date.now() - t0}ms`);
  } catch (err) {
    console.error(`❌ [${label}] Failed to create index:`, err.message);
  } finally {
    await pool.end();
  }
}

async function run() {
  // 1. Data Studio Primary as glass_admin
  await applyIndex('dbstudio.hg-alshour.online', 'glass_admin', '@Hadysalah1', 'glass_system', 'Data Studio Primary');

  // 2. AWS Cloud Standby as glass_admin
  await applyIndex('18.185.48.10', 'glass_admin', '@Hadysalah1', 'glass_system', 'AWS Cloud Standby');
  
  process.exit(0);
}

run().catch(console.error);
