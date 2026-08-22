const { Client } = require('pg');
const fs = require('fs');

const client = new Client({
  host: '18.185.48.10',
  port: 5432,
  user: 'glass_admin',
  password: '@Hadysalah1',
  database: 'glass_system',
  ssl: false
});

client.connect().then(() => {
  return client.query('SELECT * FROM products');
}).then(res => {
  fs.writeFileSync('products_export.json', JSON.stringify(res.rows, null, 2));
  console.log('Exported ' + res.rowCount + ' products');
  process.exit(0);
}).catch(err => {
  console.error(err);
  process.exit(1);
});
