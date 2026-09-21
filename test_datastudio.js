const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgresql://glass_backend:SecGlass_2026_Postgres_HA@dbstudio.hg-alshour.online:5432/glass_system',
  connectionTimeoutMillis: 15000
});

async function main() {
  try {
    console.log('Connecting to dbstudio.hg-alshour.online:5432/glass_system ...');
    const client = await pool.connect();
    console.log('Connected successfully!');

    const curr = await client.query('SELECT current_database(), current_user, current_schema(), current_schemas(true);');
    console.log('Current DB info:', curr.rows[0]);

    const dbs = await client.query('SELECT datname FROM pg_database WHERE datistemplate = false;');
    console.log('Databases on server:', dbs.rows.map(r => r.datname));

    const schemas = await client.query('SELECT nspname FROM pg_namespace;');
    console.log('Schemas in glass_system:', schemas.rows.map(r => r.nspname));

    const tables = await client.query(`
      SELECT table_schema, table_name 
      FROM information_schema.tables 
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY table_schema, table_name;
    `);
    console.log(`Total user tables found: ${tables.rows.length}`);
    tables.rows.forEach(t => console.log(` - ${t.table_schema}.${t.table_name}`));

    // Also check pg_tables
    const pgtables = await client.query(`SELECT schemaname, tablename FROM pg_catalog.pg_tables;`);
    console.log(`Total pg_tables found: ${pgtables.rows.length}`);
    const nonSystem = pgtables.rows.filter(t => !['pg_catalog', 'information_schema'].includes(t.schemaname));
    console.log(`Non-system pg_tables count: ${nonSystem.length}`);
    nonSystem.forEach(t => console.log(`   ${t.schemaname}.${t.tablename}`));

    // Check permissions of glass_backend
    const grants = await client.query(`
      SELECT table_schema, table_name, privilege_type 
      FROM information_schema.table_privileges 
      WHERE grantee = 'glass_backend';
    `);
    console.log('Table privileges for glass_backend:', grants.rows.length);

    client.release();
  } catch (err) {
    console.error('ERROR:', err);
  } finally {
    await pool.end();
  }
}

main();
