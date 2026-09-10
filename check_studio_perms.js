const { Pool } = require('pg');

const pool = new Pool({
  connectionString: "postgresql://glass_backend:SecGlass_2026_Postgres_HA@dbstudio.hg-alshour.online:5432/glass_system",
  max: 2,
  connectionTimeoutMillis: 10000
});

async function checkPerms() {
  const client = await pool.connect();
  try {
    const isSuper = await client.query(`SELECT current_setting('is_superuser') as is_super`);
    console.log("Is glass_backend superuser?", isSuper.rows[0].is_super);
    
    try {
      await client.query("SET session_replication_role = 'replica'");
      console.log("Can SET session_replication_role = 'replica': YES");
      await client.query("SET session_replication_role = 'origin'");
    } catch (e) {
      console.log("Can SET session_replication_role = 'replica': NO -", e.message);
    }
  } catch (err) {
    console.error("Error:", err);
  } finally {
    client.release();
    await pool.end();
  }
}

checkPerms();
