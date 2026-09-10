require('dotenv').config();
const { localPool } = require('./db.js');
async function run() {
  try {
    // Kill all ALTER TABLE queries
    await localPool.query(`
      SELECT pg_terminate_backend(pid) 
      FROM pg_stat_activity 
      WHERE pid <> pg_backend_pid() 
        AND query ILIKE '%ALTER TABLE manufacturers%';
    `);
    console.log('Killed all ALTER TABLE queries');
    
    // Now add the column immediately
    await localPool.query("ALTER TABLE manufacturers ADD COLUMN IF NOT EXISTS discount_base VARCHAR(20) NOT NULL DEFAULT 'purchase'");
    console.log('Successfully added discount_base to Local DB!');
  } catch (e) {
    console.error('Error:', e);
  }
  process.exit(0);
}
run();
