require('dotenv').config();
const pool = require('../db');

async function testAbdullahs() {
  try {
    const res = await pool.query(`
      SELECT customer_name, SUM(total) as t, SUM(paid_amount) as p 
      FROM invoices 
      WHERE customer_name LIKE '%عبدالله%' AND branch_id = 1 
      GROUP BY customer_name;
    `);
    console.table(res.rows);
    process.exit(0);
  } catch(e) {
    console.error(e);
    process.exit(1);
  }
}

testAbdullahs();
