require('dotenv').config();
const pool = require('./db');

async function check() {
  // 1. Check stock table directly for negative quantities
  const neg = await pool.query("SELECT s.*, p.name, p.barcode, w.name as wname FROM stock s JOIN products p ON p.id=s.product_id JOIN warehouses w ON w.id=s.warehouse_id WHERE s.quantity < 0 ORDER BY s.quantity LIMIT 20");
  console.log("Negative in stock table:", neg.rows.length);
  neg.rows.forEach(r => console.log(`  ${r.name} | qty: ${r.quantity} | warehouse: ${r.wname} | barcode: ${r.barcode}`));

  // 2. Check total stock range
  const range = await pool.query("SELECT MIN(quantity) as min_qty, MAX(quantity) as max_qty, COUNT(*) as total FROM stock");
  console.log("Stock range:", range.rows[0]);

  // 3. Check how many items at exactly 0
  const zeros = await pool.query("SELECT COUNT(*) as cnt FROM stock WHERE quantity = 0");
  console.log("Zero stock items:", zeros.rows[0].cnt);

  // 4. Check items <= -1
  const negCount = await pool.query("SELECT COUNT(*) as cnt FROM stock WHERE quantity < 0");
  console.log("Negative stock count:", negCount.rows[0].cnt);

  await pool.end();
}
check().catch(e => { console.error(e); process.exit(1); });
