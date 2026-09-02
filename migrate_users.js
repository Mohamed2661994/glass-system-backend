require('dotenv').config();
const { Pool } = require('pg');

async function migrate() {
  const localPool = new Pool({
    host: process.env.DB_HOST_LOCAL, port: process.env.DB_PORT_LOCAL, user: process.env.DB_USER_LOCAL,
    password: process.env.DB_PASSWORD_LOCAL, database: process.env.DB_NAME_LOCAL
  });
  const cloudPool = new Pool({
    host: process.env.DB_HOST_CLOUD, port: process.env.DB_PORT_CLOUD, user: process.env.DB_USER_CLOUD,
    password: process.env.DB_PASSWORD_CLOUD, database: process.env.DB_NAME_CLOUD
  });

  try {
    await localPool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;');
    console.log('Local DB migrated');
    await cloudPool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;');
    console.log('Cloud DB migrated');
  } catch(e) {
    console.error(e);
  } finally {
    localPool.end(); cloudPool.end();
  }
}
migrate();
