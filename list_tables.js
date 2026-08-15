const pool = require('./db');

pool.query(`
  ALTER TABLE branches ADD COLUMN IF NOT EXISTS thermal_print_settings JSONB DEFAULT '{}';
  ALTER TABLE branches ADD COLUMN IF NOT EXISTS barcode_print_settings JSONB DEFAULT '{}';
`)
  .then(() => {
    console.log('Columns added successfully');
    process.exit(0);
  })
  .catch(console.error);
