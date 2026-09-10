require('dotenv').config();
const { localPool } = require('./db.js');
async function run() {
  try {
    const res = await localPool.query(`
      SELECT pg_terminate_backend(pid) 
      FROM pg_stat_activity 
      WHERE pid <> pg_backend_pid() 
        AND datname = current_database();
    `);
    console.log('Killed all other connections:', res.rows.length);
  } catch (e) {
    console.error('Error:', e);
  }
  process.exit(0);
}
run();
