const pool = require("./db");
(async () => {
  try {
    const res = await pool.query(
      `SELECT 'invoice' as type, created_at, remaining_amount, branch_id FROM invoices WHERE customer_name LIKE '%شريف عارف%'
       UNION ALL
       SELECT 'payment' as type, created_at, amount, branch_id FROM cash_in WHERE customer_name LIKE '%شريف عارف%'
       ORDER BY created_at DESC LIMIT 5`
    );
    console.log(res.rows);
  } catch(e) { console.error(e); }
  process.exit(0);
})();
