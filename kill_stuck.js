require('dotenv').config();
const { localPool } = require('./db.js');
async function run() {
  try {
    const res = await localPool.query(`
      SELECT pg_terminate_backend(pid) FROM pg_stat_activity 
      WHERE pid <> pg_backend_pid() AND state = 'active' AND query ILIKE '%ALTER TABLE manufacturers%';
    `);
    console.log('Killed stuck queries:', res.rows);
  } catch (e) {
    console.error('Error:', e);
  }
  process.exit(0);
}
run();
