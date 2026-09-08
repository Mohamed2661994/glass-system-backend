const { Pool } = require('pg');
require('dotenv').config();

// Primary: Data Studio (Where new live transactions will be saved)
const studioPool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgresql://glass_backend:SecGlass_2026_Postgres_HA@dbstudio.hg-alshour.online:5432/glass_system",
  max: 3,
  connectionTimeoutMillis: 10000
});

// Backup: AWS Cloud Server (Will be kept continuously updated in near-realtime)
const cloudBackupPool = new Pool({
  host: process.env.BACKUP_DB_HOST || '18.185.48.10',
  port: Number(process.env.BACKUP_DB_PORT || 5432),
  user: process.env.BACKUP_DB_USER || 'glass_admin',
  password: process.env.BACKUP_DB_PASSWORD || '@Hadysalah1',
  database: process.env.BACKUP_DB_NAME || 'glass_system',
  max: 3,
  connectionTimeoutMillis: 10000
});

studioPool.on('error', (err) => console.error('⚠️ studioPool error (handled):', err.message));
cloudBackupPool.on('error', (err) => console.error('⚠️ cloudBackupPool error (handled):', err.message));

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

async function upsertRows(backupClient, table, colDefs, rows, idCol = 'id') {
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

    await backupClient.query(sql, insertParams);
    offset += batch.length;
  }
  return rows.length;
}

async function insertRowsDoNothing(backupClient, table, colDefs, rows, idCol = 'id') {
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

    await backupClient.query(sql, insertParams);
    offset += batch.length;
  }
  return rows.length;
}

async function syncTableToBackup(sClient, bClient, table, idCol = 'id', checkUpdatedAt = true) {
  const colDefs = await getColumns(sClient, table);
  const colNames = colDefs.map(c => c.column_name);
  const hasUpdatedAt = checkUpdatedAt && colNames.includes('updated_at');

  const maxRes = await bClient.query(`SELECT COALESCE(MAX("${idCol}"), 0) as max_id FROM "${table}"`);
  const backupMaxId = maxRes.rows[0].max_id;

  const colList = colNames.map(c => `"${c}"`).join(', ');
  let query = `SELECT ${colList} FROM "${table}" WHERE "${idCol}" > $1`;
  const params = [backupMaxId];

  if (hasUpdatedAt) {
    query += ` OR updated_at >= NOW() - INTERVAL '2 hours'`;
  }
  query += ` ORDER BY "${idCol}" ASC`;

  const sRows = (await sClient.query(query, params)).rows;
  if (sRows.length === 0) return 0;

  const count = await upsertRows(bClient, table, colDefs, sRows, idCol);
  return count;
}

async function syncLiveStockToBackup(sClient, bClient) {
  const colDefs = await getColumns(sClient, 'stock');
  const columns = colDefs.map(c => c.column_name);
  const colList = columns.map(c => `"${c}"`).join(', ');

  const stockRows = await sClient.query(`SELECT ${colList} FROM stock`);
  await bClient.query(`TRUNCATE TABLE stock`);

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

    await bClient.query(`
      INSERT INTO stock (${colList})
      VALUES ${valuePlaceholders.join(', ')}
    `, insertParams);
    offset += batch.length;
  }
  return stockRows.rows.length;
}

async function runBackupSync() {
  const startTime = Date.now();
  console.log("🔁 Starting Continuous Backup Sync: Data Studio ➔ AWS Cloud Standby...");

  const sClient = await studioPool.connect();
  const bClient = await cloudBackupPool.connect();

  try {
    await bClient.query("SET session_replication_role = 'replica'");

    const tables = [
      { name: 'customers', checkUpdated: true },
      { name: 'customer_phones', checkUpdated: false },
      { name: 'invoices', checkUpdated: true },
      { name: 'invoice_items', checkUpdated: false },
      { name: 'stock_movements', checkUpdated: false },
      { name: 'cash_in', checkUpdated: true },
      { name: 'cash_out', checkUpdated: true },
      { name: 'stock_transfers', checkUpdated: true },
      { name: 'stock_transfer_items', checkUpdated: false },
      { name: 'online_invoice_audit', checkUpdated: true },
      { name: 'public_webhook_change_log', checkUpdated: false },
      { name: 'user_activity', checkUpdated: false },
      { name: 'notifications', checkUpdated: false },
      { name: 'messages', checkUpdated: false }
    ];

    let totalSynced = 0;
    for (const t of tables) {
      const cnt = await syncTableToBackup(sClient, bClient, t.name, 'id', t.checkUpdated);
      if (cnt > 0) {
        console.log(`   └─ Synced ${cnt} rows to ${t.name} on backup.`);
        totalSynced += cnt;
      }
    }

    // Refresh stock if any stock movements or invoices occurred
    if (totalSynced > 0) {
      await syncLiveStockToBackup(sClient, bClient);
      console.log(`   └─ Refreshed stock quantities on backup.`);
    }

    await bClient.query("SET session_replication_role = 'origin'");

    // Align sequences on backup
    const seqsRes = await bClient.query(`
      SELECT sequence_name 
      FROM information_schema.sequences 
      WHERE sequence_schema = 'public'
    `);

    for (const row of seqsRes.rows) {
      const seq = row.sequence_name;
      const candidateTable = seq.replace(/_id_seq$/, '').replace(/_seq$/, '');
      try {
        const maxRes = await bClient.query(`
          SELECT COALESCE(MAX(id), 1) as max_val 
          FROM "${candidateTable}"
        `);
        const nextVal = parseInt(maxRes.rows[0].max_val, 10);
        await bClient.query(`SELECT setval('"${seq}"', $1, true)`, [nextVal]);
      } catch (e) {}
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`✅ Backup Sync completed in ${duration}s. (Total records updated: ${totalSynced})`);
    return { ok: true, totalSynced, duration };

  } finally {
    sClient.release();
    bClient.release();
  }
}

let isSyncInProgress = false;

async function safeRunBackupSync() {
  if (isSyncInProgress) {
    console.log("ℹ️  Standby backup sync already in progress, skipping tick.");
    return { ok: true, skipped: true };
  }
  isSyncInProgress = true;
  try {
    return await runBackupSync();
  } finally {
    isSyncInProgress = false;
  }
}

// If run directly from CLI
if (require.main === module) {
  runBackupSync()
    .then(async () => {
      await studioPool.end();
      await cloudBackupPool.end();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error("❌ Backup sync error:", err);
      await studioPool.end();
      await cloudBackupPool.end();
      process.exit(1);
    });
}

module.exports = { runBackupSync, safeRunBackupSync };
