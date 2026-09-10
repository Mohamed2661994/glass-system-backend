const { Pool } = require('pg');

const sourcePool = new Pool({
  host: '18.185.48.10',
  port: 5432,
  user: 'glass_admin',
  password: '@Hadysalah1',
  database: 'glass_system'
});

async function inspect() {
  const client = await sourcePool.connect();
  try {
    // 1. Foreign keys definition query using pg_catalog
    const fkRes = await client.query(`
      SELECT
        conrelid::regclass AS table_name,
        conname AS constraint_name,
        pg_get_constraintdef(c.oid, true) AS constraint_def
      FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE contype = 'f' AND n.nspname = 'public'
      ORDER BY conrelid::regclass::text, conname;
    `);

    console.log(`=== FOREIGN KEYS (${fkRes.rows.length}) ===`);
    for (const r of fkRes.rows) {
      console.log(`ALTER TABLE ${r.table_name} ADD CONSTRAINT "${r.constraint_name}" ${r.constraint_def};`);
    }

    // 2. Triggers definition query
    const trgRes = await client.query(`
      SELECT
        event_object_table,
        trigger_name,
        action_timing,
        event_manipulation,
        action_statement,
        action_orientation
      FROM information_schema.triggers
      WHERE trigger_schema = 'public'
      ORDER BY event_object_table, trigger_name;
    `);

    console.log(`\n=== TRIGGERS (${trgRes.rows.length}) ===`);
    for (const r of trgRes.rows.slice(0, 10)) {
      console.log(`${r.event_object_table} | ${r.trigger_name} | ${r.action_timing} ${r.event_manipulation} | ${r.action_statement}`);
    }

  } finally {
    client.release();
    await sourcePool.end();
  }
}

inspect().catch(console.error);
