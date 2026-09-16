const pool = require("../db");
const crypto = require("crypto");

function normalizeUrl(u) {
  return String(u || "").trim().replace(/\/+$/, "").toLowerCase();
}

// ==========================================
// Warehouses & Connections
// ==========================================
exports.getWarehouses = async (req, res) => {
  try {
    const result = await pool.query("SELECT id, name FROM warehouses ORDER BY id");
    res.json(result.rows);
  } catch (error) {
    console.error("getWarehouses error:", error);
    res.status(500).json({ error: error.message });
  }
};
exports.getConnections = async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM branch_connections ORDER BY created_at DESC");
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
};

exports.addConnection = async (req, res) => {
  try {
    const { branch_name, remote_url } = req.body;
    if (!branch_name || !remote_url) return res.status(400).json({ error: "الاسم والرابط مطلوبان" });
    const result = await pool.query(
      "INSERT INTO branch_connections (branch_name, remote_url) VALUES ($1, $2) RETURNING *",
      [branch_name, remote_url]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
};

exports.removeConnection = async (req, res) => {
  try {
    await pool.query("DELETE FROM branch_connections WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
};


async function sendS2SRequest(url, endpoint, payload) {
  const API_KEY = process.env.INTER_BRANCH_API_KEY || "TEST_API_KEY_123";
  const SELF_URL = normalizeUrl(process.env.SELF_PUBLIC_URL || "http://localhost:3000");
  const fullUrl = `${url.replace(/\/$/, "")}${endpoint}`;
  
  const finalPayload = { ...payload, origin_url: SELF_URL };
  
  const response = await fetch(fullUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
    },
    body: JSON.stringify(finalPayload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`S2S Error (${response.status}): ${errorText}`);
  }
  return response.json();
}

exports.getLedger = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT remote_branch_url, SUM(amount) as balance
       FROM external_branches_ledger
       GROUP BY remote_branch_url`
    );
    res.json(result.rows);
  } catch (e) {
    console.error("getLedger error:", e);
    res.status(500).json({ error: e.message });
  }
};

exports.getTransfers = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT t.*, 
        (SELECT json_agg(json_build_object(
          'id', i.id, 'barcode', i.barcode, 'product_name', i.product_name, 
          'quantity', i.quantity, 'transfer_price', i.transfer_price, 'original_cost', i.original_cost
        )) FROM inter_branch_transfer_items i WHERE i.transfer_id = t.id) as items
       FROM inter_branch_transfers t
       ORDER BY t.created_at DESC`
    );
    res.json(result.rows);
  } catch (e) {
    console.error("getTransfers error:", e);
    res.status(500).json({ error: e.message });
  }
};

// ==========================================
// User Actions
// ==========================================

exports.createRequest = async (req, res) => {
  const { connection_id, items } = req.body;
  const transfer_uuid = crypto.randomUUID();
  const client = await pool.connect();

  try {
    // Get connection
    const connRes = await client.query("SELECT * FROM branch_connections WHERE id = $1", [connection_id]);
    if (connRes.rows.length === 0) throw new Error("Branch connection not found");
    const remote_branch_url = normalizeUrl(connRes.rows[0].remote_url);
    await client.query("BEGIN");
    
    // Calculate total value
    const total_value = items.reduce((sum, item) => sum + (Number(item.quantity) * Number(item.transfer_price)), 0);

    // 1. Create local inbound draft
    const insertTransfer = await client.query(
      `INSERT INTO inter_branch_transfers 
       (transfer_uuid, direction, status, remote_branch_url, total_value) 
       VALUES ($1, 'inbound', 'pending_dispatch', $2, $3) RETURNING id`,
      [transfer_uuid, remote_branch_url, total_value]
    );
    const transferId = insertTransfer.rows[0].id;

    // Insert items
    for (const item of items) {
      await client.query(
        `INSERT INTO inter_branch_transfer_items 
         (transfer_id, barcode, product_name, quantity, transfer_price, original_cost)
         VALUES ($1, $2, $3, $4, $5, 0)`,
        [transferId, item.barcode, item.product_name, item.quantity, item.transfer_price]
      );
    }

    // 2. Call remote webhook
    await sendS2SRequest(remote_branch_url, "/api/inter-branch/webhook/request", {
      transfer_uuid,
      items,
      total_value
    });

    await client.query("COMMIT");
    res.json({ success: true, transfer_id: transferId });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("createRequest error:", e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
};

exports.dispatchTransfer = async (req, res) => {
  const { id } = req.params;
  const { warehouse_id } = req.body;
  if (!warehouse_id) return res.status(400).json({ error: "Warehouse ID is required" });

  const client = await pool.connect();
  
  try {
    await client.query("BEGIN");

    // Get transfer
    const tRes = await client.query(`SELECT * FROM inter_branch_transfers WHERE id = $1`, [id]);
    if (tRes.rowCount === 0) throw new Error("Transfer not found");
    const transfer = tRes.rows[0];
    
    if (transfer.direction !== "outbound") throw new Error("Can only dispatch outbound transfers");
    if (transfer.status !== "pending_dispatch") throw new Error("Transfer is not pending dispatch");

    // Fetch items
    const iRes = await client.query(`SELECT * FROM inter_branch_transfer_items WHERE transfer_id = $1`, [id]);
    const items = iRes.rows;

    let total_cost = 0;

    // Deduct stock & calculate original_cost
    for (const item of items) {
      // Find local product by barcode
      const pRes = await client.query(`SELECT id, purchase_price, retail_purchase_price FROM products WHERE barcode = $1`, [item.barcode]);
      if (pRes.rowCount === 0) throw new Error(`Product ${item.barcode} not found locally`);
      const prod = pRes.rows[0];

      // Insert stock movement
      await client.query(
        `INSERT INTO stock_movements (warehouse_id, product_id, variant_id, quantity, movement_type, reference_type, reference_id, note)
         VALUES ($1, $2, 0, $3, 'inter_branch_out', 'inter_branch', $4, $5)`,
        [warehouse_id, prod.id, item.quantity, id, `Dispatched to ${transfer.remote_branch_url}`]
      );
      
      // Update actual stock (guarded decrement)
      const decRes = await client.query(
        `UPDATE stock SET quantity = quantity - $1
         WHERE product_id = $2 AND warehouse_id = $3 AND COALESCE(variant_id, 0) = 0
           AND quantity >= $1`,
        [item.quantity, prod.id, warehouse_id]
      );
      if (decRes.rowCount === 0) {
        throw new Error(`الكمية غير متوفرة في المخزن للصنف: ${item.product_name || item.barcode}`);
      }

      // Determine original_cost based on warehouse (1 = retail, else wholesale)
      const original_cost = Number(warehouse_id) === 1 ? (prod.retail_purchase_price || prod.purchase_price) : prod.purchase_price;

      // Update original cost in transfer items
      await client.query(
        `UPDATE inter_branch_transfer_items SET original_cost = $1 WHERE id = $2`,
        [original_cost, item.id]
      );

      total_cost += (Number(original_cost) * Number(item.quantity));
    }

    // Update transfer status
    await client.query(
      `UPDATE inter_branch_transfers 
       SET status = 'in_transit', dispatched_at = NOW(), total_cost = $1
       WHERE id = $2`,
      [total_cost, id]
    );

    // Call remote webhook
    await sendS2SRequest(transfer.remote_branch_url, "/api/inter-branch/webhook/dispatch", {
      transfer_uuid: transfer.transfer_uuid
    });

    await client.query("COMMIT");
    res.json({ success: true });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("dispatchTransfer error:", e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
};

exports.receiveTransfer = async (req, res) => {
  const { id } = req.params;
  const { warehouse_id } = req.body;
  if (!warehouse_id) return res.status(400).json({ error: "Warehouse ID is required" });

  const client = await pool.connect();
  
  try {
    await client.query("BEGIN");

    const tRes = await client.query(`SELECT * FROM inter_branch_transfers WHERE id = $1`, [id]);
    if (tRes.rowCount === 0) throw new Error("Transfer not found");
    const transfer = tRes.rows[0];
    
    if (transfer.direction !== "inbound") throw new Error("Can only receive inbound transfers");
    if (transfer.status !== "in_transit") throw new Error("Transfer is not in transit");

    const iRes = await client.query(`SELECT * FROM inter_branch_transfer_items WHERE transfer_id = $1`, [id]);
    const items = iRes.rows;

    for (const item of items) {
      const pRes = await client.query(`SELECT id, purchase_price, retail_purchase_price FROM products WHERE barcode = $1`, [item.barcode]);
      if (pRes.rowCount === 0) throw new Error(`Product ${item.barcode} not found locally`);
      const prod = pRes.rows[0];

      // Add stock movement
      await client.query(
        `INSERT INTO stock_movements (warehouse_id, product_id, variant_id, quantity, movement_type, reference_type, reference_id, note)
         VALUES ($1, $2, 0, $3, 'inter_branch_in', 'inter_branch', $4, $5)`,
        [warehouse_id, prod.id, item.quantity, id, `Received from ${transfer.remote_branch_url}`]
      );
      
      // Upsert stock
      const stockRes = await client.query(
        `INSERT INTO stock (warehouse_id, product_id, variant_id, quantity)
         VALUES ($1, $2, 0, $3)
         ON CONFLICT (warehouse_id, product_id, variant_id)
         DO UPDATE SET quantity = stock.quantity + $3
         RETURNING quantity AS new_qty, (quantity - $3) AS old_qty`,
        [warehouse_id, prod.id, item.quantity]
      );
      
      const old_qty = Number(stockRes.rows[0].old_qty) || 0;
      const recv_qty = Number(item.quantity) || 0;
      
      const is_retail = Number(warehouse_id) === 1;
      const old_cost = is_retail ? (prod.retail_purchase_price || prod.purchase_price) : prod.purchase_price;
      const transfer_price = Number(item.transfer_price) || 0;
      
      // Weighted average cost
      let new_cost = old_cost;
      if (old_qty + recv_qty > 0) {
        new_cost = ((old_qty * old_cost) + (recv_qty * transfer_price)) / (old_qty + recv_qty);
      }
      
      const cost_column = is_retail ? 'retail_purchase_price' : 'purchase_price';
      await client.query(
        `UPDATE products SET ${cost_column} = $1 WHERE id = $2`,
        [new_cost, prod.id]
      );
    }

    // Update transfer status
    await client.query(
      `UPDATE inter_branch_transfers 
       SET status = 'received', received_at = NOW()
       WHERE id = $1`,
      [id]
    );

    // Update Ledger (Inbound received -> We owe them -> Negative amount)
    await client.query(
      `INSERT INTO external_branches_ledger (remote_branch_url, transfer_id, amount, notes)
       VALUES ($1, $2, $3, $4)`,
      [transfer.remote_branch_url, id, -transfer.total_value, `Transfer Received: ${transfer.transfer_uuid}`]
    );

    // Call remote webhook
    await sendS2SRequest(transfer.remote_branch_url, "/api/inter-branch/webhook/receive", {
      transfer_uuid: transfer.transfer_uuid
    });

    await client.query("COMMIT");
    res.json({ success: true });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("receiveTransfer error:", e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
};


// ==========================================
// Webhooks
// ==========================================

exports.webhookRequest = async (req, res) => {
  const { transfer_uuid, items, total_value, origin_url } = req.body;
  
  const remote_branch_url = normalizeUrl(origin_url || "REMOTE_SYSTEM"); 
  
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // They requested from us -> it's an outbound draft for us
    const insertTransfer = await client.query(
      `INSERT INTO inter_branch_transfers 
       (transfer_uuid, direction, status, remote_branch_url, total_value) 
       VALUES ($1, 'outbound', 'pending_dispatch', $2, $3) RETURNING id`,
      [transfer_uuid, remote_branch_url, total_value]
    );
    const transferId = insertTransfer.rows[0].id;

    for (const item of items) {
      await client.query(
        `INSERT INTO inter_branch_transfer_items 
         (transfer_id, barcode, product_name, quantity, transfer_price, original_cost)
         VALUES ($1, $2, $3, $4, $5, 0)`,
        [transferId, item.barcode, item.product_name, item.quantity, item.transfer_price]
      );
    }

    await client.query("COMMIT");

    // 🔔 Live Notification to branch
    const broadcast = req.app.get("broadcastRealtime");
    if (typeof broadcast === "function") {
      broadcast("new_notification", {
        title: "طلب بضاعة بين الفروع",
        message: `وصل طلب تحويل أصناف جديد بإجمالي ${total_value} ج.م`,
        type: "inter_branch",
        reference_id: transferId
      });
    }

    res.json({ success: true });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("webhookRequest error:", e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
};

exports.webhookDispatch = async (req, res) => {
  const { transfer_uuid } = req.body;
  try {
    const upd = await pool.query(
      `UPDATE inter_branch_transfers SET status = 'in_transit', dispatched_at = NOW() WHERE transfer_uuid = $1 AND direction = 'inbound'`,
      [transfer_uuid]
    );
    if (upd.rowCount === 0) return res.status(404).json({ error: "Transfer not found" });

    // 🔔 Live Notification to branch
    const broadcast = req.app.get("broadcastRealtime");
    if (typeof broadcast === "function") {
      broadcast("new_notification", {
        title: "شحن أصناف بين الفروع",
        message: `تم شحن البضاعة المطلوبة من الفرع الآخر وهي في الطريق إليكم`,
        type: "inter_branch",
        reference_id: transfer_uuid
      });
    }

    res.json({ success: true });
  } catch (e) {
    console.error("webhookDispatch error:", e);
    res.status(500).json({ error: e.message });
  }
};

exports.webhookReceive = async (req, res) => {
  const { transfer_uuid } = req.body;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const tRes = await client.query(`SELECT * FROM inter_branch_transfers WHERE transfer_uuid = $1 AND direction = 'outbound'`, [transfer_uuid]);
    if (tRes.rowCount === 0) throw new Error("Transfer not found");
    const transfer = tRes.rows[0];

    // Update status
    await client.query(
      `UPDATE inter_branch_transfers SET status = 'received', received_at = NOW() WHERE id = $1`,
      [transfer.id]
    );

    // Update Ledger (Outbound received by them -> They owe us -> Positive amount)
    await client.query(
      `INSERT INTO external_branches_ledger (remote_branch_url, transfer_id, amount, notes)
       VALUES ($1, $2, $3, $4)`,
      [transfer.remote_branch_url, transfer.id, transfer.total_value, `Transfer Completed: ${transfer_uuid}`]
    );

    await client.query("COMMIT");

    // 🔔 Live Notification to branch
    const broadcast = req.app.get("broadcastRealtime");
    if (typeof broadcast === "function") {
      broadcast("new_notification", {
        title: "تأكيد استلام شحنة",
        message: `تم تأكيد استلام الشحنة وإضافتها للحساب التبادلي بنجاح`,
        type: "inter_branch",
        reference_id: transfer.id
      });
    }

    res.json({ success: true });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("webhookReceive error:", e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
};

// ==========================================
// Product Querying Extensions
// ==========================================

exports.webhookProducts = async (req, res) => {
  try {
    const { q = "" } = req.query;
    
    let queryStr = `
      SELECT * FROM (
        SELECT 
          p.id,
          p.barcode, 
          p.name, 
          p.purchase_price, 
          p.retail_purchase_price,
          p.wholesale_price,
          p.retail_price,
          p.discount_amount,
          p.manufacturer,
          p.wholesale_package,
          p.retail_package,
          p.description,
          COALESCE((SELECT SUM(s.quantity) FROM stock s WHERE s.product_id = p.id), 0) AS stock_quantity
        FROM products p
        WHERE p.is_active = true
      ) as sub
      WHERE stock_quantity > 0
    `;
    const queryParams = [];
    if (q) {
      queryStr += ` AND (name ILIKE $1 OR barcode ILIKE $1)`;
      queryParams.push(`%${q}%`);
    }

    const result = await pool.query(queryStr, queryParams);

    res.json(result.rows);
  } catch (error) {
    console.error("Webhook Products Error:", error);
    res.status(500).json({ error: error.message });
  }
};

exports.getRemoteProducts = async (req, res) => {
  try {
    const { connection_id, q = "" } = req.query;
    if (!connection_id) return res.json([]);

    const connRes = await pool.query("SELECT remote_url FROM branch_connections WHERE id = $1", [connection_id]);
    if (connRes.rows.length === 0) return res.status(404).json({ error: "Connection not found" });
    const remote_url = connRes.rows[0].remote_url;

    const API_KEY = process.env.INTER_BRANCH_API_KEY || "TEST_API_KEY_123";
    const fullUrl = `${remote_url.replace(/\/$/, "")}/api/inter-branch/webhook/products?q=${encodeURIComponent(q)}`;
    
    const response = await fetch(fullUrl, {
      method: "GET",
      headers: {
        "x-api-key": API_KEY,
      }
    });

    if (!response.ok) {
      throw new Error(`Remote API returned ${response.status}`);
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error("Proxy Remote Products Error:", error);
    res.status(500).json({ error: "Failed to fetch from remote branch" });
  }
};

// ==========================================
// Instant Pull Feature
// ==========================================

exports.instantPull = async (req, res) => {
  const { connection_id, warehouse_id, items } = req.body;
  if (!warehouse_id) return res.status(400).json({ error: "لازم تختار المخزن المحلي" });
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "أضف صنف واحد على الأقل" });

  const connRes = await pool.query("SELECT * FROM branch_connections WHERE id = $1", [connection_id]);
  if (connRes.rows.length === 0) return res.status(404).json({ error: "الفرع الآخر غير موجود" });
  const remote_branch_url = normalizeUrl(connRes.rows[0].remote_url);

  for (const item of items) {
    const p = await pool.query(`SELECT id FROM products WHERE barcode = $1`, [item.barcode]);
    if (p.rowCount === 0) return res.status(400).json({ error: `الصنف غير موجود عندك محليًا: ${item.product_name || item.barcode}` });
  }

  const transfer_uuid = crypto.randomUUID();
  const total_value = items.reduce((s, i) => s + (Number(i.quantity) * Number(i.transfer_price)), 0);

  let transferId;
  {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const ins = await client.query(
        `INSERT INTO inter_branch_transfers (transfer_uuid, direction, status, remote_branch_url, total_value)
         VALUES ($1, 'inbound', 'pending_dispatch', $2, $3) RETURNING id`,
        [transfer_uuid, remote_branch_url, total_value]
      );
      transferId = ins.rows[0].id;
      for (const item of items) {
        await client.query(
          `INSERT INTO inter_branch_transfer_items (transfer_id, barcode, product_name, quantity, transfer_price, original_cost)
           VALUES ($1, $2, $3, $4, $5, 0)`,
          [transferId, item.barcode, item.product_name, item.quantity, item.transfer_price]
        );
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK"); client.release();
      console.error("instantPull(intent) error:", e);
      return res.status(500).json({ error: e.message });
    }
    client.release();
  }

  let remote;
  try {
    remote = await sendS2SRequest(remote_branch_url, "/api/inter-branch/webhook/instant-pull", {
      transfer_uuid, items, total_value
    });
  } catch (e) {
    await pool.query(`UPDATE inter_branch_transfers SET status='rejected' WHERE id=$1`, [transferId]);
    console.error("instantPull(remote) error:", e);
    return res.status(502).json({ error: `تعذّر السحب من الفرع الآخر: ${e.message}` });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const cur = await client.query(`SELECT status FROM inter_branch_transfers WHERE id=$1 FOR UPDATE`, [transferId]);
    if (cur.rows[0].status === "received") {
      await client.query("COMMIT"); client.release();
      return res.json({ success: true, transfer_id: transferId, items });
    }

    for (const item of items) {
      const pRes = await client.query(`SELECT id, purchase_price, retail_purchase_price FROM products WHERE barcode=$1`, [item.barcode]);
      if (pRes.rowCount === 0) throw new Error(`الصنف غير موجود محليًا: ${item.product_name || item.barcode}`);
      const prod = pRes.rows[0];

      await client.query(
        `INSERT INTO stock_movements (warehouse_id, product_id, variant_id, quantity, movement_type, reference_type, reference_id, note)
         VALUES ($1, $2, 0, $3, 'inter_branch_in', 'inter_branch', $4, $5)`,
        [warehouse_id, prod.id, item.quantity, transferId, `Instant pull from ${remote_branch_url}`]
      );

      const stockRes = await client.query(
        `INSERT INTO stock (warehouse_id, product_id, variant_id, quantity)
         VALUES ($1, $2, 0, $3)
         ON CONFLICT (warehouse_id, product_id, variant_id)
         DO UPDATE SET quantity = stock.quantity + $3
         RETURNING (quantity - $3) AS old_qty`,
        [warehouse_id, prod.id, item.quantity]
      );

      const old_qty = Number(stockRes.rows[0].old_qty) || 0;
      const recv_qty = Number(item.quantity) || 0;
      const is_retail = Number(warehouse_id) === 1;
      const old_cost = is_retail ? (prod.retail_purchase_price || prod.purchase_price) : prod.purchase_price;
      const transfer_price = Number(item.transfer_price) || 0;

      let new_cost = old_cost;
      if (old_qty + recv_qty > 0) {
        new_cost = ((old_qty * old_cost) + (recv_qty * transfer_price)) / (old_qty + recv_qty);
      }
      const cost_column = is_retail ? "retail_purchase_price" : "purchase_price";
      await client.query(`UPDATE products SET ${cost_column} = $1 WHERE id = $2`, [new_cost, prod.id]);
    }

    await client.query(`UPDATE inter_branch_transfers SET status='received', received_at=NOW() WHERE id=$1`, [transferId]);

    await client.query(
      `INSERT INTO external_branches_ledger (remote_branch_url, transfer_id, amount, notes)
       VALUES ($1, $2, $3, $4)`,
      [remote_branch_url, transferId, -total_value, `Instant Pull: ${transfer_uuid}`]
    );

    await client.query("COMMIT");
    res.json({ success: true, transfer_id: transferId, items });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("instantPull(local-add) error:", e);
    try {
      await sendS2SRequest(remote_branch_url, "/api/inter-branch/webhook/instant-pull/cancel", { transfer_uuid });
      await pool.query(`UPDATE inter_branch_transfers SET status='cancelled' WHERE id=$1`, [transferId]);
      res.status(500).json({ error: "تعذّر إتمام السحب، وتم إلغاء العملية في الفرع الآخر. حاول تاني." });
    } catch (compErr) {
      await pool.query(`UPDATE inter_branch_transfers SET status='needs_reconciliation' WHERE id=$1`, [transferId]);
      console.error("instantPull(compensation FAILED) uuid=" + transfer_uuid, compErr);
      res.status(500).json({ error: "تعذّر إتمام السحب وفشل الإلغاء في الفرع الآخر. راجع البوابة يدويًا (transfer_uuid: " + transfer_uuid + ")." });
    }
  } finally {
    client.release();
  }
};

exports.webhookInstantPull = async (req, res) => {
  const { transfer_uuid, items, total_value, origin_url } = req.body;
  const remote_branch_url = normalizeUrl(origin_url || "REMOTE_SYSTEM");
  const SOURCE_WH = Number(process.env.INTER_BRANCH_SOURCE_WAREHOUSE_ID || 2);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const existing = await client.query(
      `SELECT id, status FROM inter_branch_transfers WHERE transfer_uuid=$1 FOR UPDATE`, [transfer_uuid]
    );
    if (existing.rowCount > 0) {
      if (existing.rows[0].status === "received") {
        const its = await client.query(
          `SELECT barcode, original_cost FROM inter_branch_transfer_items WHERE transfer_id=$1`, [existing.rows[0].id]
        );
        await client.query("COMMIT"); client.release();
        return res.json({ success: true, items: its.rows });
      }
      await client.query("ROLLBACK"); client.release();
      return res.status(409).json({ error: "Transfer in a non-replayable state" });
    }

    const outItems = [];
    for (const item of items) {
      const pRes = await client.query(`SELECT id, purchase_price, retail_purchase_price FROM products WHERE barcode=$1`, [item.barcode]);
      if (pRes.rowCount === 0) throw new Error(`الصنف غير موجود في الفرع الآخر: ${item.product_name || item.barcode}`);
      const prod = pRes.rows[0];

      await client.query(
        `INSERT INTO stock_movements (warehouse_id, product_id, variant_id, quantity, movement_type, reference_type, reference_id, note)
         VALUES ($1, $2, 0, $3, 'inter_branch_out', 'inter_branch', NULL, $4)`,
        [SOURCE_WH, prod.id, item.quantity, `Instant pull by ${remote_branch_url}`]
      );

      const dec = await client.query(
        `UPDATE stock SET quantity = quantity - $1
         WHERE product_id=$2 AND warehouse_id=$3 AND COALESCE(variant_id,0)=0 AND quantity >= $1`,
        [item.quantity, prod.id, SOURCE_WH]
      );
      if (dec.rowCount === 0) throw new Error(`الكمية غير متوفرة في الفرع الآخر للصنف: ${item.product_name || item.barcode}`);

      const original_cost = SOURCE_WH === 1 ? (prod.retail_purchase_price || prod.purchase_price) : prod.purchase_price;
      outItems.push({ barcode: item.barcode, product_name: item.product_name, quantity: item.quantity, transfer_price: item.transfer_price, original_cost });
    }

    const ins = await client.query(
      `INSERT INTO inter_branch_transfers (transfer_uuid, direction, status, remote_branch_url, total_value, total_cost, dispatched_at, received_at)
       VALUES ($1, 'outbound', 'received', $2, $3, $4, NOW(), NOW()) RETURNING id`,
      [transfer_uuid, remote_branch_url, total_value, outItems.reduce((s, i) => s + Number(i.original_cost) * Number(i.quantity), 0)]
    );
    const tid = ins.rows[0].id;
    for (const it of outItems) {
      await client.query(
        `INSERT INTO inter_branch_transfer_items (transfer_id, barcode, product_name, quantity, transfer_price, original_cost)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [tid, it.barcode, it.product_name, it.quantity, it.transfer_price, it.original_cost]
      );
    }

    await client.query(
      `INSERT INTO external_branches_ledger (remote_branch_url, transfer_id, amount, notes)
       VALUES ($1, $2, $3, $4)`,
      [remote_branch_url, tid, total_value, `Instant Pull served: ${transfer_uuid}`]
    );

    await client.query("COMMIT");
    res.json({ success: true, items: outItems });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("webhookInstantPull error:", e);
    res.status(400).json({ error: e.message });
  } finally {
    client.release();
  }
};

exports.webhookInstantPullCancel = async (req, res) => {
  const { transfer_uuid } = req.body;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tRes = await client.query(
      `SELECT * FROM inter_branch_transfers WHERE transfer_uuid=$1 AND direction='outbound' FOR UPDATE`, [transfer_uuid]
    );
    if (tRes.rowCount === 0) { await client.query("ROLLBACK"); client.release(); return res.json({ success: true }); }
    const transfer = tRes.rows[0];
    if (transfer.status === "cancelled") { await client.query("ROLLBACK"); client.release(); return res.json({ success: true }); }

    const SOURCE_WH = Number(process.env.INTER_BRANCH_SOURCE_WAREHOUSE_ID || 2);
    const its = await client.query(`SELECT * FROM inter_branch_transfer_items WHERE transfer_id=$1`, [transfer.id]);
    for (const item of its.rows) {
      const pRes = await client.query(`SELECT id FROM products WHERE barcode=$1`, [item.barcode]);
      if (pRes.rowCount === 0) continue;
      const prod = pRes.rows[0];
      await client.query(
        `INSERT INTO stock_movements (warehouse_id, product_id, variant_id, quantity, movement_type, reference_type, reference_id, note)
         VALUES ($1, $2, 0, $3, 'inter_branch_in', 'inter_branch', $4, $5)`,
        [SOURCE_WH, prod.id, item.quantity, transfer.id, `Instant pull cancelled: ${transfer_uuid}`]
      );
      await client.query(
        `INSERT INTO stock (warehouse_id, product_id, variant_id, quantity) VALUES ($1, $2, 0, $3)
         ON CONFLICT (warehouse_id, product_id, variant_id) DO UPDATE SET quantity = stock.quantity + $3`,
        [SOURCE_WH, prod.id, item.quantity]
      );
    }
    await client.query(
      `INSERT INTO external_branches_ledger (remote_branch_url, transfer_id, amount, notes)
       VALUES ($1, $2, $3, $4)`,
      [transfer.remote_branch_url, transfer.id, -transfer.total_value, `Instant Pull reversed: ${transfer_uuid}`]
    );
    await client.query(`UPDATE inter_branch_transfers SET status='cancelled' WHERE id=$1`, [transfer.id]);
    await client.query("COMMIT");
    res.json({ success: true });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("webhookInstantPullCancel error:", e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
};

