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

async function applyFksAndTriggers() {
  console.log("==========================================================");
  console.log("🛠️  APPLYING FOREIGN KEYS & TRIGGERS TO DATA STUDIO DB");
  console.log("==========================================================\n");

  const sClient = await sourcePool.connect();
  const tClient = await targetAdminPool.connect();

  try {
    // 1. Foreign Keys
    console.log("1️⃣ Applying Foreign Key Constraints...");
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

    let fkAdded = 0;
    let fkSkipped = 0;
    let fkErrors = 0;

    for (const r of fkRes.rows) {
      try {
        await tClient.query(`
          ALTER TABLE ${r.table_name} 
          ADD CONSTRAINT "${r.constraint_name}" ${r.constraint_def};
        `);
        fkAdded++;
      } catch (err) {
        if (err.message.includes("already exists")) {
          fkSkipped++;
        } else {
          console.error(`   ❌ Failed FK [${r.constraint_name}] on ${r.table_name}:`, err.message);
          fkErrors++;
        }
      }
    }
    console.log(`   FKs Summary: ${fkAdded} added, ${fkSkipped} already existed, ${fkErrors} errors.`);

    // 2. Triggers
    console.log("\n2️⃣ Applying Triggers...");
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

    let trgAdded = 0;
    let trgSkipped = 0;
    let trgErrors = 0;

    for (const r of trgRes.rows) {
      try {
        await tClient.query(r.trigger_def);
        trgAdded++;
      } catch (err) {
        if (err.message.includes("already exists")) {
          trgSkipped++;
        } else {
          console.error(`   ❌ Failed Trigger [${r.trigger_name}] on ${r.table_name}:`, err.message);
          trgErrors++;
        }
      }
    }
    console.log(`   Triggers Summary: ${trgAdded} added, ${trgSkipped} already existed, ${trgErrors} errors.`);

  } finally {
    sClient.release();
    tClient.release();
    await sourcePool.end();
    await targetAdminPool.end();
  }
}

applyFksAndTriggers().catch(console.error);
