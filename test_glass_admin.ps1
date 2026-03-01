$env:PGPASSWORD = '@Hadysalah1'
$env:PGCLIENTENCODING = 'UTF8'
$psql = "C:\Program Files\PostgreSQL\18\bin\psql.exe"

Write-Host "=== Testing glass_admin connection ==="
& $psql -U glass_admin -h db.hg-alshour.online -p 5432 -d glass_system -c "SELECT current_user, current_database();"

Write-Host "`n=== Checking permissions ==="
& $psql -U glass_admin -h db.hg-alshour.online -p 5432 -d glass_system -c "SELECT has_database_privilege('glass_admin', 'glass_system', 'CREATE') as can_create, has_database_privilege('glass_admin', 'glass_system', 'CONNECT') as can_connect;"

Write-Host "`n=== Testing table access ==="
& $psql -U glass_admin -h db.hg-alshour.online -p 5432 -d glass_system -c "SELECT count(*) as products FROM products; SELECT count(*) as customers FROM customers;"
