const { Pool } = require('pg');
const pool = new Pool({
  user: 'glass_admin',
  host: 'db.hg-alshour.online',
  database: 'glass_system',
  password: '@Hadysalah1',
  port: 5432,
});
pool.query('SELECT id, username, branch_id, role FROM users')
  .then(res => {
    console.table(res.rows);
    pool.end();
  })
  .catch(err => {
    console.error(err);
    pool.end();
  });
