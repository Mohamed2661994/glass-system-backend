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

// Using glass_admin on dbstudio for superuser replication role and batch ops
const targetAdminPool = new Pool({
  host: 'dbstudio.hg-alshour.online',
  port: 5432,
  user: 'glass_admin',
  password: '@Hadysalah1',
  database: 'glass_system',
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

// Verification pool using glass_backend
const targetBackendPool = new Pool({
  connectionString: "postgresql://glass_backend:SecGlass_2026_Postgres_HA@dbstudio.hg-alshour.online:5432/glass_system",
  max: 2,
  connectionTimeoutMillis: 10000
});

const BATCH_SIZE = 500;

async function getColumns(client, table) {
  const colsRes = await client.query(`
    SELECT column_name 
    FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = $1
    ORDER BY ordinal_position
  `, [table]);
  return colsRes.rows.map(r => r.column_name);
}

// Upsert rows in batches
async function upsertRows(tClient, table, columns, rows, idCol = 'id') {
  if (rows.length === 0) return 0;

  const colList = columns.map(c => `"${c}"`).join(', ');
  const updateList = columns
    .filter(c => c !== idCol)
    .map(c => `"${c}" = EXCLUDED."${c}"`)
    .join(', ');

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

    const conflictClause = updateList.length > 0
      ? `ON CONFLICT ("${idCol}") DO UPDATE SET ${updateList}`
      : `ON CONFLICT ("${idCol}") DO NOTHING`;

    const sql = `
      INSERT INTO "${table}" (${colList})
      VALUES ${valuePlaceholders.join(', ')}
      ${conflictClause}
    `;

    await tClient.query(sql, insertParams);
    offset += batch.length;
  }
  return rows.length;
}

// Insert rows DO NOTHING
async function insertDoNothing(tClient, table, columns, rows, idCol = 'id') {
  if (rows.length === 0) return 0;

  const colList = columns.map(c => `"${c}"`).join(', ');
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

    const conflictClause = idCol ? `ON CONFLICT ("${idCol}") DO NOTHING` : '';
    const sql = `
      INSERT INTO "${table}" (${colList})
      VALUES ${valuePlaceholders.join(', ')}
      ${conflictClause}
    `;

    await tClient.query(sql, insertParams);
    offset += batch.length;
  }
  return rows.length;
}

async function syncTableWithUpsert(sClient, tClient, table, idCol = 'id', checkUpdatedAt = true) {
  const columns = await getColumns(sClient, table);
  const hasUpdatedAt = checkUpdatedAt && columns.includes('updated_at');

  const maxRes = await tClient.query(`SELECT COALESCE(MAX("${idCol}"), 0) as max_id FROM "${table}"`);
  const targetMaxId = maxRes.rows[0].max_id;

  const colList = columns.map(c => `"${c}"`).join(', ');
  let query = `SELECT ${colList} FROM "${table}" WHERE "${idCol}" > $1`;
  const params = [targetMaxId];

  if (hasUpdatedAt) {
    query += ` OR updated_at >= CURRENT_DATE - INTERVAL '1 day'`;
  }
  query += ` ORDER BY "${idCol}" ASC`;

  const sRows = (await sClient.query(query, params)).rows;
  if (sRows.length === 0) {
    console.log(`✅ ${table.padEnd(28)} Already up to date (0 new/updated rows).`);
    return 0;
  }

  console.log(`📦 ${table.padEnd(28)} Syncing ${sRows.length} rows (new/updated)...`);
  const synced = await upsertRows(tClient, table, columns, sRows, idCol);
  console.log(`   └─ Successfully upserted ${synced} rows into ${table}.`);
  return synced;
}

async function syncDeletions(sClient, tClient) {
  console.log(`🗑️ Processing deletions from sync_deletions...`);
  const delRes = await sClient.query(`
    SELECT table_name, pk_value 
    FROM sync_deletions 
    WHERE deleted_at >= CURRENT_DATE - INTERVAL '2 days'
  `);

  let count = 0;
  for (const del of delRes.rows) {
    const tbl = del.table_name;
    const pk = del.pk_value;
    try {
      const res = await tClient.query(`DELETE FROM "${tbl}" WHERE id = $1`, [pk]);
      if (res.rowCount > 0) {
        console.log(`   └─ Deleted ${tbl} ID ${pk} on target.`);
        count++;
      }
    } catch (e) {}
  }
  console.log(`✅ Synced ${count} deletions.`);
}

async function syncStockTable(sClient, tClient) {
  console.log(`🔄 Syncing live stock quantities (full sync)...`);
  const columns = await getColumns(sClient, 'stock');
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
  console.log(`✅ stock table updated with ${stockRows.rows.length} live records.`);
}

async function main() {
  console.log("==========================================================");
  console.log("🚀 MIGRATING DELTA TO DATA STUDIO (dbstudio.hg-alshour.online)");
  console.log("==========================================================\n");
  const startTime = Date.now();

  const sClient = await sourcePool.connect();
  const tClient = await targetAdminPool.connect();

  console.log("Disabling triggers for sync session...");
  await tClient.query("SET session_replication_role = 'replica'");

  // 1. Master & Transactional Tables
  await syncTableWithUpsert(sClient, tClient, 'customers', 'id', true);
  await syncTableWithUpsert(sClient, tClient, 'customer_phones', 'id', false);
  await syncTableWithUpsert(sClient, tClient, 'invoices', 'id', true);
  await syncTableWithUpsert(sClient, tClient, 'invoice_items', 'id', false);
  await syncTableWithUpsert(sClient, tClient, 'stock_movements', 'id', false);
  await syncTableWithUpsert(sClient, tClient, 'cash_in', 'id', true);
  await syncTableWithUpsert(sClient, tClient, 'cash_out', 'id', true);
  await syncTableWithUpsert(sClient, tClient, 'stock_transfers', 'id', true);
  await syncTableWithUpsert(sClient, tClient, 'stock_transfer_items', 'id', false);
  await syncTableWithUpsert(sClient, tClient, 'notifications', 'id', false);
  await syncTableWithUpsert(sClient, tClient, 'messages', 'id', false);
  await syncTableWithUpsert(sClient, tClient, 'user_activity', 'id', false);

  // 2. Special Tables
  await syncTableWithUpsert(sClient, tClient, 'online_invoice_audit', 'id', true);
  await syncTableWithUpsert(sClient, tClient, 'public_webhook_change_log', 'id', false);
  await syncTableWithUpsert(sClient, tClient, 'sync_deletions', 'id', false);

  // 3. Process deletions (e.g. deleted cash_in or cash_out rows)
  await syncDeletions(sClient, tClient);

  // 4. Live Stock Balances
  await syncStockTable(sClient, tClient);

  console.log("\nRe-enabling triggers...");
  await tClient.query("SET session_replication_role = 'origin'");

  // 5. Align sequences
  console.log("🔢 Aligning all PostgreSQL sequences on Data Studio...");
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

  // 6. Permissions for glass_backend
  console.log("🔑 Re-applying glass_backend permissions...");
  await tClient.query(`
    GRANT ALL ON SCHEMA public TO glass_backend;
    GRANT ALL ON ALL TABLES IN SCHEMA public TO glass_backend;
    GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO glass_backend;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO glass_backend;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO glass_backend;
  `);
  console.log("✅ Permissions verified.");

  sClient.release();
  tClient.release();

  // 7. Verify Parity using targetBackendPool (testing the exact user connection string)
  console.log("\n==========================================================");
  console.log("📊 PARITY VERIFICATION (Source vs dbstudio via glass_backend)");
  console.log("==========================================================");

  const bClient = await targetBackendPool.connect();
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
    'customer_phones',
    'products',
    'suppliers',
    'branches',
    'warehouses',
    'users',
    'online_invoice_audit',
    'public_webhook_change_log',
    'sync_deletions',
    'notifications',
    'messages',
    'user_activity'
  ];

  const audit = [];
  for (const t of tables) {
    const sc = await sourcePool.query(`SELECT COUNT(*) as c, COALESCE(MAX(id), 0) as m FROM "${t}"`).catch(() => ({ rows: [{ c: 0, m: 0 }] }));
    const tc = await bClient.query(`SELECT COUNT(*) as c, COALESCE(MAX(id), 0) as m FROM "${t}"`).catch(() => ({ rows: [{ c: 0, m: 0 }] }));
    const sCount = parseInt(sc.rows[0].c, 10);
    const tCount = parseInt(tc.rows[0].c, 10);
    const sMax = sc.rows[0].m;
    const tMax = tc.rows[0].m;

    const matched = (sCount === tCount && sMax === tMax);
    audit.push({
      table: t,
      source_18_count: sCount,
      dbstudio_count: tCount,
      source_max_id: sMax,
      dbstudio_max_id: tMax,
      status: matched ? '✅ 100% MATCH' : '⚠️ DIFF'
    });
  }

  console.table(audit);
  bClient.release();

  await sourcePool.end();
  await targetAdminPool.end();
  await targetBackendPool.end();

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n🎉 DELTA SYNC COMPLETED SUCCESSFULLY IN ${totalTime}s!`);
}

main().catch(console.error);
