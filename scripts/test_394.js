require('dotenv').config();
const pool = require('../db');

async function test394() {
  try {
    const id = 394;
    const invoiceRes = await pool.query(
      `SELECT * FROM invoices WHERE id = $1`,
      [id],
    );

    if (!invoiceRes.rows.length) {
      console.log("Invoice not found");
      return;
    }

    const invoice = invoiceRes.rows[0];

    const itemsRes = await pool.query(
      `
      SELECT
        ii.product_id,
        ii.product_name,
        ii.package,
        ii.price,
        ii.quantity,
        ii.discount,
        ii.total,
        COALESCE(ii.variant_id, 0) AS variant_id,
        ii.is_return,
        p.manufacturer
      FROM invoice_items ii
      JOIN products p ON p.id = ii.product_id
      WHERE ii.invoice_id = $1
      ORDER BY ii.id
      `,
      [id],
    );

    let items_discount = 0;
    let extra_discount = 0;

    if (invoice.invoice_type === "wholesale") {
      items_discount = itemsRes.rows.reduce(
        (sum, it) => sum + (it.discount || 0) * it.quantity,
        0,
      );
      extra_discount = Number(invoice.manual_discount || 0);
    } else {
      items_discount = itemsRes.rows.reduce(
        (sum, it) => sum + (it.discount || 0) * it.quantity,
        0,
      );
      extra_discount = Number(invoice.manual_discount || 0);
    }

    const response = {
      id: invoice.id,
      invoice_type: invoice.invoice_type,
      movement_type: invoice.movement_type,
      invoice_date: invoice.invoice_date,
      customer_name: invoice.customer_name,
      customer_phone: invoice.customer_phone,
      subtotal: invoice.subtotal,
      items_discount,
      extra_discount: Number(invoice.manual_discount || 0),
      manual_discount: Number(invoice.manual_discount || 0),
      discount_total: invoice.discount_total,
      total: invoice.total,
      paid_amount: invoice.paid_amount,
      previous_balance: invoice.previous_balance,
      additional_amount: invoice.additional_amount,
      remaining_amount: invoice.remaining_amount,
      payment_status: invoice.payment_status,
      apply_items_discount: invoice.apply_items_discount,
      is_return: invoice.is_return || false,
      invoice_revision: Number(invoice.invoice_revision || 0),
      hidden_from_list: Boolean(invoice.hidden_from_list),
      hidden_from_list_at: invoice.hidden_from_list_at || null,
      hidden_from_list_by: invoice.hidden_from_list_by || null,
      invoice_source: invoice.invoice_source || null,
      external_order_id: invoice.external_order_id || null,
      supplier_id: invoice.supplier_id,
      supplier_name: invoice.supplier_name,
      supplier_phone: invoice.supplier_phone,
      notes: invoice.notes,
      created_by: invoice.created_by,
      created_by_name: invoice.created_by_name,
      updated_by: invoice.updated_by,
      updated_by_name: invoice.updated_by_name,
      items: itemsRes.rows,
    };

    console.log("Success! Response size:", JSON.stringify(response).length);
    process.exit(0);
  } catch (err) {
    console.error("Caught error:", err);
    process.exit(1);
  }
}

test394();
