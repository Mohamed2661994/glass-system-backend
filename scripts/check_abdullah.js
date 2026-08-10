require('dotenv').config();
const pool = require('../db');

async function evaluateAbdullah() {
  try {
    const customer = "عبدالله عبدالستار";

    console.log(`Checking details for ${customer} in Branch 1...`);

    const invoicesBranch1 = await pool.query(
      `SELECT id, invoice_date, total, paid_amount, remaining_amount, previous_balance, additional_amount, is_void, movement_type, invoice_type
       FROM invoices 
       WHERE customer_name = $1 AND branch_id = 1
       ORDER BY invoice_date ASC, id ASC`,
      [customer]
    );

    console.log("--- INVOICES (BRANCH 1) ---");
    console.table(invoicesBranch1.rows);

    const cashInBranch1 = await pool.query(
      `SELECT id, created_at, amount, source_type
       FROM cash_in 
       WHERE customer_name = $1 AND branch_id = 1
       ORDER BY created_at ASC`,
      [customer]
    );

    console.log("--- CASH IN (BRANCH 1) ---");
    console.table(cashInBranch1.rows);

    const cashInBranch2 = await pool.query(
      `SELECT id, created_at, amount, source_type
       FROM cash_in 
       WHERE customer_name = $1 AND branch_id = 2
       ORDER BY created_at ASC`,
      [customer]
    );

    console.log("--- CASH IN (BRANCH 2) ---");
    console.table(cashInBranch2.rows);

    process.exit(0);
  } catch(e) {
    console.error(e);
    process.exit(1);
  }
}

evaluateAbdullah();
