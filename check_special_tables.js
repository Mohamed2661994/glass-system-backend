const { Pool } = require('pg');

const sourcePool = new Pool({
  host: '18.185.48.10',
  port: 5432,
  user: 'glass_admin',
  password: '@Hadysalah1',
  database: 'glass_system',
  max: 2,
  connectionTimeoutMillis: 10000
});

const targetPool = new Pool({
  connectionString: "postgresql://glass_backend:SecGlass_2026_Postgres_HA@dbstudio.hg-alshour.online:5432/glass_system",
  max: 2,
  connectionTimeoutMillis: 10000
});

async function checkTables() {
  const sClient = await sourcePool.connect();
  const tClient = await targetPool.connect();
  try {
    for (const tbl of ['online_invoice_audit', 'public_webhook_change_log', 'sync_deletions']) {
      const sCount = await sClient.query(`SELECT count(*) FROM "${tbl}"`);
      const tCount = await tClient.query(`SELECT count(*) FROM "${tbl}"`);
      console.log(`Table ${tbl}: source=${sCount.rows[0].count}, target=${tCount.rows[0].count}`);
    }
  } finally {
    sClient.release();
    tClient.release();
    await sourcePool.end();
    await targetPool.end();
  }
}

checkTables();
