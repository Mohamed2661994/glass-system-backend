require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const pool = new Pool({
  host: process.env.DB_HOST_CLOUD,
  port: process.env.DB_PORT_CLOUD,
  user: process.env.DB_USER_CLOUD,
  password: process.env.DB_PASSWORD_CLOUD,
  database: process.env.DB_NAME_CLOUD
});

async function getInvoices() {
  const userId = 14;
  try {
    const res = await pool.query('SELECT id, invoice_number, invoice_type, total, created_at FROM invoices WHERE created_by = ' + userId + ' ORDER BY created_at DESC');
    let md = '# فواتير المستخدم محمود يوسف\n\n';
    md += 'إجمالي الفواتير: ' + res.rows.length + ' فاتورة\n\n';
    md += '| ID الفاتورة | تسلسل الفاتورة | نوع الفاتورة | الإجمالي | تاريخ الإنشاء |\n';
    md += '|---|---|---|---|---|\n';
    res.rows.forEach(inv => {
      const d = new Date(inv.created_at);
      const date = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0') + ' ' + String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
      const type = inv.invoice_type === 'wholesale' ? 'جملة' : (inv.invoice_type === 'retail' ? 'قطاعي' : inv.invoice_type);
      const invoiceNum = inv.invoice_number ? inv.invoice_number : '-';
      md += '| ' + inv.id + ' | ' + invoiceNum + ' | ' + type + ' | ' + inv.total + ' | ' + date + ' |\n';
    });
    fs.writeFileSync('C:/Users/Khaled/.gemini/antigravity-ide/brain/9e587f53-4b8f-4fc0-ad3d-a5d6d1c5f2c2/mahmoud_invoices.md', md, 'utf8');
    console.log('Markdown generated');
  } catch(e) {
    console.error(e);
  } finally {
    pool.end();
  }
}

getInvoices();
