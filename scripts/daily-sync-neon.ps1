# ============================================================
#  Daily Sync — pg_dump from Local → restore to Neon
#  Scheduled: Every day at 3:00 AM via Windows Task Scheduler
# ============================================================

$ErrorActionPreference = "Stop"

# ── Config ──
$PSQL_BIN   = "C:\Program Files\PostgreSQL\18\bin"
$BACKUP_DIR = "D:\glass-backups"

# Local DB
$LOCAL_HOST = "db.hg-alshour.online"
$LOCAL_PORT = "5432"
$LOCAL_USER = "glass_admin"
$LOCAL_PASS = "@Hadysalah1"
$LOCAL_DB   = "glass_system"

# Neon DB
$NEON_HOST = "ep-floral-field-ai56366w-pooler.c-4.us-east-1.aws.neon.tech"
$NEON_PORT = "5432"
$NEON_USER = "neondb_owner"
$NEON_PASS = "npg_Gdq7zm6OTpNu"
$NEON_DB   = "neondb"

$LOG_FILE = Join-Path $BACKUP_DIR "sync.log"

function Write-Log($msg) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$ts] $msg"
    Write-Host $line
    Add-Content -Path $LOG_FILE -Value $line -Encoding UTF8
}

try {
    $env:PGCLIENTENCODING = "UTF8"
    $timestamp = Get-Date -Format "yyyy-MM-dd_HH-mm"
    $dumpFile = Join-Path $BACKUP_DIR "sync_to_neon_$timestamp.sql"

    # Step 1: pg_dump from Local
    Write-Log "=== Daily Sync Started ==="
    Write-Log "Step 1: Dumping from Local..."

    $env:PGPASSWORD = $LOCAL_PASS
    $pgDump = Join-Path $PSQL_BIN "pg_dump.exe"
    & $pgDump -U $LOCAL_USER -h $LOCAL_HOST -p $LOCAL_PORT -d $LOCAL_DB `
        --clean --if-exists --no-owner --no-privileges `
        --inserts --encoding=UTF8 -f $dumpFile 2>&1

    if ($LASTEXITCODE -ne 0) {
        Write-Log "ERROR: pg_dump from Local failed"
        exit 1
    }

    $size = (Get-Item $dumpFile).Length / 1MB
    Write-Log "Dump completed: $([math]::Round($size, 2)) MB"

    # Step 2: Restore to Neon
    Write-Log "Step 2: Restoring to Neon..."

    $env:PGPASSWORD = $NEON_PASS
    $env:PGSSLMODE = "require"
    $psql = Join-Path $PSQL_BIN "psql.exe"
    & $psql -U $NEON_USER -h $NEON_HOST -p $NEON_PORT -d $NEON_DB `
        -f $dumpFile 2>&1 | Out-Null

    if ($LASTEXITCODE -ne 0) {
        Write-Log "WARNING: Some errors during Neon restore (may be normal for role errors)"
    }

    Write-Log "Neon restore completed"

    # Step 3: Verify
    $env:PGPASSWORD = $NEON_PASS
    $result = & $psql -U $NEON_USER -h $NEON_HOST -p $NEON_PORT -d $NEON_DB `
        -t -c "SELECT count(*) FROM products;" 2>&1
    Write-Log "Neon products count: $($result.Trim())"

    # Upload to Google Drive as well
    Write-Log "Uploading sync dump to Google Drive..."
    try {
        $driveResult = & node "$PSScriptRoot\gdrive-helper.js" upload $dumpFile 2>&1
        $driveResult | ForEach-Object { Write-Log "  [Drive] $_" }
        Write-Log "Google Drive upload completed"
    } catch {
        Write-Log "WARNING: Google Drive upload failed: $($_.Exception.Message)"
    }

    # Cleanup sync dump file (not needed, hourly backups are separate)
    Remove-Item $dumpFile -Force -ErrorAction SilentlyContinue

    Write-Log "=== Daily Sync Completed Successfully ==="

} catch {
    Write-Log "ERROR: $($_.Exception.Message)"
    exit 1
} finally {
    $env:PGPASSWORD = ""
    $env:PGSSLMODE = ""
}
