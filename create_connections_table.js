const { Pool } = require('pg');

const localPool = new Pool({
  host: 'db.hg-alshour.online',
  port: 5432,
  user: 'glass_admin',
  password: '@Hadysalah1',
  database: 'glass_system',
  ssl: false
});

const supabasePool = new Pool({
  host: 'aws-0-eu-west-2.pooler.supabase.com',
  port: 5432,
  user: 'postgres.elorfmpjtbojzythlyzf',
  password: 'Fgeq0qse4gAn8S0u',
  database: 'postgres',
  ssl: { rejectUnauthorized: false }
});

const ddl = `
CREATE TABLE IF NOT EXISTS branch_connections (
    id SERIAL PRIMARY KEY,
    branch_name VARCHAR(255) NOT NULL,
    remote_url VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
`;

async function createTables() {
  try {
    console.log("Creating on Local DB...");
    await localPool.query(ddl);
    console.log("Local DB OK.");

    console.log("Creating on Supabase DB...");
    await supabasePool.query(ddl);
    console.log("Supabase DB OK.");
  } catch (err) {
    console.error(err);
  } finally {
    localPool.end();
    supabasePool.end();
  }
}

createTables();
