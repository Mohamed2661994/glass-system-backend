require('dotenv').config();
const pool = require('../db');

async function checkInvoice395() {
  try {
    const id = 395;
    
    // 1. Get invoice details
    const invRes = await pool.query('SELECT * FROM invoices WHERE id = $1', [id]);
    if (invRes.rows.length === 0) {
      console.log('Invoice not found!');
      process.exit(0);
    }
    const inv = invRes.rows[0];
    
    console.log('--- INVOICE 395 DETAILS ---');
    console.log('Type:', inv.invoice_type, ' | Movement:', inv.movement_type);
    console.log('Created At:', inv.created_at);
    console.log('Updated At:', inv.updated_at);
    console.log('Created By:', inv.created_by_name || inv.created_by);
    console.log('Updated By:', inv.updated_by_name || inv.updated_by);
    console.log('Revision Count (number of edits):', inv.invoice_revision);
    console.log('Invoice Date:', inv.invoice_date);
    
    console.log('\n--- FINANCIALS IN DB ---');
    console.log('Subtotal:', inv.subtotal);
    console.log('Discount Total:', inv.discount_total);
    console.log('Manual/Extra Discount:', inv.manual_discount);
    console.log('Additional Amount:', inv.additional_amount);
    console.log('Total:', inv.total);
    console.log('Paid:', inv.paid_amount);
    console.log('Remaining:', inv.remaining_amount);

    // 2. Calculate actual items total
    const itemsRes = await pool.query('SELECT * FROM invoice_items WHERE invoice_id = $1', [id]);
    let calculatedSubtotal = 0;
    let calculatedItemsDiscount = 0;
    
    itemsRes.rows.forEach(item => {
      calculatedSubtotal += Number(item.price) * Number(item.quantity);
      calculatedItemsDiscount += Number(item.discount || 0) * Number(item.quantity);
    });
    
    console.log('\n--- CALCULATED FROM ITEMS ---');
    console.log('Items Count:', itemsRes.rows.length);
    console.log('Calculated Subtotal:', calculatedSubtotal);
    console.log('Calculated Items Discount:', calculatedItemsDiscount);
    
    const extraDiscount = Number(inv.manual_discount || 0);
    const calculatedTotalDiscount = calculatedItemsDiscount + extraDiscount;
    const additionalAmount = Number(inv.additional_amount || 0);
    const calculatedFinalTotal = calculatedSubtotal - calculatedTotalDiscount + additionalAmount;
    
    console.log('Calculated Final Total:', calculatedFinalTotal);
    
    console.log('\n--- DISCREPANCIES ---');
    if (Math.abs(calculatedFinalTotal - Number(inv.total)) > 0.01) {
      console.log('⚠️ MISMATCH IN TOTAL! DB Total:', inv.total, 'vs Calculated:', calculatedFinalTotal);
    } else {
      console.log('✅ Totals match perfectly.');
    }
    
    if (Math.abs(calculatedSubtotal - Number(inv.subtotal)) > 0.01) {
      console.log('⚠️ MISMATCH IN SUBTOTAL! DB Subtotal:', inv.subtotal, 'vs Calculated:', calculatedSubtotal);
    } else {
      console.log('✅ Subtotals match perfectly.');
    }
    
    // 3. Check Audit Logs
    console.log('Apply Items Discount in DB:', inv.apply_items_discount);

    try {
      const audit = await pool.query(
        "SELECT * FROM user_activity WHERE entity_id = $1 ORDER BY created_at DESC", 
        ['395']
      );
      console.log('\n--- ACTIVITY LOGS FOR INVOICE 395 (user_activity) ---');
      if (audit.rows.length === 0) {
        console.log('No activity logs found.');
      } else {
        audit.rows.forEach(log => {
          console.log(`[${log.created_at.toISOString()}] User ID ${log.user_id} - ${log.action} - ${log.entity_type}`);
        });
      }
    } catch(err) {
      console.log('Could not query user_activity table by entity_id:', err.message);
    }

    process.exit(0);
  } catch(e) {
    console.error(e);
    process.exit(1);
  }
}
checkInvoice395();
