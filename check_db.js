const { Pool } = require('pg');
const pool = new Pool({
  user: 'glass_admin',
  host: 'db.hg-alshour.online',
  database: 'glass_system',
  password: '@Hadysalah1',
  port: 5432,
});
pool.query('SELECT id, invoice_type, branch_id, customer_name, invoice_date, created_at FROM invoices ORDER BY id DESC LIMIT 5')
  .then(res => {
    console.table(res.rows);
    pool.end();
  })
  .catch(err => {
    console.error(err);
    pool.end();
  });
