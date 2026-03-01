# ============================================================
#  Hourly Backup — pg_dump from Local → Google Drive (no local copies)
#  Scheduled: Every hour via Windows Task Scheduler
# ============================================================

$ErrorActionPreference = "Stop"

# ── Config ──
$PSQL_BIN   = "C:\Program Files\PostgreSQL\18\bin"
$BACKUP_DIR = "D:\glass-backups"

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
        --inserts --encoding=UTF8 -f $backupFile 2>&1

    if ($LASTEXITCODE -ne 0) {
        Write-Log "ERROR: pg_dump failed with exit code $LASTEXITCODE"
        exit 1
    }

    $size = (Get-Item $backupFile).Length / 1MB
    Write-Log "Backup completed: $([math]::Round($size, 2)) MB"

    # Upload to Google Drive
    Write-Log "Uploading backup to Google Drive..."
    $uploadOk = $false
    try {
        $driveResult = & node "$PSScriptRoot\gdrive-helper.js" upload $backupFile 2>&1
        $driveResult | ForEach-Object { Write-Log "  [Drive] $_" }
        Write-Log "Google Drive upload completed"
        $uploadOk = $true
    } catch {
        Write-Log "WARNING: Google Drive upload failed: $($_.Exception.Message)"
    }

    # Delete local file after successful upload (no local copies needed)
    if ($uploadOk) {
        Remove-Item $backupFile -Force -ErrorAction SilentlyContinue
        Write-Log "Local backup deleted (stored on Drive only)"
    } else {
        Write-Log "Keeping local backup since Drive upload failed"
    }

} catch {
    Write-Log "ERROR: $($_.Exception.Message)"
    exit 1
} finally {
    $env:PGPASSWORD = ""
}
