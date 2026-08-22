require('dotenv').config();
const pool = require('./db.js');

async function searchInvoices() {
  const name = 'ام محمد';
  try {
    const result = await pool.query(`
      SELECT id, branch_id, invoice_type, movement_type, customer_phone, total, invoice_date, created_at
      FROM invoices
      WHERE customer_name ILIKE $1
      ORDER BY created_at DESC
      LIMIT 15
    `, [`%${name}%`]);

    console.log(`Found ${result.rows.length} invoices for name ${name} (showing top 15):`);
    console.table(result.rows);
  } catch (error) {
    console.error('Error querying:', error);
  } finally {
    process.exit(0);
  }
}

searchInvoices();
