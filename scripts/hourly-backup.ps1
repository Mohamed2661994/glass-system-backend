# ============================================================
#  Hourly Backup — pg_dump from Local, keep last 5 copies
#  Scheduled: Every hour via Windows Task Scheduler
# ============================================================

$ErrorActionPreference = "Stop"

# ── Config ──
$PSQL_BIN   = "C:\Program Files\PostgreSQL\18\bin"
$BACKUP_DIR = "D:\glass-backups"
$MAX_BACKUPS = 5

$DB_HOST = "db.hg-alshour.online"
$DB_PORT = "5432"
$DB_USER = "glass_admin"
$DB_PASS = "@Hadysalah1"
$DB_NAME = "glass_system"

$LOG_FILE = Join-Path $BACKUP_DIR "backup.log"

function Write-Log($msg) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$ts] $msg"
    Write-Host $line
    Add-Content -Path $LOG_FILE -Value $line -Encoding UTF8
}

try {
    # Set environment
    $env:PGPASSWORD = $DB_PASS
    $env:PGCLIENTENCODING = "UTF8"

    # Generate filename with timestamp
    $timestamp = Get-Date -Format "yyyy-MM-dd_HH-mm"
    $backupFile = Join-Path $BACKUP_DIR "glass_system_$timestamp.sql"

    Write-Log "Starting backup to $backupFile ..."

    # Run pg_dump
    $pgDump = Join-Path $PSQL_BIN "pg_dump.exe"
    & $pgDump -U $DB_USER -h $DB_HOST -p $DB_PORT -d $DB_NAME `
        --clean --if-exists --no-owner --no-privileges `
        --encoding=UTF8 -f $backupFile 2>&1

    if ($LASTEXITCODE -ne 0) {
        Write-Log "ERROR: pg_dump failed with exit code $LASTEXITCODE"
        exit 1
    }

    $size = (Get-Item $backupFile).Length / 1MB
    Write-Log "Backup completed: $([math]::Round($size, 2)) MB"

    # Cleanup: keep only last N backups
    $allBackups = Get-ChildItem $BACKUP_DIR -Filter "glass_system_*.sql" |
        Sort-Object LastWriteTime -Descending

    if ($allBackups.Count -gt $MAX_BACKUPS) {
        $toDelete = $allBackups | Select-Object -Skip $MAX_BACKUPS
        foreach ($f in $toDelete) {
            Remove-Item $f.FullName -Force
            Write-Log "Deleted old backup: $($f.Name)"
        }
    }

    Write-Log "Backups on disk: $([math]::Min($allBackups.Count, $MAX_BACKUPS))"

    # Upload to Google Drive
    Write-Log "Uploading backup to Google Drive..."
    try {
        $driveResult = & node "$PSScriptRoot\gdrive-helper.js" upload $backupFile 2>&1
        $driveResult | ForEach-Object { Write-Log "  [Drive] $_" }
        Write-Log "Google Drive upload completed"
    } catch {
        Write-Log "WARNING: Google Drive upload failed: $($_.Exception.Message)"
    }

} catch {
    Write-Log "ERROR: $($_.Exception.Message)"
    exit 1
} finally {
    $env:PGPASSWORD = ""
}
