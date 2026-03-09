require("dotenv").config();
const { Pool } = require("pg");

function getDbConfig(target) {
  if (target === "local") {
    return {
      host: process.env.DB_HOST_LOCAL,
      port: Number(process.env.DB_PORT_LOCAL || 5432),
      user: process.env.DB_USER_LOCAL,
      password: process.env.DB_PASSWORD_LOCAL,
      database: process.env.DB_NAME_LOCAL,
      ssl:
        process.env.DB_SSL_LOCAL === "true"
          ? { rejectUnauthorized: false }
          : false,
    };
  }

  return {
    host: process.env.DB_HOST_CLOUD,
    port: Number(process.env.DB_PORT_CLOUD || 5432),
    user: process.env.DB_USER_CLOUD,
    password: process.env.DB_PASSWORD_CLOUD,
    database: process.env.DB_NAME_CLOUD,
    ssl:
      process.env.DB_SSL_CLOUD === "true"
        ? { rejectUnauthorized: false }
        : false,
  };
}

async function getCount(client) {
  const overlapRes = await client.query(`
    SELECT COUNT(*)::int AS c
    FROM stock_transfer_items sti
    WHERE COALESCE(sti.status, 'active') = 'cancelled'
      AND EXISTS (
        SELECT 1
        FROM stock_movements sm1
        WHERE sm1.reference_type = 'transfer_item_cancel'
          AND sm1.reference_id = sti.id
          AND sm1.product_id = sti.product_id
      )
      AND EXISTS (
        SELECT 1
        FROM stock_movements sm2
        WHERE sm2.reference_type = 'transfer_cancel'
          AND sm2.reference_id = sti.transfer_id
          AND sm2.product_id = sti.product_id
      )
  `);

  const negRes = await client.query(
    "SELECT COUNT(*)::int AS c FROM stock WHERE quantity < 0",
  );

  return {
    overlapItems: Number(overlapRes.rows[0]?.c || 0),
    negativeStockRows: Number(negRes.rows[0]?.c || 0),
  };
}

async function recalcStock(client, productId, warehouseId) {
  const sumRes = await client.query(
    `
    SELECT COALESCE(SUM(
      CASE
        WHEN movement_type IN ('purchase','transfer_in','replace_in','return_sale') THEN quantity
        WHEN movement_type IN ('sale','transfer_out','replace_out','return_purchase') THEN -quantity
        ELSE 0
      END
    ), 0) AS qty
    FROM stock_movements
    WHERE product_id = $1
      AND warehouse_id = $2
      AND COALESCE(variant_id, 0) = 0
    `,
    [productId, warehouseId],
  );

  const qty = Number(sumRes.rows[0]?.qty || 0);

  const existsRes = await client.query(
    `
    SELECT 1
    FROM stock
    WHERE product_id = $1
      AND warehouse_id = $2
      AND COALESCE(variant_id, 0) = 0
    LIMIT 1
    `,
    [productId, warehouseId],
  );

  if (existsRes.rows.length > 0) {
    await client.query(
      `
      UPDATE stock
      SET quantity = $1,
          updated_at = NOW()
      WHERE product_id = $2
        AND warehouse_id = $3
        AND COALESCE(variant_id, 0) = 0
      `,
      [qty, productId, warehouseId],
    );
  } else {
    await client.query(
      `
      INSERT INTO stock (warehouse_id, product_id, variant_id, quantity, created_at, updated_at)
      VALUES ($1, $2, 0, $3, NOW(), NOW())
      `,
      [warehouseId, productId, qty],
    );
  }
}

async function fixDatabase(target) {
  const cfg = getDbConfig(target);
  if (!cfg.host || !cfg.user || !cfg.database) {
    return {
      target,
      skipped: true,
      reason: `Missing ${target} DB env vars`,
    };
  }

  const pool = new Pool(cfg);
  const client = await pool.connect();

  try {
    const before = await getCount(client);

    await client.query("BEGIN");

    const itemsRes = await client.query(`
      SELECT
        sti.id,
        sti.transfer_id,
        sti.product_id,
        sti.from_warehouse_id,
        sti.to_warehouse_id,
        sti.from_quantity,
        sti.to_quantity
      FROM stock_transfer_items sti
      WHERE COALESCE(sti.status, 'active') = 'cancelled'
        AND EXISTS (
          SELECT 1
          FROM stock_movements sm1
          WHERE sm1.reference_type = 'transfer_item_cancel'
            AND sm1.reference_id = sti.id
            AND sm1.product_id = sti.product_id
        )
        AND EXISTS (
          SELECT 1
          FROM stock_movements sm2
          WHERE sm2.reference_type = 'transfer_cancel'
            AND sm2.reference_id = sti.transfer_id
            AND sm2.product_id = sti.product_id
        )
      ORDER BY sti.id
      FOR UPDATE
    `);

    const deleteIds = [];
    const touched = new Set();

    for (const item of itemsRes.rows) {
      const inRes = await client.query(
        `
        SELECT id
        FROM stock_movements
        WHERE reference_type = 'transfer_cancel'
          AND reference_id = $1
          AND product_id = $2
          AND warehouse_id = $3
          AND movement_type = 'transfer_in'
          AND quantity = $4
        ORDER BY id DESC
        LIMIT 1
        `,
        [
          item.transfer_id,
          item.product_id,
          item.from_warehouse_id,
          item.from_quantity,
        ],
      );

      const outRes = await client.query(
        `
        SELECT id
        FROM stock_movements
        WHERE reference_type = 'transfer_cancel'
          AND reference_id = $1
          AND product_id = $2
          AND warehouse_id = $3
          AND movement_type = 'transfer_out'
          AND quantity = $4
        ORDER BY id DESC
        LIMIT 1
        `,
        [
          item.transfer_id,
          item.product_id,
          item.to_warehouse_id,
          item.to_quantity,
        ],
      );

      const inId = inRes.rows[0]?.id;
      const outId = outRes.rows[0]?.id;

      if (inId) deleteIds.push(Number(inId));
      if (outId) deleteIds.push(Number(outId));

      if (inId || outId) {
        touched.add(`${item.product_id}:${item.from_warehouse_id}`);
        touched.add(`${item.product_id}:${item.to_warehouse_id}`);
      }
    }

    if (deleteIds.length > 0) {
      await client.query(
        `DELETE FROM stock_movements WHERE id = ANY($1::int[])`,
        [deleteIds],
      );

      for (const key of touched) {
        const [productId, warehouseId] = key.split(":").map(Number);
        await recalcStock(client, productId, warehouseId);
      }
    }

    await client.query("COMMIT");

    const after = await getCount(client);

    return {
      target,
      skipped: false,
      before,
      after,
      deletedRows: deleteIds.length,
      touchedPairs: touched.size,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw new Error(`${target}: ${err.message}`);
  } finally {
    client.release();
    await pool.end();
  }
}

async function run() {
  try {
    const local = await fixDatabase("local");
    const cloud = await fixDatabase("cloud");

    console.log(JSON.stringify({ local, cloud }, null, 2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

run();
