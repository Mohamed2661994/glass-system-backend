require('dotenv').config();
const pool = require('../db');

async function checkAliKhalil() {
  try {
    const customers = ['على خليل', 'علي خليل', 'علي خليل '];
    for (const c of customers) {
      console.log(`\n--- Customer: ${c} ---`);
      
      const lastInvoiceResult = await pool.query(`
        SELECT id, invoice_date, remaining_amount, branch_id
        FROM invoices
        WHERE customer_name = $1 AND is_void = false
        ORDER BY invoice_date DESC, id DESC
        LIMIT 1;
      `, [c]);
      
      let lastInvoice = null;
      if (lastInvoiceResult.rows.length > 0) {
        lastInvoice = lastInvoiceResult.rows[0];
        console.log("Last Invoice:", lastInvoice);
      } else {
        console.log("No invoices found.");
      }

      let subsequentPaymentsSum = 0;
      if (lastInvoice) {
        const subsequentPayments = await pool.query(`
          SELECT SUM(amount) as total_amount
          FROM cash_in
          WHERE customer_name = $1 AND source_type = 'customer_payment'
            AND (created_at > $2 OR date(transaction_date) > date($2))
        `, [c, lastInvoice.invoice_date]);
        
        subsequentPaymentsSum = parseFloat(subsequentPayments.rows[0].total_amount) || 0;
        console.log(`Payments after last invoice: ${subsequentPaymentsSum}`);
        
        const finalBalance = parseFloat(lastInvoice.remaining_amount) - subsequentPaymentsSum;
        console.log(`Final Calculated Balance: ${finalBalance}`);
      }
    }
    
    process.exit(0);
  } catch(e) {
    console.error(e);
    process.exit(1);
  }
}

checkAliKhalil();
