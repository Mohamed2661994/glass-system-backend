require('dotenv').config();
const { localPool, cloudPool } = require('./db.js');
async function run() {
  try {
    console.log('Adding to local...');
    await localPool.query("ALTER TABLE manufacturers ADD COLUMN IF NOT EXISTS discount_base VARCHAR(20) NOT NULL DEFAULT 'purchase'");
    console.log('Local done');
  } catch (e) {
    console.error('Local error:', e);
  }
  try {
    console.log('Adding to cloud...');
    await cloudPool.query("ALTER TABLE manufacturers ADD COLUMN IF NOT EXISTS discount_base VARCHAR(20) NOT NULL DEFAULT 'purchase'");
    console.log('Cloud done');
  } catch (e) {
    console.error('Cloud error:', e);
  }
  process.exit(0);
}
run();
