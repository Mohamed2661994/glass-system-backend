const { Pool } = require('pg');

const sourcePool = new Pool({
  host: '18.185.48.10',
  port: 5432,
  user: 'glass_admin',
  password: '@Hadysalah1',
  database: 'glass_system',
  max: 2,
  connectionTimeoutMillis: 10000
});

const targetPool = new Pool({
  host: 'dbstudio.hg-alshour.online',
  port: 5432,
  user: 'glass_admin',
  password: '@Hadysalah1',
  database: 'glass_system',
  max: 2,
  connectionTimeoutMillis: 10000
});

async function analyze() {
  const sClient = await sourcePool.connect();
  const tClient = await targetPool.connect();

  try {
    console.log("=== INVOICES DIFFERENCE ===");
    const invSource = await sClient.query('SELECT id, invoice_number, customer_id, total, created_at FROM invoices WHERE id > 3390 ORDER BY id ASC');
    const invTarget = await tClient.query('SELECT id, invoice_number, customer_id, total, created_at FROM invoices WHERE id > 3390 ORDER BY id ASC');
    console.log("Source Invoices > 3390:", invSource.rows);
    console.log("Target Invoices > 3390:", invTarget.rows);

    console.log("\n=== CUSTOMERS DIFFERENCE ===");
    const custSource = await sClient.query('SELECT id, name, phone, created_at FROM customers WHERE id >= 874 ORDER BY id ASC');
    const custTarget = await tClient.query('SELECT id, name, phone, created_at FROM customers WHERE id >= 874 ORDER BY id ASC');
    console.log("Source Customers >= 874:", custSource.rows);
    console.log("Target Customers >= 874:", custTarget.rows);

    console.log("\n=== CASH OUT DIFFERENCE ===");
    const cashOutSource = await sClient.query('SELECT * FROM cash_out WHERE id >= 2553 ORDER BY id ASC');
    const cashOutTarget = await tClient.query('SELECT * FROM cash_out WHERE id >= 2553 ORDER BY id ASC');
    console.log("Source Cash Out >= 2553:", cashOutSource.rows);
    console.log("Target Cash Out >= 2553:", cashOutTarget.rows);

    console.log("\n=== CASH IN DIFFERENCE ===");
    // Find IDs in target not in source, or vice versa
    const sCashInIds = (await sClient.query('SELECT id FROM cash_in')).rows.map(r => r.id);
    const tCashInIds = (await tClient.query('SELECT id FROM cash_in')).rows.map(r => r.id);
    const sCashInSet = new Set(sCashInIds);
    const tCashInSet = new Set(tCashInIds);

    const inSourceNotTargetCashIn = sCashInIds.filter(x => !tCashInSet.has(x));
    const inTargetNotSourceCashIn = tCashInIds.filter(x => !sCashInSet.has(x));
    console.log("CashIn in Source but NOT Target:", inSourceNotTargetCashIn);
    console.log("CashIn in Target but NOT Source:", inTargetNotSourceCashIn);
    if (inTargetNotSourceCashIn.length > 0) {
      const extraRows = await tClient.query('SELECT * FROM cash_in WHERE id = ANY($1)', [inTargetNotSourceCashIn]);
      console.log("Extra CashIn rows on Target:", extraRows.rows);
    }

    console.log("\n=== INVOICE ITEMS DIFFERENCE ===");
    const sItems = (await sClient.query('SELECT id FROM invoice_items WHERE id >= 81100')).rows.map(r => r.id);
    const tItems = (await tClient.query('SELECT id FROM invoice_items WHERE id >= 81100')).rows.map(r => r.id);
    const sItemSet = new Set(sItems);
    const tItemSet = new Set(tItems);
    console.log("InvoiceItems in Source but NOT Target:", sItems.filter(x => !tItemSet.has(x)));
    console.log("InvoiceItems in Target but NOT Source:", tItems.filter(x => !sItemSet.has(x)));
    const extraItemIds = tItems.filter(x => !sItemSet.has(x));
    if (extraItemIds.length > 0) {
      const extra = await tClient.query('SELECT id, invoice_id, product_id, quantity, unit_price FROM invoice_items WHERE id = ANY($1)', [extraItemIds]);
      console.log("Extra invoice_items on Target:", extra.rows);
    }

    console.log("\n=== STOCK MOVEMENTS DIFFERENCE ===");
    const sMov = (await sClient.query('SELECT id FROM stock_movements WHERE id >= 86300')).rows.map(r => r.id);
    const tMov = (await tClient.query('SELECT id FROM stock_movements WHERE id >= 86300')).rows.map(r => r.id);
    const sMovSet = new Set(sMov);
    const tMovSet = new Set(tMov);
    console.log("StockMovements in Source but NOT Target:", sMov.filter(x => !tMovSet.has(x)));
    console.log("StockMovements in Target but NOT Source:", tMov.filter(x => !sMovSet.has(x)));

  } catch (err) {
    console.error("Error analyzing:", err);
  } finally {
    sClient.release();
    tClient.release();
    await sourcePool.end();
    await targetPool.end();
  }
}

analyze();
