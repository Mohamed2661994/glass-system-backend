const { Pool } = require('pg');

const targetPool = new Pool({
  host: 'dbstudio.hg-alshour.online',
  port: 5432,
  user: 'glass_admin',
  password: '@Hadysalah1',
  database: 'glass_system',
  max: 2,
  connectionTimeoutMillis: 10000
});

async function checkSchema() {
  const client = await targetPool.connect();
  try {
    for (const t of ['online_invoice_audit', 'public_webhook_change_log', 'sync_deletions']) {
      const res = await client.query(`
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = $1 
        ORDER BY ordinal_position
      `, [t]);
      console.log(`Schema of ${t} on Target:`, res.rows.map(r => `${r.column_name} (${r.data_type})`).join(', '));
    }
  } finally {
    client.release();
    await targetPool.end();
  }
}

checkSchema();
