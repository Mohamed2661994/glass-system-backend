require('dotenv').config();
const { localPool } = require('./db.js');
async function run() {
  try {
    const res = await localPool.query(`
      SELECT pg_stat_activity.pid, pg_stat_activity.query, pg_stat_activity.state, pg_class.relname, pg_locks.mode
      FROM pg_stat_activity
      JOIN pg_locks ON pg_stat_activity.pid = pg_locks.pid
      JOIN pg_class ON pg_locks.relation = pg_class.oid
      WHERE pg_class.relname = 'manufacturers'
    `);
    console.log(JSON.stringify(res.rows, null, 2));
  } catch (e) {
    console.error('Error:', e);
  }
  process.exit(0);
}
run();
