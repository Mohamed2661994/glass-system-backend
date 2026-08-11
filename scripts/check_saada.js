require('dotenv').config();
const pool = require('../db');

async function checkSaada() {
  try {
    const customerName = 'الحاجة سعادة';
    
    console.log(`\n--- Invoices for ${customerName} ---`);
    const invoices = await pool.query(`
      SELECT id, invoice_date, total, paid_amount, previous_balance, remaining_amount, branch_id
      FROM invoices 
      WHERE customer_name = $1
      ORDER BY invoice_date ASC, id ASC
    `, [customerName]);
    console.table(invoices.rows);

    console.log(`\n--- Cash In (Payments) for ${customerName} ---`);
    const cashIn = await pool.query(`
      SELECT id, created_at, amount, source_type, notes
      FROM cash_in 
      WHERE customer_name = $1
      ORDER BY created_at ASC, id ASC
    `, [customerName]);
    console.table(cashIn.rows);

    const totalInvoices = invoices.rows.reduce((sum, inv) => sum + Number(inv.total), 0);
    const totalPaidInvoices = invoices.rows.reduce((sum, inv) => sum + Number(inv.paid_amount), 0);
    const totalPayments = cashIn.rows
        .filter(c => c.source_type !== 'فاتورة مبيعات') // manual receipts
        .reduce((sum, cash) => sum + Number(cash.amount), 0);

    console.log(`Total Invoices: ${totalInvoices}`);
    console.log(`Total Paid at Invoice Time: ${totalPaidInvoices}`);
    console.log(`Total Separate Payments: ${totalPayments}`);
    
    // Simplistic balance (this depends on exact logic in system, but roughly)
    console.log(`Calculated Remaining Debt: ${totalInvoices - totalPaidInvoices - totalPayments}`);

    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
checkSaada();
