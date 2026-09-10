const { Pool } = require('pg');

const sourcePool = new Pool({
  host: '18.185.48.10',
  port: 5432,
  user: 'glass_admin',
  password: '@Hadysalah1',
  database: 'glass_system',
  max: 3,
  connectionTimeoutMillis: 10000
});

const targetPool = new Pool({
  host: 'db.hg-alshour.online',
  port: 5432,
  user: 'glass_admin',
  password: '@Hadysalah1',
  database: 'glass_system',
  max: 3,
  connectionTimeoutMillis: 10000
});

async function run() {
  try {
    const sClient = await sourcePool.connect();
    const tClient = await targetPool.connect();

    const tablesRes = await sClient.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);

    const results = [];
    let differencesFound = 0;

    for (const row of tablesRes.rows) {
      const table = row.table_name;

      // Check if table exists on target
      const tTableCheck = await tClient.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' AND table_name = $1
        ) as exists
      `, [table]);

      if (!tTableCheck.rows[0].exists) {
        results.push({
          table,
          source_count: '?',
          target_count: 'MISSING TABLE',
          source_max_id: '?',
          target_max_id: '?',
          match: '❌ MISSING'
        });
        differencesFound++;
        continue;
      }

      // Check if has 'id' column
      const hasIdCol = await sClient.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.columns 
          WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'id'
        ) as exists
      `, [table]);

      const hasId = hasIdCol.rows[0].exists;
      const countQuery = hasId 
        ? `SELECT COUNT(*)::bigint as cnt, COALESCE(MAX(id)::text, '0') as max_id FROM "${table}"`
        : `SELECT COUNT(*)::bigint as cnt, 'N/A' as max_id FROM "${table}"`;

      const sRes = await sClient.query(countQuery).catch(e => ({ rows: [{ cnt: -1, max_id: 'err' }] }));
      const tRes = await tClient.query(countQuery).catch(e => ({ rows: [{ cnt: -1, max_id: 'err' }] }));

      const sCnt = sRes.rows[0].cnt;
      const tCnt = tRes.rows[0].cnt;
      const sMax = sRes.rows[0].max_id;
      const tMax = tRes.rows[0].max_id;

      const isMatch = (sCnt === tCnt && sMax === tMax);
      if (!isMatch) {
        differencesFound++;
      }

      results.push({
        table,
        source_count: sCnt,
        target_count: tCnt,
        source_max_id: sMax,
        target_max_id: tMax,
        match: isMatch ? '✅ MATCH' : '⚠️ DIFF'
      });
    }

    console.table(results);
    console.log(`\nTotal tables checked: ${results.length}`);
    console.log(`Tables with differences: ${differencesFound}`);

    sClient.release();
    tClient.release();
  } catch (err) {
    console.error("Error in check:", err);
  } finally {
    await sourcePool.end();
    await targetPool.end();
  }
}

run();
