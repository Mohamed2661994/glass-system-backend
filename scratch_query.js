const { Pool } = require('pg');

const pool = new Pool({
  host: 'db.hg-alshour.online',
  port: 5432,
  user: 'glass_admin',
  password: '@Hadysalah1',
  database: 'glass_system',
  ssl: false
});

async function run() {
  try {
    const startDate = '2026-08-02';
    const endDate = '2026-09-01';

    const expensesResult = await pool.query(`
      SELECT name, SUM(amount) as total_amount, COUNT(id) as freq
      FROM cash_out
      WHERE transaction_date >= $1 AND transaction_date <= $2
        AND entry_type = 'expense'
      GROUP BY name
      ORDER BY total_amount DESC;
    `, [startDate, endDate]);

    console.table(expensesResult.rows);

  } catch(e) {
    console.error(e);
  } finally {
    pool.end();
  }
}
run();
