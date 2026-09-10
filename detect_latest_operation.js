const { Pool } = require('pg');

const studioPool = new Pool({
  connectionString: 'postgresql://glass_backend:SecGlass_2026_Postgres_HA@dbstudio.hg-alshour.online:5432/glass_system'
});

const cloudPool = new Pool({
  host: '18.185.48.10',
  port: 5432,
  user: 'glass_admin',
  password: '@Hadysalah1',
  database: 'glass_system'
});

async function inspect(pool, name) {
  console.log(`\n=============================================`);
  console.log(`🔍 INSPECTING ${name}`);
  console.log(`=============================================`);

  // Invoices
  const inv = await pool.query(`
    SELECT id, invoice_number, total, paid_amount, remaining_amount, customer_name, 
           created_by_name, updated_by_name, invoice_revision, created_at, updated_at
    FROM invoices 
    WHERE id > 3399 OR updated_at >= NOW() - INTERVAL '20 minutes'
    ORDER BY updated_at DESC LIMIT 5
  `);
  console.log(`Invoices (recent / >3399):`, inv.rows);

  // Cash In
  const cin = await pool.query(`
    SELECT id, amount, customer_name, description, source_type, created_at, updated_at
    FROM cash_in
    WHERE id > 3188 OR updated_at >= NOW() - INTERVAL '20 minutes'
    ORDER BY updated_at DESC LIMIT 5
  `);
  console.log(`Cash In (recent / >3188):`, cin.rows);

  // Cash Out
  const cout = await pool.query(`
    SELECT id, amount, name, entry_type, notes, created_at, updated_at
    FROM cash_out
    WHERE id > 2560 OR updated_at >= NOW() - INTERVAL '20 minutes'
    ORDER BY updated_at DESC LIMIT 5
  `);
  console.log(`Cash Out (recent / >2560):`, cout.rows);

  // Stock Movements
  const sm = await pool.query(`
    SELECT sm.id, sm.product_id, p.name as product_name, sm.quantity, sm.movement_type, 
           sm.invoice_id, sm.created_at, sm.updated_at
    FROM stock_movements sm
    LEFT JOIN products p ON p.id = sm.product_id
    WHERE sm.id > 86330 OR sm.updated_at >= NOW() - INTERVAL '20 minutes'
    ORDER BY sm.id DESC LIMIT 10
  `);
  console.log(`Stock Movements (recent / >86330):`, sm.rows);

  // Stock Transfers
  const st = await pool.query(`
    SELECT id, created_at, updated_at
    FROM stock_transfers
    WHERE id > 921 OR updated_at >= NOW() - INTERVAL '20 minutes'
    ORDER BY updated_at DESC LIMIT 5
  `);
  console.log(`Stock Transfers (recent / >921):`, st.rows);

  // Customers
  const cust = await pool.query(`
    SELECT id, name, phone, created_at, updated_at
    FROM customers
    WHERE id > 876 OR updated_at >= NOW() - INTERVAL '20 minutes'
    ORDER BY updated_at DESC LIMIT 5
  `);
  console.log(`Customers (recent / >876):`, cust.rows);

  // User Activity
  const act = await pool.query(`
    SELECT id, username, action, ip_address, created_at
    FROM user_activity
    WHERE id > 2103 OR created_at >= NOW() - INTERVAL '20 minutes'
    ORDER BY id DESC LIMIT 5
  `);
  console.log(`User Activity (recent / >2103):`, act.rows);
}

async function run() {
  await inspect(studioPool, "DATA STUDIO DB (dbstudio.hg-alshour.online)");
  await inspect(cloudPool, "AWS CLOUD DB (18.185.48.10)");
  await studioPool.end();
  await cloudPool.end();
}

run().catch(console.error);
