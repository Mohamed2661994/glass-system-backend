const fs = require('fs');

console.log("Reading database_dump_clean.sql...");
let sql = fs.readFileSync('database_dump_clean.sql', 'utf8');

console.log("Removing search_path...");
sql = sql.split('\n').filter(l => !l.startsWith('SELECT pg_catalog.set_config(')).join('\n');

console.log("Removing 'public.' prefixes...");
// Replace public. table definitions and references
sql = sql.replace(/\bpublic\./g, '');

fs.writeFileSync('database_dump_tenant.sql', sql);
console.log('Created database_dump_tenant.sql with size: ' + sql.length);
