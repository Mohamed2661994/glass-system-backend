const fs = require('fs');
const p = 'D:/Glass System B3/branch-3-backend/inter-branch/inter-branch.controller.js';
let code = fs.readFileSync(p, 'utf8');
const start = code.indexOf('exports.webhookProducts = async');
const end = code.indexOf('exports.getRemoteProducts = async');
const newFunc = `exports.webhookProducts = async (req, res) => {
  try {
    const { q = "" } = req.query;
    
    let queryStr = \`
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
    \`;
    const queryParams = [];
    if (q) {
      queryStr += " AND (name ILIKE $1 OR barcode ILIKE $1)";
      queryParams.push("%" + q + "%");
    }

    const result = await pool.query(queryStr, queryParams);
    res.json(result.rows);
  } catch (error) {
    console.error("Webhook Products Error:", error);
    res.status(500).json({ error: error.message });
  }
};

`;
code = code.substring(0, start) + newFunc + code.substring(end);
fs.writeFileSync(p, code);
console.log('Fixed Branch 3');
