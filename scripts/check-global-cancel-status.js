require("dotenv").config();
const { Pool } = require("pg");

async function run() {
  const pool = new Pool({
    host: process.env.DB_HOST_LOCAL,
    port: Number(process.env.DB_PORT_LOCAL || 5432),
    user: process.env.DB_USER_LOCAL,
    password: process.env.DB_PASSWORD_LOCAL,
    database: process.env.DB_NAME_LOCAL,
    ssl:
      process.env.DB_SSL_LOCAL === "true"
        ? { rejectUnauthorized: false }
        : false,
  });

  try {
    const neg = await pool.query(
      "SELECT COUNT(*)::int AS c FROM stock WHERE quantity < 0",
    );

    const overlap = await pool.query(`
      SELECT COUNT(*)::int AS c
      FROM stock_transfer_items sti
      WHERE COALESCE(sti.status, 'active') = 'cancelled'
        AND EXISTS (
          SELECT 1
          FROM stock_movements sm1
          WHERE sm1.reference_type = 'transfer_item_cancel'
            AND sm1.reference_id = sti.id
        )
        AND EXISTS (
          SELECT 1
          FROM stock_movements sm2
          WHERE sm2.reference_type = 'transfer_cancel'
            AND sm2.reference_id = sti.transfer_id
            AND sm2.product_id = sti.product_id
        )
    `);

    const overlapProducts = await pool.query(`
      SELECT COUNT(DISTINCT sti.product_id)::int AS c
      FROM stock_transfer_items sti
      WHERE COALESCE(sti.status, 'active') = 'cancelled'
        AND EXISTS (
          SELECT 1
          FROM stock_movements sm1
          WHERE sm1.reference_type = 'transfer_item_cancel'
            AND sm1.reference_id = sti.id
        )
        AND EXISTS (
          SELECT 1
          FROM stock_movements sm2
          WHERE sm2.reference_type = 'transfer_cancel'
            AND sm2.reference_id = sti.transfer_id
            AND sm2.product_id = sti.product_id
        )
    `);

    console.log(
      JSON.stringify({
        negativeStockRows: Number(neg.rows[0].c),
        overlapItems: Number(overlap.rows[0].c),
        overlapProducts: Number(overlapProducts.rows[0].c),
      }),
    );
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
