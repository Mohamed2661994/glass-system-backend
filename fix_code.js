const fs = require('fs');
let code = fs.readFileSync('index.js', 'utf8');
code = code.replace(/COALESCE\(m\.discount_base, 'purchase'\) AS discount_base,/, `'purchase' AS discount_base,`);
code = code.replace(/GROUP BY p\.id, p\.name, p\.barcode, p\.wholesale_package, p\.retail_package, p\.manufacturer, p\.purchase_price, p\.wholesale_price, m\.discount_base/, `GROUP BY p.id, p.name, p.barcode, p.wholesale_package, p.retail_package, p.manufacturer, p.purchase_price, p.wholesale_price`);
fs.writeFileSync('index.js', code);
console.log('done');
