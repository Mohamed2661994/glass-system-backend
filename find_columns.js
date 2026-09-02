require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST_LOCAL,
  port: process.env.DB_PORT_LOCAL,
  user: process.env.DB_USER_LOCAL,
  password: process.env.DB_PASSWORD_LOCAL,
  database: process.env.DB_NAME_LOCAL
});

pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'invoices';")
.then(res => { console.log(res.rows.map(r => r.column_name)); pool.end(); })
.catch(err => { console.error(err); pool.end(); });
