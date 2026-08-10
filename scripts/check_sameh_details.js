require('dotenv').config();
const pool = require('../db');

async function checkSameh() {
  try {
    const customer = "سامح سلامة";
    const branch = 1;

    console.log(`Checking details for ${customer} in Branch ${branch}...`);

    const invoices = await pool.query(
      `SELECT id, invoice_date, total, paid_amount, remaining_amount, previous_balance, additional_amount, is_void, movement_type, invoice_type
       FROM invoices 
       WHERE customer_name = $1 AND branch_id = $2
       ORDER BY invoice_date ASC, id ASC`,
      [customer, branch]
    );

    console.log("--- INVOICES ---");
    console.table(invoices.rows);

    const payments = await pool.query(
      `SELECT id, created_at, amount, source_type, cash_in_number
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

checkSameh();
