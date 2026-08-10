require('dotenv').config();
const pool = require('../db');

async function checkSamehCash() {
  try {
    const customer = "سامح سلامة";
    const branch = 1;

    const payments = await pool.query(
      `SELECT id, created_at, amount, source_type
       FROM cash_in 
       WHERE customer_name = $1 AND branch_id = $2
       ORDER BY created_at ASC`,
      [customer, branch]
    );

    console.log("--- PAYMENTS (CASH_IN) ---");
    console.table(payments.rows);

    process.exit(0);
  } catch(e) {
    console.error(e);
    process.exit(1);
  }
}

checkSamehCash();
