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

async function runReadinessCheck() {
  console.log("=============================================================");
  console.log("🔍 COMPREHENSIVE PRODUCTION READINESS CHECK: DATA STUDIO DB");
  console.log("=============================================================\n");

  const sClient = await sourcePool.connect();
  const tClient = await targetPool.connect();

  try {
    // 1. Check Latency
    console.log("1️⃣ Checking Network Latency...");
    const t0 = Date.now();
    await tClient.query('SELECT 1');
    const latency = Date.now() - t0;
    console.log(`   Ping Latency: ${latency}ms`);

    // 2. Check Permissions (CRUD & Transactions)
    console.log("\n2️⃣ Checking Transactional CRUD Capabilities for glass_backend...");
    await tClient.query('BEGIN');
    
    // Test sequence nextval
    const seqTest = await tClient.query("SELECT nextval('users_id_seq') as next_val");
    console.log(`   Sequence nextval test: Success (returned ${seqTest.rows[0].next_val})`);

    // Fetch real columns of user_activity
    const actCols = await tClient.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'user_activity'");
    console.log("   user_activity columns:", actCols.rows.map(c => c.column_name).join(', '));

    // Test insert + update + delete in transaction on user_activity, then rollback
    const insTest = await tClient.query(`
      INSERT INTO user_activity (user_id, username, action)
      VALUES (1, 'tester', 'TEST_READY')
      RETURNING id
    `);
    const testId = insTest.rows[0].id;
    console.log(`   INSERT test: Success (inserted row id: ${testId})`);

    await tClient.query(`
      UPDATE user_activity SET action = 'TEST_UPDATED'
      WHERE id = $1
    `, [testId]);
    console.log(`   UPDATE test: Success`);

    await tClient.query(`DELETE FROM user_activity WHERE id = $1`, [testId]);
    console.log(`   DELETE test: Success`);

    await tClient.query('ROLLBACK');
    console.log(`   ROLLBACK test: Success (clean rollback, no test pollution)`);

    // 3. Compare Triggers between Source and Studio
    console.log("\n3️⃣ Checking Triggers parity...");
    const sTriggers = await sClient.query(`
      SELECT trigger_name, event_object_table, action_statement
      FROM information_schema.triggers
      WHERE trigger_schema = 'public'
      ORDER BY event_object_table, trigger_name
    `);
    const tTriggers = await tClient.query(`
      SELECT trigger_name, event_object_table, action_statement
      FROM information_schema.triggers
      WHERE trigger_schema = 'public'
      ORDER BY event_object_table, trigger_name
    `);

    console.log(`   Source DB Triggers: ${sTriggers.rows.length}`);
    console.log(`   Target DB Triggers: ${tTriggers.rows.length}`);
    const tTrigSet = new Set(tTriggers.rows.map(r => `${r.event_object_table}.${r.trigger_name}`));
    const missingTriggers = sTriggers.rows.filter(r => !tTrigSet.has(`${r.event_object_table}.${r.trigger_name}`));
    if (missingTriggers.length === 0) {
      console.log(`   ✅ Triggers parity: 100% MATCH`);
    } else {
      console.log(`   ⚠️ Missing triggers:`, missingTriggers);
    }

    // 4. Compare Indexes between Source and Studio
    console.log("\n4️⃣ Checking Indexes parity...");
    const sIndexes = await sClient.query(`
      SELECT tablename, indexname 
      FROM pg_indexes 
      WHERE schemaname = 'public'
      ORDER BY tablename, indexname
    `);
    const tIndexes = await tClient.query(`
      SELECT tablename, indexname 
      FROM pg_indexes 
      WHERE schemaname = 'public'
      ORDER BY tablename, indexname
    `);

    console.log(`   Source DB Indexes: ${sIndexes.rows.length}`);
    console.log(`   Target DB Indexes: ${tIndexes.rows.length}`);
    const tIdxSet = new Set(tIndexes.rows.map(r => `${r.tablename}.${r.indexname}`));
    const missingIndexes = sIndexes.rows.filter(r => !tIdxSet.has(`${r.tablename}.${r.indexname}`));
    if (missingIndexes.length === 0) {
      console.log(`   ✅ Indexes parity: 100% MATCH`);
    } else {
      console.log(`   ⚠️ Missing indexes count: ${missingIndexes.length}`);
      if (missingIndexes.length < 10) {
        console.log(missingIndexes);
      }
    }

    // 5. Compare Foreign Keys
    console.log("\n5️⃣ Checking Foreign Key Constraints parity...");
    const sFks = await sClient.query(`
      SELECT tc.constraint_name, tc.table_name
      FROM information_schema.table_constraints tc
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
    `);
    const tFks = await tClient.query(`
      SELECT tc.constraint_name, tc.table_name
      FROM information_schema.table_constraints tc
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
    `);
    console.log(`   Source DB FKs: ${sFks.rows.length}`);
    console.log(`   Target DB FKs: ${tFks.rows.length}`);
    const tFkSet = new Set(tFks.rows.map(r => `${r.table_name}.${r.constraint_name}`));
    const missingFks = sFks.rows.filter(r => !tFkSet.has(`${r.table_name}.${r.constraint_name}`));
    if (missingFks.length === 0) {
      console.log(`   ✅ Foreign Keys parity: 100% MATCH`);
    } else {
      console.log(`   ⚠️ Missing FKs count: ${missingFks.length}`);
    }

    // 6. Check Views / Functions
    console.log("\n6️⃣ Checking Functions / Routines parity...");
    const sRoutines = await sClient.query(`
      SELECT routine_name 
      FROM information_schema.routines 
      WHERE routine_schema = 'public'
    `);
    const tRoutines = await tClient.query(`
      SELECT routine_name 
      FROM information_schema.routines 
      WHERE routine_schema = 'public'
    `);
    console.log(`   Source DB Routines: ${sRoutines.rows.length}`);
    console.log(`   Target DB Routines: ${tRoutines.rows.length}`);
    const tRoutineSet = new Set(tRoutines.rows.map(r => r.routine_name));
    const missingRoutines = sRoutines.rows.filter(r => !tRoutineSet.has(r.routine_name));
    if (missingRoutines.length === 0) {
      console.log(`   ✅ Routines parity: 100% MATCH`);
    } else {
      console.log(`   ⚠️ Missing routines:`, missingRoutines);
    }

  } finally {
    sClient.release();
    tClient.release();
    await sourcePool.end();
    await targetPool.end();
  }
}

runReadinessCheck().catch(console.error);
