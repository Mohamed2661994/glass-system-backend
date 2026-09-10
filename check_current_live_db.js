const { Pool } = require('pg');

async function checkRenderHealth() {
  console.log('=== 1. CHECKING LIVE BACKEND (/health) ===');
  try {
    const res = await fetch('https://glass-system-backend.onrender.com/health');
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Fetch error:', err.message);
  }
}

async function checkPgActivity(pool, label) {
  console.log(`\n=== 2. CHECKING PG_STAT_ACTIVITY ON ${label} ===`);
  try {
    const res = await pool.query(`
      SELECT pid, usename, client_addr, application_name, state, backend_start, query_start, LEFT(query, 60) as query_sample
      FROM pg_stat_activity 
      WHERE datname = 'glass_system' AND usename != 'postgres'
      ORDER BY backend_start DESC
    `);
    console.log(`Total Connections on ${label}:`, res.rows.length);
    for (const r of res.rows.slice(0, 10)) {
      console.log(`  PID: ${r.pid} | User: ${r.usename} | IP: ${r.client_addr} | State: ${r.state} | Start: ${r.backend_start} | Query: ${r.query_sample}`);
    }
  } catch (err) {
    console.error(`DB query error on ${label}:`, err.message);
  }
}

async function checkLatestTransactions(pool, label) {
  console.log(`\n=== 3. LATEST TRANSACTIONS ON ${label} ===`);
  try {
    const inv = await pool.query('SELECT id, total, customer_name, updated_at FROM invoices ORDER BY id DESC LIMIT 3');
    const cin = await pool.query('SELECT id, amount, customer_name, updated_at FROM cash_in ORDER BY id DESC LIMIT 3');
    const cout = await pool.query('SELECT id, amount, name, created_at, updated_at FROM cash_out ORDER BY id DESC LIMIT 3');
    const act = await pool.query('SELECT id, username, action, ip_address, created_at FROM user_activity ORDER BY id DESC LIMIT 3');
    console.log('Latest Invoices:', inv.rows);
    console.log('Latest Cash In:', cin.rows);
    console.log('Latest Cash Out:', cout.rows);
    console.log('Latest Activity:', act.rows);
  } catch (err) {
    console.error(`Transaction query error on ${label}:`, err.message);
  }
}

async function run() {
  await checkRenderHealth();

  const studioPool = new Pool({
    connectionString: 'postgresql://glass_backend:SecGlass_2026_Postgres_HA@dbstudio.hg-alshour.online:5432/glass_system',
    connectionTimeoutMillis: 5000
  });

  const cloudPool = new Pool({
    host: '18.185.48.10',
    port: 5432,
    user: 'glass_admin',
    password: '@Hadysalah1',
    database: 'glass_system',
    connectionTimeoutMillis: 5000
  });

  await checkPgActivity(studioPool, 'DATA STUDIO (dbstudio.hg-alshour.online)');
  await checkPgActivity(cloudPool, 'AWS CLOUD (18.185.48.10)');

  await checkLatestTransactions(studioPool, 'DATA STUDIO');
  await checkLatestTransactions(cloudPool, 'AWS CLOUD');

  await studioPool.end();
  await cloudPool.end();
}

run().catch(console.error);
