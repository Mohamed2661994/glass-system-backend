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

// Admin pool on Data Studio to add constraints and triggers
const targetAdminPool = new Pool({
  host: 'dbstudio.hg-alshour.online',
  port: 5432,
  user: 'glass_admin',
  password: '@Hadysalah1',
  database: 'glass_system',
  max: 2,
  connectionTimeoutMillis: 10000
});

async function checkFksAndTriggersPlan() {
  console.log("Extracting Foreign Keys and Triggers from Source...");
  const sClient = await sourcePool.connect();
  const tClient = await targetAdminPool.connect();

  try {
    // 1. Foreign keys
    const fkRes = await sClient.query(`
      SELECT
        conrelid::regclass AS table_name,
        conname AS constraint_name,
        pg_get_constraintdef(c.oid, true) AS constraint_def
      FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE contype = 'f' AND n.nspname = 'public'
      ORDER BY conrelid::regclass::text, conname;
    `);

    console.log(`Found ${fkRes.rows.length} Foreign Keys on source.`);

    // 2. Triggers with complete DDL
    const trgRes = await sClient.query(`
      SELECT
        c.relname as table_name,
        t.tgname as trigger_name,
        pg_get_triggerdef(t.oid) as trigger_def
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT t.tgisinternal AND n.nspname = 'public'
      ORDER BY c.relname, t.tgname;
    `);

    console.log(`Found ${trgRes.rows.length} Triggers on source.`);
    for (const r of trgRes.rows.slice(0, 5)) {
      console.log(`Table: ${r.table_name} -> ${r.trigger_def}`);
    }

  } finally {
    sClient.release();
    tClient.release();
    await sourcePool.end();
    await targetAdminPool.end();
  }
}

checkFksAndTriggersPlan().catch(console.error);
