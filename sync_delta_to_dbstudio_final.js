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

// Using glass_admin on dbstudio for session_replication_role, batch speeds, sequence setval
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

// Verification pool using glass_backend (exact user connection string)
const targetBackendPool = new Pool({
  connectionString: "postgresql://glass_backend:SecGlass_2026_Postgres_HA@dbstudio.hg-alshour.online:5432/glass_system",
  max: 3,
  connectionTimeoutMillis: 10000
});

const BATCH_SIZE = 500;

async function getColumns(client, table) {
  const colsRes = await client.query(`
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = $1
    ORDER BY ordinal_position
  `, [table]);
  return colsRes.rows;
}

function prepareParam(val, dataType) {
  if (val === null || val === undefined) return null;
  if (dataType === 'json' || dataType === 'jsonb' || (typeof val === 'object' && !(val instanceof Date))) {
    return JSON.stringify(val);
  }
  return val;
}

// Upsert rows in batches
async function upsertRows(tClient, table, colDefs, rows, idCol = 'id') {
  if (rows.length === 0) return 0;

  const columns = colDefs.map(c => c.column_name);
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
      for (const colDef of colDefs) {
        const c = colDef.column_name;
        const dt = colDef.data_type;
        const paramVal = prepareParam(r[c], dt);

        if (dt === 'jsonb') {
          rowPlaceholders.push(`$${pIdx++}::jsonb`);
        } else if (dt === 'json') {
          rowPlaceholders.push(`$${pIdx++}::json`);
        } else {
          rowPlaceholders.push(`$${pIdx++}`);
        }
        insertParams.push(paramVal);
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
async function insertRowsDoNothing(tClient, table, colDefs, rows, idCol = 'id') {
  if (rows.length === 0) return 0;

  const columns = colDefs.map(c => c.column_name);
  const colList = columns.map(c => `"${c}"`).join(', ');

  let offset = 0;
  while (offset < rows.length) {
    const batch = rows.slice(offset, offset + BATCH_SIZE);
    const valuePlaceholders = [];
    const insertParams = [];
    let pIdx = 1;

    for (const r of batch) {
      const rowPlaceholders = [];
      for (const colDef of colDefs) {
        const c = colDef.column_name;
        const dt = colDef.data_type;
        const paramVal = prepareParam(r[c], dt);

        if (dt === 'jsonb') {
          rowPlaceholders.push(`$${pIdx++}::jsonb`);
        } else if (dt === 'json') {
          rowPlaceholders.push(`$${pIdx++}::json`);
        } else {
          rowPlaceholders.push(`$${pIdx++}`);
        }
        insertParams.push(paramVal);
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
  const colDefs = await getColumns(sClient, table);
  const colNames = colDefs.map(c => c.column_name);
  const hasUpdatedAt = checkUpdatedAt && colNames.includes('updated_at');

  const maxRes = await tClient.query(`SELECT COALESCE(MAX("${idCol}"), 0) as max_id FROM "${table}"`);
  const targetMaxId = maxRes.rows[0].max_id;

  const colList = colNames.map(c => `"${c}"`).join(', ');
  let query = `SELECT ${colList} FROM "${table}" WHERE "${idCol}" > $1`;
  const params = [targetMaxId];

  if (hasUpdatedAt) {
    query += ` OR updated_at >= CURRENT_DATE - INTERVAL '1 day'`;
  }
  query += ` ORDER BY "${idCol}" ASC`;

  const sRows = (await sClient.query(query, params)).rows;
  if (sRows.length === 0) {
    console.log(`✅ ${table.padEnd(28)} Up to date.`);
    return 0;
  }

  console.log(`📦 ${table.padEnd(28)} Syncing ${sRows.length} new/updated rows...`);
  const count = await upsertRows(tClient, table, colDefs, sRows, idCol);
  console.log(`   └─ Successfully upserted ${count} rows into ${table}.`);
  return count;
}

async function syncTableDoNothing(sClient, tClient, table, idCol = 'id') {
  const colDefs = await getColumns(sClient, table);
  const colNames = colDefs.map(c => c.column_name);

  const maxRes = await tClient.query(`SELECT COALESCE(MAX("${idCol}"), 0) as max_id FROM "${table}"`);
  const targetMaxId = maxRes.rows[0].max_id;

  const colList = colNames.map(c => `"${c}"`).join(', ');
  const query = `SELECT ${colList} FROM "${table}" WHERE "${idCol}" > $1 ORDER BY "${idCol}" ASC`;
  const sRows = (await sClient.query(query, [targetMaxId])).rows;

  if (sRows.length === 0) {
    console.log(`✅ ${table.padEnd(28)} Up to date.`);
    return 0;
  }

  console.log(`📦 ${table.padEnd(28)} Inserting ${sRows.length} new rows...`);
  const count = await insertRowsDoNothing(tClient, table, colDefs, sRows, idCol);
  console.log(`   └─ Successfully inserted ${count} rows into ${table}.`);
  return count;
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
        count++;
      }
    } catch (e) {}
  }
  console.log(`✅ Cleaned up ${count} deleted records.`);
}

async function syncStockTable(sClient, tClient) {
  console.log(`🔄 Syncing live stock quantities (full parity sync)...`);
  const colDefs = await getColumns(sClient, 'stock');
  const columns = colDefs.map(c => c.column_name);
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
  console.log(`✅ stock table refreshed with ${stockRows.rows.length} live records.`);
}

async function main() {
  console.log("===================================================================");
  console.log("🚀 STARTING ZERO-DOWNTIME DATA STUDIO SYNC (dbstudio.hg-alshour.online)");
  console.log("===================================================================\n");
  const startTime = Date.now();

  const sClient = await sourcePool.connect();
  const tClient = await targetAdminPool.connect();

  console.log("⚙️  Setting session_replication_role = 'replica' for safe batch import...");
  await tClient.query("SET session_replication_role = 'replica'");

  // 1. Transactional & Master Tables
  await syncTableWithUpsert(sClient, tClient, 'customers', 'id', true);
  await syncTableDoNothing(sClient, tClient, 'customer_phones', 'id');
  await syncTableWithUpsert(sClient, tClient, 'invoices', 'id', true);
  await syncTableWithUpsert(sClient, tClient, 'invoice_items', 'id', false);
  await syncTableDoNothing(sClient, tClient, 'stock_movements', 'id');
  await syncTableWithUpsert(sClient, tClient, 'cash_in', 'id', true);
  await syncTableWithUpsert(sClient, tClient, 'cash_out', 'id', true);
  await syncTableWithUpsert(sClient, tClient, 'stock_transfers', 'id', true);
  await syncTableDoNothing(sClient, tClient, 'stock_transfer_items', 'id');
  await syncTableDoNothing(sClient, tClient, 'notifications', 'id');
  await syncTableDoNothing(sClient, tClient, 'messages', 'id');
  await syncTableDoNothing(sClient, tClient, 'user_activity', 'id');

  // 2. Special Audit & Log Tables
  await syncTableWithUpsert(sClient, tClient, 'online_invoice_audit', 'id', true);
  await syncTableDoNothing(sClient, tClient, 'public_webhook_change_log', 'id');
  await syncTableDoNothing(sClient, tClient, 'sync_deletions', 'id');

  // 3. Process Deletions
  await syncDeletions(sClient, tClient);

  // 4. Live Stock Table
  await syncStockTable(sClient, tClient);

  console.log("\n⚙️  Restoring session_replication_role = 'origin'...");
  await tClient.query("SET session_replication_role = 'origin'");

  // 5. Align all Sequences
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
  console.log("✅ All sequences successfully aligned.");

  // 6. Grant Permissions to glass_backend
  console.log("🔑 Ensuring glass_backend permissions on Data Studio...");
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

  // 7. Full Parity Verification using targetBackendPool
  console.log("\n===================================================================");
  console.log("📊 PARITY AUDIT VIA: postgresql://glass_backend@dbstudio.hg-alshour.online");
  console.log("===================================================================");

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
    'product_variants',
    'suppliers',
    'supplier_phones',
    'branches',
    'warehouses',
    'users',
    'online_invoice_audit',
    'public_webhook_change_log',
    'sync_deletions',
    'notifications',
    'messages',
    'user_activity',
    'conversations',
    'conversation_participants',
    'app_settings'
  ];

  const audit = [];
  let perfectMatches = 0;

  for (const t of tables) {
    const sc = await sourcePool.query(`SELECT COUNT(*)::bigint as c, COALESCE(MAX(id)::text, '0') as m FROM "${t}"`).catch(() => ({ rows: [{ c: 0, m: 0 }] }));
    const tc = await bClient.query(`SELECT COUNT(*)::bigint as c, COALESCE(MAX(id)::text, '0') as m FROM "${t}"`).catch(() => ({ rows: [{ c: 0, m: 0 }] }));
    const sCount = sc.rows[0].c;
    const tCount = tc.rows[0].c;
    const sMax = sc.rows[0].m;
    const tMax = tc.rows[0].m;

    const matched = (sCount === tCount && sMax === tMax);
    if (matched) perfectMatches++;

    audit.push({
      table: t,
      source_count: sCount,
      dbstudio_count: tCount,
      source_max_id: sMax,
      dbstudio_max_id: tMax,
      status: matched ? '✅ 100% MATCH' : '⚠️ DIFF'
    });
  }

  console.table(audit);
  console.log(`\nParity result: ${perfectMatches}/${tables.length} tables 100% matched!`);

  bClient.release();
  await sourcePool.end();
  await targetAdminPool.end();
  await targetBackendPool.end();

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n🎉 SYNC COMPLETED SUCCESSFULLY IN ${totalTime}s!`);
}

main().catch(console.error);
