function buildInvoiceHtml(invoice, items) {
  return `
<!DOCTYPE html>
<html lang="ar">
<head>
<meta charset="UTF-8" />
<style>
  body {
    font-family: Tahoma, Arial;
    direction: rtl;
    font-size: 12px;
  }

  h2 {
    text-align: center;
    margin-bottom: 10px;
  }

  .info {
    margin-bottom: 10px;
  }

  table {
    width: 100%;
    border-collapse: collapse;
  }

  th, td {
    border-bottom: 1px solid #000;
    padding: 4px;
    text-align: center;
  }

  th {
    font-weight: bold;
  }

  .total {
    margin-top: 10px;
    font-weight: bold;
  }

  @page {
    size: A5;
    margin: 10mm;
  }
</style>
</head>
<body>

<h2>فاتورة رقم ${invoice.id}</h2>

<div class="info">
  <div>التاريخ: ${new Date(invoice.created_at).toLocaleDateString("ar-EG")}</div>
  <div>العميل: ${invoice.customer_name || "-"}</div>
</div>

<table>
  <thead>
    <tr>
      <th>م</th>
      <th>الصنف</th>
      <th>الكمية</th>
      <th>السعر</th>
      <th>الإجمالي</th>
    </tr>
  </thead>
  <tbody>
    ${items
      .map(
        (it, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${it.product_name}</td>
        <td>${it.quantity}</td>
        <td>${it.price}</td>
        <td>${it.quantity * it.price}</td>
      </tr>
    `,
      )
      .join("")}
  </tbody>
</table>

<div class="total">
  الصافي: ${invoice.total}
</div>

</body>
</html>
`;
}

module.exports = { buildInvoiceHtml };
