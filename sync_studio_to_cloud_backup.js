const { Pool } = require('pg');
const fs = require('fs');
require('dotenv').config();

// Primary: Data Studio (Where new live transactions are saved)
const studioPool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgresql://glass_backend:SecGlass_2026_Postgres_HA@dbstudio.hg-alshour.online:5432/glass_system",
  max: 3,
  connectionTimeoutMillis: 15000
});

// Backup: AWS Cloud Server (Standby mirror kept updated)
const cloudBackupPool = new Pool({
  host: process.env.BACKUP_DB_HOST || '18.185.48.10',
  port: Number(process.env.BACKUP_DB_PORT || 5432),
  user: process.env.BACKUP_DB_USER || 'glass_admin',
  password: process.env.BACKUP_DB_PASSWORD || '@Hadysalah1',
  database: process.env.BACKUP_DB_NAME || 'glass_system',
  ssl: process.env.BACKUP_DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  max: 3,
  connectionTimeoutMillis: 15000
});

studioPool.on('error', (err) => console.error('⚠️ studioPool error (handled):', err.message));
cloudBackupPool.on('error', (err) => console.error('⚠️ cloudBackupPool error (handled):', err.message));

const BATCH_SIZE = 500;
const LOCK_FILE = '/tmp/glass_standby_sync.lock';

function log(msg) {
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
  console.log(`[${timestamp}] ${msg}`);
}

async function getColumns(client, table) {
  const colsRes = await client.query(`
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = $1
    ORDER BY ordinal_position
  `, [table]);
  return colsRes.rows;
}

async function getPrimaryKeys(client, table) {
  const res = await client.query(`
    SELECT kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu 
      ON tc.constraint_name = kcu.constraint_name 
      AND tc.table_schema = kcu.table_schema
    WHERE tc.table_schema = 'public' 
      AND tc.table_name = $1
      AND tc.constraint_type = 'PRIMARY KEY'
    ORDER BY kcu.ordinal_position
  `, [table]);
  return res.rows.map(r => r.column_name);
}

function prepareParam(val, dataType) {
  if (val === null || val === undefined) return null;
  if (dataType === 'json' || dataType === 'jsonb' || (typeof val === 'object' && !(val instanceof Date))) {
    return JSON.stringify(val);
  }
  return val;
}

async function upsertRows(backupClient, table, colDefs, rows, pkCols = ['id']) {
  if (rows.length === 0) return 0;

  const columns = colDefs.map(c => c.column_name);
  const colList = columns.map(c => `"${c}"`).join(', ');
  const updateList = columns
    .filter(c => !pkCols.includes(c))
    .map(c => `"${c}" = EXCLUDED."${c}"`)
    .join(', ');

  const conflictTarget = pkCols.map(c => `"${c}"`).join(', ');

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

    const conflictClause = updateList.length > 0 && conflictTarget.length > 0
      ? `ON CONFLICT (${conflictTarget}) DO UPDATE SET ${updateList}`
      : conflictTarget.length > 0 
        ? `ON CONFLICT (${conflictTarget}) DO NOTHING`
        : '';

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

async function syncTableFull(sClient, bClient, table) {
  const colDefs = await getColumns(sClient, table);
  if (colDefs.length === 0) return { table, synced: 0, cleaned: 0 };

  const pkCols = await getPrimaryKeys(sClient, table);
  const colList = colDefs.map(c => `"${c.column_name}"`).join(', ');

  // 1. Tables without PK (e.g. test_migration, products_backup_1785674162020)
  if (pkCols.length === 0) {
    const pCountRes = await sClient.query(`SELECT count(*) FROM "${table}"`);
    const bCountRes = await bClient.query(`SELECT count(*) FROM "${table}"`);
    const pCount = parseInt(pCountRes.rows[0].count, 10);
    const bCount = parseInt(bCountRes.rows[0].count, 10);

    if (pCount !== bCount) {
      log(`   ⚠️ Table ${table} (no PK) count mismatch (${pCount} vs ${bCount}). Refreshing table...`);
      await bClient.query(`TRUNCATE TABLE "${table}"`);
      const allRows = (await sClient.query(`SELECT ${colList} FROM "${table}"`)).rows;
      await upsertRows(bClient, table, colDefs, allRows, []);
      return { table, synced: allRows.length, cleaned: bCount };
    }
    return { table, synced: 0, cleaned: 0 };
  }

  // 2. Single PK ('id' or 'key')
  if (pkCols.length === 1) {
    const pk = pkCols[0];
    const hasUpdatedAt = colDefs.some(c => c.column_name === 'updated_at');

    // Fetch ONLY PK column to find diffs (lightweight & ultra-fast)
    const pIdsRes = await sClient.query(`SELECT "${pk}" FROM "${table}"`);
    const bIdsRes = await bClient.query(`SELECT "${pk}" FROM "${table}"`);

    const pIdSet = new Set(pIdsRes.rows.map(r => r[pk]));
    const bIdSet = new Set(bIdsRes.rows.map(r => r[pk]));

    const missingIds = pIdsRes.rows.map(r => r[pk]).filter(id => !bIdSet.has(id));
    const orphanIds = bIdsRes.rows.map(r => r[pk]).filter(id => !pIdSet.has(id));

    let synced = 0;
    if (missingIds.length > 0) {
      for (let i = 0; i < missingIds.length; i += BATCH_SIZE) {
        const chunk = missingIds.slice(i, i + BATCH_SIZE);
        const missingRows = (await sClient.query(`SELECT ${colList} FROM "${table}" WHERE "${pk}" = ANY($1)`, [chunk])).rows;
        await upsertRows(bClient, table, colDefs, missingRows, pkCols);
        synced += missingRows.length;
      }
    }

    // Refresh recently updated rows if updated_at exists
    if (hasUpdatedAt) {
      const updatedRows = (await sClient.query(`
        SELECT ${colList} FROM "${table}" 
        WHERE updated_at >= NOW() - INTERVAL '6 hours'
      `)).rows;
      if (updatedRows.length > 0) {
        await upsertRows(bClient, table, colDefs, updatedRows, pkCols);
      }
    }

    // Clean orphan rows on backup (except server_metrics which stores local host telemetry)
    let cleaned = 0;
    if (orphanIds.length > 0 && table !== 'server_metrics') {
      for (let i = 0; i < orphanIds.length; i += BATCH_SIZE) {
        const chunk = orphanIds.slice(i, i + BATCH_SIZE);
        const delRes = await bClient.query(`DELETE FROM "${table}" WHERE "${pk}" = ANY($1)`, [chunk]);
        cleaned += delRes.rowCount;
      }
    }

    return { table, synced, cleaned };
  }

  // 3. Composite PK (e.g. stock, conversation_participants)
  if (pkCols.length > 1) {
    if (table === 'conversation_participants') {
      const pRows = (await sClient.query(`SELECT ${colList} FROM "${table}"`)).rows;
      await upsertRows(bClient, table, colDefs, pRows, pkCols);
      return { table, synced: pRows.length, cleaned: 0 };
    }

    if (table === 'stock') {
      // Incremental stock sync: products that moved recently
      const recentMovedRes = await sClient.query(`
        SELECT DISTINCT product_id 
        FROM stock_movements 
        WHERE created_at >= NOW() - INTERVAL '6 hours'
      `);
      const pids = recentMovedRes.rows.map(r => r.product_id);

      let stockRows = [];
      if (pids.length > 0) {
        stockRows = (await sClient.query(`SELECT ${colList} FROM stock WHERE product_id = ANY($1)`, [pids])).rows;
      } else {
        const pCount = parseInt((await sClient.query('SELECT count(*) FROM stock')).rows[0].count, 10);
        const bCount = parseInt((await bClient.query('SELECT count(*) FROM stock')).rows[0].count, 10);
        if (pCount !== bCount) {
          stockRows = (await sClient.query(`SELECT ${colList} FROM stock`)).rows;
        }
      }

      if (stockRows.length > 0) {
        await upsertRows(bClient, table, colDefs, stockRows, pkCols);
      }
      return { table, synced: stockRows.length, cleaned: 0 };
    }
  }

  return { table, synced: 0, cleaned: 0 };
}

async function alignAllSequences(bClient) {
  const seqsRes = await bClient.query(`
    SELECT sequence_name 
    FROM information_schema.sequences 
    WHERE sequence_schema = 'public'
  `);

  let count = 0;
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
      count++;
    } catch (e) {}
  }
  return count;
}

async function runBackupSync(options = {}) {
  const isFull = options.full || process.argv.includes('--full');
  const startTime = Date.now();

  log(`🔁 Starting ${isFull ? 'FULL 4-HOUR' : 'INCREMENTAL'} Backup Sync: Data Studio ➔ AWS Cloud Standby...`);

  const sClient = await studioPool.connect();
  const bClient = await cloudBackupPool.connect();

  try {
    await bClient.query("SET session_replication_role = 'replica'");

    const tablesRes = await sClient.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);
    const allTables = tablesRes.rows.map(r => r.table_name);

    let totalSynced = 0;
    let totalCleaned = 0;

    if (isFull) {
      for (const t of allTables) {
        try {
          const res = await syncTableFull(sClient, bClient, t);
          if (res.synced > 0 || res.cleaned > 0) {
            log(`   └─ [${t}] Synced: +${res.synced}, Cleaned orphans: -${res.cleaned}`);
            totalSynced += res.synced;
            totalCleaned += res.cleaned;
          }
        } catch (err) {
          log(`   ❌ Error syncing ${t}: ${err.message}`);
        }
      }
    } else {
      const activeTables = [
        'invoices', 'invoice_items', 'cash_in', 'cash_out',
        'customers', 'customer_phones', 'stock_movements',
        'stock_transfers', 'stock_transfer_items', 'messages',
        'notifications', 'user_activity', 'payroll_advances'
      ];

      for (const t of activeTables) {
        if (allTables.includes(t)) {
          try {
            const res = await syncTableFull(sClient, bClient, t);
            if (res.synced > 0 || res.cleaned > 0) {
              log(`   └─ [${t}] Synced: +${res.synced}, Cleaned: -${res.cleaned}`);
              totalSynced += res.synced;
              totalCleaned += res.cleaned;
            }
          } catch (err) {
            log(`   ❌ Error syncing ${t}: ${err.message}`);
          }
        }
      }

      if (totalSynced > 0 || totalCleaned > 0) {
        await syncTableFull(sClient, bClient, 'stock');
      }
    }

    await bClient.query("SET session_replication_role = 'origin'");

    const seqCount = await alignAllSequences(bClient);
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    log(`✅ ${isFull ? 'FULL' : 'INCREMENTAL'} Sync Completed in ${duration}s.`);
    log(`   Total tables verified: ${allTables.length} | Synced: ${totalSynced} | Cleaned: ${totalCleaned} | Sequences aligned: ${seqCount}`);

    return { ok: true, isFull, totalTables: allTables.length, totalSynced, totalCleaned, duration };

  } finally {
    sClient.release();
    bClient.release();
  }
}

function acquireLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const pid = fs.readFileSync(LOCK_FILE, 'utf8').trim();
      log(`ℹ️  Sync already running (PID: ${pid}). Exiting to prevent overlap.`);
      return false;
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid));
    return true;
  } catch (e) {
    return true;
  }
}

function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch (e) {}
}

if (require.main === module) {
  if (!acquireLock()) {
    process.exit(0);
  }

  runBackupSync()
    .then(async () => {
      releaseLock();
      await studioPool.end();
      await cloudBackupPool.end();
      process.exit(0);
    })
    .catch(async (err) => {
      releaseLock();
      console.error("❌ Standby sync fatal error:", err);
      await studioPool.end();
      await cloudBackupPool.end();
      process.exit(1);
    });
}

module.exports = { runBackupSync };
