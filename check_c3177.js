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

async function checkDeletions() {
  const client = await sourcePool.connect();
  try {
    const res = await client.query(`SELECT * FROM sync_deletions WHERE table_name = 'cash_in' ORDER BY deleted_at DESC LIMIT 5`);
    console.log("Recent cash_in deletions:", res.rows);
    const c3177 = await client.query(`SELECT * FROM cash_in WHERE id = 3177`);
    console.log("c3177 on source:", c3177.rows);
  } finally {
    client.release();
    await sourcePool.end();
  }
}

checkDeletions();
