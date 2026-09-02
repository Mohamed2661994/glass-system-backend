const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/glass_system' });

async function check() {
  try {
    const invoices = await pool.query('SELECT count(*) FROM invoices WHERE created_by = 14');
    const cashIn = await pool.query('SELECT count(*) FROM cash_in WHERE created_by = 14');
    const cashOut = await pool.query('SELECT count(*) FROM cash_out WHERE created_by = 14');
    console.log(Invoices: $);
    console.log(Cash In: $);
    console.log(Cash Out: $);
  } catch(e) {
    console.error(e);
  } finally {
    pool.end();
  }
}
check();
