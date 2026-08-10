require('dotenv').config();
const pool = require('../db');

async function checkAgain() {
  try {
    const newRes = await pool.query(`
      WITH opening AS (
        SELECT DISTINCT ON (customer_name)
          customer_name,
          COALESCE(previous_balance, 0) AS opening_balance
        FROM invoices
        WHERE movement_type = 'sale' AND is_void = false AND branch_id = 1
        ORDER BY customer_name, invoice_date ASC, id ASC
      )
      SELECT 
        i.customer_name,
        ob.opening_balance,
        SUM(i.total) as sum_total,
        SUM(i.paid_amount) as sum_paid,
        COALESCE(cp.extra_paid, 0) as extra_paid,
        GREATEST(COALESCE(ob.opening_balance, 0) + SUM(i.total) - SUM(i.paid_amount) - COALESCE(cp.extra_paid, 0), 0) AS balance
      FROM invoices i 
      LEFT JOIN opening ob ON ob.customer_name = i.customer_name 
      LEFT JOIN ( 
        SELECT customer_name, SUM(amount) AS extra_paid 
        FROM cash_in 
        WHERE source_type = 'customer_payment' AND branch_id = 1
        GROUP BY customer_name 
      ) cp ON cp.customer_name = i.customer_name 
      WHERE i.movement_type = 'sale' AND i.is_void = false AND i.branch_id = 1 
      GROUP BY i.customer_name, cp.extra_paid, ob.opening_balance 
      HAVING GREATEST(COALESCE(ob.opening_balance, 0) + SUM(i.total) - SUM(i.paid_amount) - COALESCE(cp.extra_paid, 0), 0) > 0 
    `);

    console.table(newRes.rows.filter(r => r.customer_name.includes('عبدالله')));
    process.exit(0);
  } catch(e) {
    console.error(e);
    process.exit(1);
  }
}

checkAgain();
