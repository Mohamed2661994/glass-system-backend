require('dotenv').config();
const pool = require('../db');

async function checkAbdullahTimes() {
  try {
    const res = await pool.query(`
      SELECT id, created_at, updated_at, total, paid_amount 
      FROM invoices 
      WHERE customer_name = 'عبدالله عبدالستار' AND branch_id = 1;
    `);
    console.table(res.rows);
    process.exit(0);
  } catch(e) {
    console.error(e);
    process.exit(1);
  }
}

checkAbdullahTimes();
