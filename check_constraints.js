const pool = require('./db');
pool.query(
  `SELECT conname, contype, pg_get_constraintdef(oid) AS def
   FROM pg_constraint
   WHERE conrelid = 'stock'::regclass`
).then(r => {
  console.log(JSON.stringify(r.rows, null, 2));
}).catch(e => console.error(e)).finally(() => pool.end());
