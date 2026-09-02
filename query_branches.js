const pool = require("./db");
(async () => {
  try {
    const customerId = 169;
    const res = await pool.query(
      "SELECT branch_id, invoice_type, SUM(total) as sum_total FROM invoices WHERE customer_id = $1 GROUP BY branch_id, invoice_type",
      [customerId]
    );
    console.log("Invoices by branch:", res.rows);
    
    const customerRes = await pool.query(`SELECT name FROM customers WHERE id = $1`, [customerId]);
    const name = customerRes.rows[0].name;

    const cashRes = await pool.query(
      "SELECT branch_id, SUM(amount) as total_paid FROM cash_in WHERE customer_name = $1 GROUP BY branch_id",
      [name]
    );
    console.log("Payments by branch:", cashRes.rows);
  } catch(e) { console.error(e); }
  process.exit(0);
})();
