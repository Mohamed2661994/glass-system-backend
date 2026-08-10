require('dotenv').config();
const pool = require('../db');

async function fixOldReceipt() {
  try {
    const res = await pool.query(`
      UPDATE cash_in 
      SET remaining_amount = 2140
      WHERE id = 2737
    `);
    console.log('Updated rows:', res.rowCount);
    process.exit(0);
  } catch(e) {
    console.error(e);
    process.exit(1);
  }
}

fixOldReceipt();
