require('dotenv').config();
const pool = require('../db');

async function run() {
  try {
    const res = await pool.query(`SELECT customer_name, branch_id, SUM(total) as total, SUM(paid_amount) as paid FROM invoices WHERE customer_name LIKE '%سامح%' GROUP BY customer_name, branch_id;`);
    console.table(res.rows);
    
    // Also check what getCustomerBalances returns for Sameh
    const res2 = await pool.query(`
      WITH opening AS (
        SELECT DISTINCT ON (customer_name)
          customer_name,
          COALESCE(previous_balance, 0) AS opening_balance
        FROM invoices
        WHERE movement_type = 'sale' AND is_void = false
        ORDER BY customer_name, invoice_date ASC, id ASC
      )
      SELECT 
        i.customer_name, 
        i.branch_id,
        GREATEST(COALESCE(ob.opening_balance, 0) + SUM(i.total) - SUM(i.paid_amount) - COALESCE(cp.extra_paid, 0), 0) AS balance_due 
      FROM invoices i 
      LEFT JOIN opening ob ON ob.customer_name = i.customer_name 
      LEFT JOIN ( 
        SELECT customer_name, SUM(amount) AS extra_paid 
        FROM cash_in 
        WHERE source_type = 'customer_payment' 
        GROUP BY customer_name 
      ) cp ON cp.customer_name = i.customer_name 
      WHERE i.movement_type = 'sale' AND i.is_void = false AND i.customer_name LIKE '%سامح%'
      GROUP BY i.customer_name, i.branch_id, cp.extra_paid, ob.opening_balance 
    `);
    console.log('Balance logic output:');
    console.table(res2.rows);

    process.exit(0);
  } catch(e) {
    console.error(e);
    process.exit(1);
  }
}

run();
