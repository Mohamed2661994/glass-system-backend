const pool = require("./db");
(async () => {
  try {
    const customerId = 169;
    const res = await pool.query(
      "SELECT id, total, paid_amount, remaining_amount, created_at, invoice_type FROM invoices WHERE customer_id = $1 AND branch_id = 1 ORDER BY created_at ASC",
      [customerId]
    );
    console.log("Branch 1 Invoices:", res.rows);
    
    const cashRes = await pool.query(
      "SELECT id, amount, created_at FROM cash_in WHERE customer_name LIKE '%شريف عارف%' AND branch_id = 1 ORDER BY created_at ASC"
    );
    console.log("Branch 1 Payments:", cashRes.rows);
  } catch(e) { console.error(e); }
  process.exit(0);
})();
