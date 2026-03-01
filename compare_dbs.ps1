$env:PGPASSWORD = '@Hadysalah1'
$env:PGCLIENTENCODING = 'UTF8'
$psql = "C:\Program Files\PostgreSQL\18\bin\psql.exe"

Write-Host "=== LOCAL DB ==="
& $psql -U postgres -h 100.91.137.34 -p 5432 -d glass_system -c "SELECT (SELECT count(*) FROM products) as products, (SELECT count(*) FROM customers) as customers, (SELECT count(*) FROM invoices) as invoices;"

$env:PGPASSWORD = 'npg_Gdq7zm6OTpNu'
$env:PGSSLMODE = 'require'

Write-Host "`n=== NEON DB ==="
& $psql -U neondb_owner -h ep-floral-field-ai56366w-pooler.c-4.us-east-1.aws.neon.tech -p 5432 -d neondb -c "SELECT (SELECT count(*) FROM products) as products, (SELECT count(*) FROM customers) as customers, (SELECT count(*) FROM invoices) as invoices;"
