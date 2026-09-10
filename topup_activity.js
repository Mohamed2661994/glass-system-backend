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

const targetAdminPool = new Pool({
  host: 'dbstudio.hg-alshour.online',
  port: 5432,
  user: 'glass_admin',
  password: '@Hadysalah1',
  database: 'glass_system',
  max: 2,
  connectionTimeoutMillis: 10000
});

const targetBackendPool = new Pool({
  connectionString: "postgresql://glass_backend:SecGlass_2026_Postgres_HA@dbstudio.hg-alshour.online:5432/glass_system",
  max: 2,
  connectionTimeoutMillis: 10000
});

async function topup() {
  const sClient = await sourcePool.connect();
  const tClient = await targetAdminPool.connect();

  try {
    const maxRes = await tClient.query(`SELECT COALESCE(MAX(id), 0) as max_id FROM user_activity`);
    const targetMaxId = maxRes.rows[0].max_id;

    const colsRes = await sClient.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_schema = 'public' AND table_name = 'user_activity' ORDER BY ordinal_position
    `);
    const cols = colsRes.rows.map(r => r.column_name);
    const colList = cols.map(c => `"${c}"`).join(', ');

    const sRows = await sClient.query(`SELECT ${colList} FROM user_activity WHERE id > $1 ORDER BY id ASC`, [targetMaxId]);
    for (const r of sRows.rows) {
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
      const values = cols.map(c => r[c]);
      await tClient.query(`
        INSERT INTO user_activity (${colList})
        VALUES (${placeholders})
        ON CONFLICT (id) DO NOTHING
      `, values);
    }

    const bClient = await targetBackendPool.connect();
    const sc = await sClient.query(`SELECT COUNT(*) as c, MAX(id) as m FROM user_activity`);
    const tc = await bClient.query(`SELECT COUNT(*) as c, MAX(id) as m FROM user_activity`);
    console.log("user_activity Parity:", {
      source: sc.rows[0],
      dbstudio: tc.rows[0],
      match: sc.rows[0].c === tc.rows[0].c && sc.rows[0].m === tc.rows[0].m ? "✅ 100% MATCH" : "⚠️ DIFF"
    });
    bClient.release();
  } finally {
    sClient.release();
    tClient.release();
    await sourcePool.end();
    await targetAdminPool.end();
    await targetBackendPool.end();
  }
}

topup();
