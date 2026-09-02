const pool = require("./db");
async function getBalance(customerId, branch_id, invoice_type) {
  const result = await pool.query(
    `
    SELECT remaining_amount, created_at
    FROM invoices
    WHERE customer_id = $1
      AND invoice_type = $2
      AND branch_id = $3
      AND is_void = false
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [customerId, invoice_type, branch_id],
  );
  
  const lastRemaining = result.rows.length ? Number(result.rows[0].remaining_amount) : 0;
  
  const customerRes = await pool.query(`SELECT name FROM customers WHERE id = $1`, [customerId]);
  const customerName = customerRes.rows[0]?.name;

  let totalPayments = 0;
  if (customerName) {
    const paymentsRes = await pool.query(
      `
      SELECT COALESCE(SUM(amount), 0) AS total_payments
      FROM cash_in
      WHERE customer_name = $1
        AND branch_id = $2
        AND source_type = 'customer_payment'
        AND created_at > (
          SELECT COALESCE(MAX(created_at), '1970-01-01')
          FROM invoices
          WHERE customer_id = $3
            AND branch_id = $2
            AND invoice_type = $4
            AND is_void = false
        )
      `,
      [customerName, branch_id, customerId, invoice_type]
    );
    totalPayments = Number(paymentsRes.rows[0].total_payments);
  }
  return { branch: branch_id, type: invoice_type, balance: lastRemaining - totalPayments };
}

(async () => {
  try {
    const b1 = await getBalance(169, 1, 'retail');
    const b2 = await getBalance(169, 2, 'wholesale');
    console.log("Branch 1 (Retail) Balance:", b1.balance);
    console.log("Branch 2 (Wholesale) Balance:", b2.balance);
    console.log("Total System Balance:", b1.balance + b2.balance);
  } catch(e) { console.error(e); }
  process.exit(0);
})();
