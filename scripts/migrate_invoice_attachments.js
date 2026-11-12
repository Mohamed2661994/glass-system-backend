const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const pool = require("../db");

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS invoice_attachments (
        id SERIAL PRIMARY KEY,
        invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
        storage_provider VARCHAR(20) NOT NULL DEFAULT 'r2',
        object_key TEXT NOT NULL UNIQUE,
        original_name TEXT,
        mime_type VARCHAR(50) NOT NULL,
        file_size INTEGER NOT NULL,
        sha256 VARCHAR(64) NOT NULL,
        uploaded_by INTEGER,
        uploaded_by_name VARCHAR(150),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_invoice_attachments_invoice_id
      ON invoice_attachments(invoice_id);
    `);

    await client.query("COMMIT");
    console.log("✅ invoice_attachments table and index verified/created successfully.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Migration failed:", err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  migrate();
}

module.exports = { migrate };

