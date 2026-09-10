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

async function inspectAudit() {
  const client = await sourcePool.connect();
  try {
    const res = await client.query(`SELECT * FROM online_invoice_audit LIMIT 2`);
    console.log("Audit row sample:", res.rows[0]);
    console.log("Types:", {
      request_payload: typeof res.rows[0].request_payload,
      resolved_items: typeof res.rows[0].resolved_items,
      invoice_snapshot: typeof res.rows[0].invoice_snapshot
    });
  } finally {
    client.release();
    await sourcePool.end();
  }
}

inspectAudit();
