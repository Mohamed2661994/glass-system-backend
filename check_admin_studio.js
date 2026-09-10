const { Pool } = require('pg');

const pool = new Pool({
  host: 'dbstudio.hg-alshour.online',
  port: 5432,
  user: 'glass_admin',
  password: '@Hadysalah1',
  database: 'glass_system',
  max: 2,
  connectionTimeoutMillis: 10000
});

async function checkAdmin() {
  try {
    const client = await pool.connect();
    const isSuper = await client.query(`SELECT current_setting('is_superuser') as is_super`);
    console.log("glass_admin is_superuser on dbstudio:", isSuper.rows[0].is_super);
    client.release();
  } catch (e) {
    console.error("Admin connect failed:", e.message);
  } finally {
    await pool.end();
  }
}

checkAdmin();
