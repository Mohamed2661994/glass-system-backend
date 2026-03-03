/**
 * Migration: Add updated_at (and created_at where missing) to all tables.
 * Creates an auto-update trigger so updated_at is set on every UPDATE.
 * Run ONCE on both Local and Neon databases.
 */
require("dotenv").config();
const { Pool } = require("pg");

const localPool = new Pool({
  host: process.env.DB_HOST_LOCAL,
  port: Number(process.env.DB_PORT_LOCAL || 5432),
  user: process.env.DB_USER_LOCAL,
  password: process.env.DB_PASSWORD_LOCAL,
  database: process.env.DB_NAME_LOCAL,
  ssl:
    process.env.DB_SSL_LOCAL === "true" ? { rejectUnauthorized: false } : false,
});

const neonPool = new Pool({
  host: process.env.DB_HOST_NEON,
  port: Number(process.env.DB_PORT_NEON || 5432),
  user: process.env.DB_USER_NEON,
  password: process.env.DB_PASSWORD_NEON,
  database: process.env.DB_NAME_NEON,
  ssl:
    process.env.DB_SSL_NEON === "true" ? { rejectUnauthorized: false } : false,
});

// Tables that need BOTH created_at AND updated_at
const NEED_BOTH = [
  "branches",
  "conversation_participants",
  "invoice_items",
  "products",
  "stock",
  "stock_transfer_items",
  "supplier_phones",
  "users",
  "warehouses",
];

// Tables that already have created_at but need updated_at
const NEED_UPDATED_AT = [
  "cash_in",
  "cash_out",
  "customer_phones",
  "customers",
  "daily_cash",
  "invoices",
  "manufacturers",
  "messages",
  "notifications",
  "product_variants",
  "push_subscriptions",
  "stock_movements",
  "stock_transfers",
  "suppliers",
  "user_activity",
];

// conversations already has both — just needs the trigger

async function migrate(pool, label) {
  const client = await pool.connect();
  try {
    await client.query("SET search_path = public");
    await client.query("BEGIN");

    // 1. Create trigger function
    await client.query(`
      CREATE OR REPLACE FUNCTION set_updated_at()
      RETURNS TRIGGER AS $fn$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $fn$ LANGUAGE plpgsql;
    `);
    console.log(`  [${label}] ✓ Trigger function created`);

    // 2. Add columns to tables needing both
    for (const table of NEED_BOTH) {
      await client.query(
        `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`,
      );
      await client.query(
        `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`,
      );
      console.log(`  [${label}] ✓ ${table}: added created_at + updated_at`);
    }

    // 3. Add updated_at to tables that only have created_at
    for (const table of NEED_UPDATED_AT) {
      await client.query(
        `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`,
      );
      console.log(`  [${label}] ✓ ${table}: added updated_at`);
    }

    // 4. Add trigger to ALL tables (including conversations)
    const allTables = [...NEED_BOTH, ...NEED_UPDATED_AT, "conversations"];
    for (const table of allTables) {
      await client.query(`DROP TRIGGER IF EXISTS trg_updated_at ON "${table}"`);
      await client.query(`
        CREATE TRIGGER trg_updated_at
        BEFORE UPDATE ON "${table}"
        FOR EACH ROW EXECUTE FUNCTION set_updated_at()
      `);
      console.log(`  [${label}] ✓ ${table}: trigger attached`);
    }

    await client.query("COMMIT");
    console.log(`\n✅ [${label}] Migration complete!\n`);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(`\n❌ [${label}] Migration failed:`, err.message);
    throw err;
  } finally {
    client.release();
  }
}

(async () => {
  console.log("=== Migrating Local Database ===");
  await migrate(localPool, "Local");

  console.log("=== Migrating Neon Database ===");
  await migrate(neonPool, "Neon");

  await localPool.end();
  await neonPool.end();
  console.log("🎉 All migrations complete!");
})().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
