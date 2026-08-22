require('dotenv').config();
const pool = require('./db.js');

async function searchInvoices() {
  const phone = '01289967636';
  try {
    const result = await pool.query(`
      SELECT id, branch_id, invoice_type, movement_type, customer_name, customer_phone, total, invoice_date, created_at
      FROM invoices
      WHERE customer_phone = $1
      ORDER BY created_at DESC
    `, [phone]);

    console.log(`Found ${result.rows.length} invoices for phone ${phone}:`);
    console.table(result.rows);

    // Let's also check if there's any customer with this phone number
    const customerResult = await pool.query(`
      SELECT id, name, phone
      FROM customers
      WHERE phone = $1
    `, [phone]);

    console.log(`\nFound ${customerResult.rows.length} customers with phone ${phone}:`);
    console.table(customerResult.rows);

    // Check if the phone is registered in customer_phones table if it exists
    try {
        const altPhoneResult = await pool.query(`
            SELECT cp.customer_id, c.name, cp.phone
            FROM customer_phones cp
            JOIN customers c ON c.id = cp.customer_id
            WHERE cp.phone = $1
        `, [phone]);
        console.log(`\nFound ${altPhoneResult.rows.length} alternate customer_phones records:`);
        console.table(altPhoneResult.rows);
    } catch (e) {
        // Ignore if customer_phones table doesn't exist
    }

  } catch (error) {
    console.error('Error querying:', error);
  } finally {
    process.exit(0);
  }
}

searchInvoices();
