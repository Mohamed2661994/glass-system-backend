// services/lowStockReorder.service.js

/**
 * Unified SQL CTE & computation for Showroom Replenishment ("طلب تحويل").
 * Includes:
 *   1. Existing showroom items whose stock dropped to <= 50% of carton capacity
 *      (zero / critical_25 / warning_50).
 *   2. Newly arrived master products in 'المخزن الرئيسي' (ws_stock > 0) that
 *      have 0 stock in 'مخزن المعرض' AND have never had any movement in
 *      'مخزن المعرض' before (new_arrival).
 */
const REORDER_BASE_CTE = `
  WITH ws_stock AS MATERIALIZED (
    SELECT
      COALESCE(p2.retail_master_product_id, p2.id) AS product_id,
      SUM(s2.quantity) AS ws_qty
    FROM stock s2
    JOIN products p2 ON p2.id = s2.product_id
    JOIN warehouses w2 ON w2.id = s2.warehouse_id
    WHERE w2.name = 'المخزن الرئيسي'
    GROUP BY COALESCE(p2.retail_master_product_id, p2.id)
  ),
  retail_family_stock AS MATERIALIZED (
    SELECT
      COALESCE(p3.retail_master_product_id, p3.id) AS product_id,
      SUM(s3.quantity) AS retail_qty,
      MIN(s3.variant_id) AS sample_variant_id
    FROM stock s3
    JOIN products p3 ON p3.id = s3.product_id
    JOIN warehouses w3 ON w3.id = s3.warehouse_id
    WHERE w3.name = 'مخزن المعرض'
    GROUP BY COALESCE(p3.retail_master_product_id, p3.id)
  ),
  potential_new_arrivals AS MATERIALIZED (
    SELECT p.id AS product_id
    FROM products p
    JOIN ws_stock ws ON ws.product_id = p.id
    LEFT JOIN retail_family_stock rfs ON rfs.product_id = p.id
    WHERE p.is_active = true
      AND p.retail_master_product_id IS NULL
      AND ws.ws_qty > 0
      AND COALESCE(rfs.retail_qty, 0) = 0
  ),
  confirmed_new_arrivals AS MATERIALIZED (
    SELECT pna.product_id
    FROM potential_new_arrivals pna
    WHERE NOT EXISTS (
      SELECT 1
      FROM stock_movements sm
      JOIN warehouses wm ON wm.id = sm.warehouse_id
      WHERE wm.name = 'مخزن المعرض'
        AND (
          sm.product_id = pna.product_id
          OR sm.product_id IN (
            SELECT pc.id
            FROM products pc
            WHERE pc.retail_master_product_id = pna.product_id
          )
        )
    )
  ),
  candidate_items AS MATERIALIZED (
    SELECT
      p.id AS product_id,
      p.name AS product_name,
      p.manufacturer AS manufacturer_name,
      'مخزن المعرض'::text AS warehouse_name,
      COALESCE(rfs.retail_qty, 0) AS current_stock,
      COALESCE(rfs.sample_variant_id, 0) AS variant_id,
      p.wholesale_package,
      p.retail_package,
      COALESCE(ws.ws_qty, 0) AS wholesale_stock,
      (cna.product_id IS NOT NULL) AS is_new_arrival,
      CASE
        WHEN p.wholesale_package ~ 'كرتونة\\s*[0-9]+\\s*طقم' THEN
          (SUBSTRING(p.wholesale_package FROM 'كرتونة\\s*([0-9]+)\\s*طقم'))::integer
        WHEN (
          (CASE
            WHEN p.wholesale_package ~ '[0-9]+(?:\\.[0-9]+)?\\s*دستة' THEN (SUBSTRING(p.wholesale_package FROM '([0-9]+(?:\\.[0-9]+)?)\\s*دستة'))::numeric * 12
            WHEN p.wholesale_package ~ '[0-9]+\\s*قطعة' THEN (SUBSTRING(p.wholesale_package FROM '([0-9]+)\\s*قطعة'))::integer
            ELSE 0
          END) > 0
          AND COALESCE(
            NULLIF((SUBSTRING(p.retail_package FROM '([0-9]+)\\s*(?:علبة|شيالة|طقم|كيس|قطعة)')), '')::integer,
            NULLIF((SUBSTRING(p.retail_package FROM '(?:علبة|شيالة|طقم|كيس)\\s*([0-9]+)')), '')::integer,
            1
          ) > 0
        ) THEN
          GREATEST(1, ROUND(
            (CASE
              WHEN p.wholesale_package ~ '[0-9]+(?:\\.[0-9]+)?\\s*دستة' THEN (SUBSTRING(p.wholesale_package FROM '([0-9]+(?:\\.[0-9]+)?)\\s*دستة'))::numeric * 12
              WHEN p.wholesale_package ~ '[0-9]+\\s*قطعة' THEN (SUBSTRING(p.wholesale_package FROM '([0-9]+)\\s*قطعة'))::integer
              ELSE 0
            END)::numeric
            /
            COALESCE(
              NULLIF((SUBSTRING(p.retail_package FROM '([0-9]+)\\s*(?:علبة|شيالة|طقم|كيس|قطعة)')), '')::integer,
              NULLIF((SUBSTRING(p.retail_package FROM '(?:علبة|شيالة|طقم|كيس)\\s*([0-9]+)')), '')::integer,
              1
            )::numeric
          )::integer)
        ELSE 1
      END AS carton_capacity
    FROM products p
    LEFT JOIN ws_stock ws ON ws.product_id = p.id
    LEFT JOIN retail_family_stock rfs ON rfs.product_id = p.id
    LEFT JOIN confirmed_new_arrivals cna ON cna.product_id = p.id
    WHERE p.is_active = true
      AND p.retail_master_product_id IS NULL
      AND COALESCE(rfs.retail_qty, 0) >= 0
      AND (COALESCE(rfs.retail_qty, 0) > 0 OR COALESCE(ws.ws_qty, 0) > 0)
      AND (
        cna.product_id IS NOT NULL
        OR (p.wholesale_package IS NOT NULL AND p.wholesale_package != '')
      )
  ),
  computed_items AS MATERIALIZED (
    SELECT *
    FROM candidate_items
    WHERE is_new_arrival = true
       OR (
         (wholesale_package IS NOT NULL AND wholesale_package != '')
         AND (
           (carton_capacity > 1 AND current_stock <= GREATEST(1, ROUND(carton_capacity * 0.5)))
           OR (carton_capacity <= 1 AND current_stock <= 2)
         )
       )
  )
`;

async function getLowStockReorderSummary(pool) {
  const result = await pool.query(`
    ${REORDER_BASE_CTE}
    SELECT
      COUNT(*) AS total_count,
      COUNT(*) FILTER (WHERE is_new_arrival = true) AS new_arrival_count,
      COUNT(*) FILTER (WHERE is_new_arrival = false AND current_stock = 0) AS zero_count,
      COUNT(*) FILTER (WHERE current_stock > 0 AND (
        (carton_capacity > 1 AND (current_stock::numeric / carton_capacity::numeric) <= 0.25)
        OR (carton_capacity <= 4 AND current_stock <= 1)
      )) AS critical_count,
      COUNT(*) FILTER (WHERE current_stock > 0 AND NOT (
        (carton_capacity > 1 AND (current_stock::numeric / carton_capacity::numeric) <= 0.25)
        OR (carton_capacity <= 4 AND current_stock <= 1)
      )) AS warning_count
    FROM computed_items;
  `);

  const row = result.rows[0] || {};
  return {
    success: true,
    totalCount: Number(row.total_count || 0),
    newArrivalCount: Number(row.new_arrival_count || 0),
    zeroCount: Number(row.zero_count || 0),
    criticalCount: Number(row.critical_count || 0),
    warningCount: Number(row.warning_count || 0),
  };
}

async function getLowStockReorderList(pool) {
  const result = await pool.query(`
    ${REORDER_BASE_CTE}
    , arrivals_ts AS MATERIALIZED (
      SELECT
        cna.product_id,
        MAX(smw.created_at) AS arrived_at
      FROM confirmed_new_arrivals cna
      JOIN warehouses ww ON ww.name = 'المخزن الرئيسي'
      JOIN stock_movements smw ON smw.warehouse_id = ww.id
        AND smw.quantity > 0
        AND (
          smw.product_id = cna.product_id
          OR smw.product_id IN (
            SELECT pc.id FROM products pc WHERE pc.retail_master_product_id = cna.product_id
          )
        )
      GROUP BY cna.product_id
    )
    SELECT
      ci.product_id,
      ci.product_name,
      ci.manufacturer_name,
      ci.warehouse_name,
      ci.current_stock,
      ci.variant_id,
      ci.wholesale_package,
      ci.retail_package,
      ci.wholesale_stock,
      ci.is_new_arrival,
      ci.carton_capacity,
      ROUND((ci.current_stock::numeric / GREATEST(1, ci.carton_capacity)::numeric) * 100) AS stock_pct,
      ats.arrived_at AS wholesale_arrived_at,
      CASE
        WHEN ci.is_new_arrival = true THEN 'new_arrival'
        WHEN ci.current_stock = 0 THEN 'zero'
        WHEN (ci.carton_capacity > 1 AND (ci.current_stock::numeric / ci.carton_capacity::numeric) <= 0.25) OR (ci.carton_capacity <= 4 AND ci.current_stock <= 1) THEN 'critical_25'
        ELSE 'warning_50'
      END AS urgency_level
    FROM computed_items ci
    LEFT JOIN arrivals_ts ats ON ats.product_id = ci.product_id
    ORDER BY
      CASE
        WHEN ci.is_new_arrival = true THEN 0
        WHEN ci.current_stock = 0 THEN 1
        ELSE 2
      END ASC,
      CASE WHEN ci.is_new_arrival = true THEN ci.product_id END DESC NULLS LAST,
      (ci.current_stock::numeric / GREATEST(1, ci.carton_capacity)::numeric) ASC,
      ci.current_stock ASC;
  `);

  const variantsRes = await pool.query(
    `SELECT id, product_id, wholesale_package, retail_package FROM product_variants ORDER BY id`,
  );
  const variantsById = {};
  for (const v of variantsRes.rows) {
    variantsById[v.id] = v;
  }

  return result.rows.map((row) => {
    const vid = Number(row.variant_id) || 0;
    let pkgLabel;
    if (vid === 0) {
      pkgLabel =
        [row.wholesale_package, row.retail_package].filter(Boolean).join(" / ") ||
        "-";
    } else {
      const v = variantsById[vid];
      pkgLabel = v
        ? [v.wholesale_package, v.retail_package].filter(Boolean).join(" / ")
        : "-";
    }

    return {
      ...row,
      product_id: Number(row.product_id),
      variant_id: vid,
      current_stock: Number(row.current_stock) || 0,
      wholesale_stock: Number(row.wholesale_stock) || 0,
      carton_capacity: Number(row.carton_capacity) || 1,
      stock_pct: Number(row.stock_pct) || 0,
      is_new_arrival: Boolean(row.is_new_arrival),
      urgency_level: row.urgency_level || "warning_50",
      package_name: pkgLabel,
    };
  });
}

/**
 * Notify Showroom (branch_id = 1) when brand-new products arrive in
 * 'المخزن الرئيسي' (warehouse 2) for the very first time (no Showroom stock
 * and no prior movement history in 'مخزن المعرض').
 * Non-blocking: errors are logged cleanly without failing the parent mutation.
 */
async function notifyShowroomNewWarehouseArrivals({
  pool,
  productIds,
  fromUserId = null,
  referenceId = null,
  app = null,
  sendPushToBranch = null,
}) {
  try {
    const uniqueIds = [
      ...new Set(
        (productIds || [])
          .map((id) => Number(id))
          .filter((id) => Number.isFinite(id) && id > 0),
      ),
    ];
    if (uniqueIds.length === 0) return [];

    const arrivalsRes = await pool.query(
      `
      WITH target_masters AS (
        SELECT DISTINCT COALESCE(p.retail_master_product_id, p.id) AS master_id
        FROM products p
        WHERE p.id = ANY($1::int[])
          AND p.is_active = true
      ),
      ws_stock AS (
        SELECT
          COALESCE(p2.retail_master_product_id, p2.id) AS master_id,
          SUM(s2.quantity) AS ws_qty
        FROM stock s2
        JOIN products p2 ON p2.id = s2.product_id
        JOIN warehouses w2 ON w2.id = s2.warehouse_id
        WHERE w2.name = 'المخزن الرئيسي'
        GROUP BY COALESCE(p2.retail_master_product_id, p2.id)
      ),
      retail_stock AS (
        SELECT
          COALESCE(p3.retail_master_product_id, p3.id) AS master_id,
          SUM(s3.quantity) AS retail_qty
        FROM stock s3
        JOIN products p3 ON p3.id = s3.product_id
        JOIN warehouses w3 ON w3.id = s3.warehouse_id
        WHERE w3.name = 'مخزن المعرض'
        GROUP BY COALESCE(p3.retail_master_product_id, p3.id)
      )
      SELECT
        m.id AS product_id,
        m.name AS product_name,
        COALESCE(ws.ws_qty, 0) AS wholesale_stock
      FROM target_masters tm
      JOIN products m ON m.id = tm.master_id
      LEFT JOIN ws_stock ws ON ws.master_id = m.id
      LEFT JOIN retail_stock rs ON rs.master_id = m.id
      WHERE m.is_active = true
        AND COALESCE(ws.ws_qty, 0) > 0
        AND COALESCE(rs.retail_qty, 0) = 0
        AND NOT EXISTS (
          SELECT 1
          FROM stock_movements sm
          JOIN warehouses wm ON wm.id = sm.warehouse_id
          WHERE wm.name = 'مخزن المعرض'
            AND (
              sm.product_id = m.id
              OR sm.product_id IN (
                SELECT pc.id FROM products pc WHERE pc.retail_master_product_id = m.id
              )
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM notifications n
          WHERE n.to_branch_id = 1
            AND n.type = 'new_warehouse_arrival'
            AND n.created_at >= NOW() - INTERVAL '12 hours'
            AND n.message LIKE '%«' || replace(replace(replace(m.name, '\', '\\'), '%', '\%'), '_', '\_') || '»%' ESCAPE '\'
        )
      ORDER BY m.id DESC;
      `,
      [uniqueIds],
    );

    const arrivals = arrivalsRes.rows || [];
    if (arrivals.length === 0) return [];

    const SHOWROOM_BRANCH_ID = 1;
    const title =
      arrivals.length === 1
        ? "صنف جديد وصل المخزن الرئيسي"
        : `${arrivals.length} أصناف جديدة وصلت المخزن`;

    const message =
      arrivals.length === 1
        ? `وصل صنف جديد للمخزن الرئيسي لأول مرة: «${arrivals[0].product_name}» (${Number(arrivals[0].wholesale_stock)} كرتونة) — متاح للتحويل للمعرض`
        : `وصلت ${arrivals.length} أصناف جديدة للمخزن الرئيسي لأول مرة: ${arrivals
            .slice(0, 5)
            .map((a) => `«${a.product_name}»`)
            .join("، ")}${arrivals.length > 5 ? ` (+${arrivals.length - 5} آخرين)` : ""} — متاحة في طلب التحويل`;

    await pool.query(
      `INSERT INTO notifications (title, message, from_user_id, to_branch_id, type, reference_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        title,
        message,
        fromUserId || null,
        SHOWROOM_BRANCH_ID,
        "new_warehouse_arrival",
        referenceId || null,
      ],
    );

    if (app) {
      const broadcast = app.get("broadcastRealtime");
      const notifPayload = {
        title,
        message,
        type: "new_warehouse_arrival",
        reference_id: referenceId || null,
      };
      if (typeof broadcast === "function") {
        broadcast("new_notification", notifPayload, `branch_${SHOWROOM_BRANCH_ID}`);
      } else {
        const io = app.get("io");
        if (io) {
          io.to(`branch_${SHOWROOM_BRANCH_ID}`).emit(
            "new_notification",
            notifPayload,
          );
        }
      }
    }

    if (typeof sendPushToBranch === "function") {
      sendPushToBranch(SHOWROOM_BRANCH_ID, title, message, {
        type: "new_warehouse_arrival",
        reference_id: referenceId || null,
        url: "/reports/low-stock-reorder",
      });
    }

    return arrivals;
  } catch (err) {
    console.error("NEW WAREHOUSE ARRIVAL NOTIFY ERROR:", err);
    return [];
  }
}

module.exports = {
  REORDER_BASE_CTE,
  getLowStockReorderSummary,
  getLowStockReorderList,
  notifyShowroomNewWarehouseArrivals,
};
