const { Pool } = require('pg');

const sourcePool = new Pool({
  host: '18.185.48.10',
  port: 5432,
  user: 'glass_admin',
  password: '@Hadysalah1',
  database: 'glass_system',
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

const targetPool = new Pool({
  host: 'db.hg-alshour.online',
  port: 5432,
  user: 'glass_admin',
  password: '@Hadysalah1',
  database: 'glass_system',
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

const BATCH_SIZE = 500;

async function syncTableDelta(sClient, tClient, table, idCol = 'id') {
  // Get max ID on target
  let targetMaxId = 0;
  if (idCol) {
    const maxRes = await tClient.query(`SELECT COALESCE(MAX("${idCol}"), 0) as max_id FROM "${table}"`);
    targetMaxId = maxRes.rows[0].max_id;
  }

  // Get columns
  const colsRes = await sClient.query(`
    SELECT column_name 
    FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = $1
    ORDER BY ordinal_position
  `, [table]);
  const columns = colsRes.rows.map(r => r.column_name);
  const colList = columns.map(c => `"${c}"`).join(', ');

  // Query new rows from source
  let query = `SELECT ${colList} FROM "${table}"`;
  const params = [];
  if (idCol && targetMaxId > 0) {
    query += ` WHERE "${idCol}" > $1 ORDER BY "${idCol}" ASC`;
    params.push(targetMaxId);
  }

  const newRowsRes = await sClient.query(query, params);
  const rows = newRowsRes.rows;

  if (rows.length === 0) {
    console.log(`✅ ${table.padEnd(25)} Already up to date (0 new rows).`);
    return 0;
  }

  console.log(`📦 ${table.padEnd(25)} Syncing ${rows.length} new records (after ID ${targetMaxId})...`);

  // Insert in batches
  let offset = 0;
  while (offset < rows.length) {
    const batch = rows.slice(offset, offset + BATCH_SIZE);
    const valuePlaceholders = [];
    const insertParams = [];
    let pIdx = 1;

    for (const r of batch) {
      const rowPlaceholders = [];
      for (const col of columns) {
        rowPlaceholders.push(`$${pIdx++}`);
        insertParams.push(r[col]);
      }
      valuePlaceholders.push(`(${rowPlaceholders.join(', ')})`);
    }

    const insertSql = `
      INSERT INTO "${table}" (${colList})
      VALUES ${valuePlaceholders.join(', ')}
      ON CONFLICT ("${idCol}") DO NOTHING
    `;

    await tClient.query(insertSql, insertParams);
    offset += batch.length;
  }

  console.log(`   └─ Successfully inserted ${rows.length} rows into ${table}.`);
  return rows.length;
}

async function syncStockTable(sClient, tClient) {
  console.log(`🔄 Syncing stock table (live current quantities)...`);
  const colsRes = await sClient.query(`
    SELECT column_name 
    FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'stock'
    ORDER BY ordinal_position
  `);
  const columns = colsRes.rows.map(r => r.column_name);
  const colList = columns.map(c => `"${c}"`).join(', ');

  const stockRows = await sClient.query(`SELECT ${colList} FROM stock`);
  await tClient.query(`TRUNCATE TABLE stock`);

  let offset = 0;
  while (offset < stockRows.rows.length) {
    const batch = stockRows.rows.slice(offset, offset + BATCH_SIZE);
    const valuePlaceholders = [];
    const insertParams = [];
    let pIdx = 1;

    for (const r of batch) {
      const rowPlaceholders = [];
      for (const col of columns) {
        rowPlaceholders.push(`$${pIdx++}`);
        insertParams.push(r[col]);
      }
      valuePlaceholders.push(`(${rowPlaceholders.join(', ')})`);
    }

    await tClient.query(`
      INSERT INTO stock (${colList})
      VALUES ${valuePlaceholders.join(', ')}
    `, insertParams);
    offset += batch.length;
  }
  console.log(`   └─ stock table updated with ${stockRows.rows.length} active records.`);
}

async function main() {
  console.log("🚀 STARTING INCREMENTAL DELTA SYNC TO DATA STUDIO...\n");
  const startTime = Date.now();

  const sClient = await sourcePool.connect();
  const tClient = await targetPool.connect();

  await tClient.query("SET session_replication_role = 'replica'");

  // Sync transactional and master tables
  await syncTableDelta(sClient, tClient, 'customers', 'id');
  await syncTableDelta(sClient, tClient, 'customer_phones', 'id');
  await syncTableDelta(sClient, tClient, 'invoices', 'id');
  await syncTableDelta(sClient, tClient, 'invoice_items', 'id');
  await syncTableDelta(sClient, tClient, 'stock_movements', 'id');
  await syncTableDelta(sClient, tClient, 'cash_in', 'id');
  await syncTableDelta(sClient, tClient, 'cash_out', 'id');
  await syncTableDelta(sClient, tClient, 'stock_transfers', 'id');
  await syncTableDelta(sClient, tClient, 'stock_transfer_items', 'id');
  await syncTableDelta(sClient, tClient, 'notifications', 'id');
  await syncTableDelta(sClient, tClient, 'messages', 'id');
  await syncTableDelta(sClient, tClient, 'user_activity', 'id');

  // Sync stock balances
  await syncStockTable(sClient, tClient);

  await tClient.query("SET session_replication_role = 'origin'");

  // Re-align sequences
  console.log("\n🔢 Aligning sequences...");
  const seqsRes = await tClient.query(`
    SELECT sequence_name 
    FROM information_schema.sequences 
    WHERE sequence_schema = 'public'
  `);

  for (const row of seqsRes.rows) {
    const seq = row.sequence_name;
    const candidateTable = seq.replace(/_id_seq$/, '').replace(/_seq$/, '');
    try {
      const maxRes = await tClient.query(`
        SELECT COALESCE(MAX(id), 1) as max_val 
        FROM "${candidateTable}"
      `);
      const nextVal = parseInt(maxRes.rows[0].max_val, 10);
      await tClient.query(`SELECT setval('"${seq}"', $1, true)`, [nextVal]);
    } catch (e) {}
  }
  console.log("✅ Sequences aligned.");

  // Permissions
  await tClient.query(`
    GRANT ALL ON SCHEMA public TO glass_backend;
    GRANT ALL ON ALL TABLES IN SCHEMA public TO glass_backend;
    GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO glass_backend;
  `);

  sClient.release();
  tClient.release();

  console.log("\n📊 RUNNING PARITY CHECK...");
  const tables = [
    'invoices',
    'invoice_items',
    'stock_movements',
    'stock',
    'cash_in',
    'cash_out',
    'stock_transfers',
    'stock_transfer_items',
    'customers',
    'products',
    'notifications',
    'messages'
  ];

  const audit = [];
  for (const t of tables) {
    const sc = await sourcePool.query(`SELECT COUNT(*) as c, COALESCE(MAX(id), 0) as m FROM "${t}"`).catch(() => ({ rows: [{ c: 0, m: 0 }] }));
    const tc = await targetPool.query(`SELECT COUNT(*) as c, COALESCE(MAX(id), 0) as m FROM "${t}"`).catch(() => ({ rows: [{ c: 0, m: 0 }] }));
    const sCount = parseInt(sc.rows[0].c, 10);
    const tCount = parseInt(tc.rows[0].c, 10);
    const sMax = sc.rows[0].m;
    const tMax = tc.rows[0].m;

    audit.push({
      table: t,
      source_live_18: sCount,
      data_studio: tCount,
      source_max_id: sMax,
      studio_max_id: tMax,
      status: (sCount === tCount && sMax === tMax) ? '✅ 100% MATCH' : '⚠️ MISMATCH'
    });
  }

  console.table(audit);

  await sourcePool.end();
  await targetPool.end();

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n🎉 DELTA SYNC FINISHED IN ${totalTime}s!`);
}

main().catch(console.error);
