$ErrorActionPreference = "SilentlyContinue"

$PSQL_BIN   = "C:\Program Files\PostgreSQL\18\bin"
$BACKUP_DIR = "D:\glass-backups"

$LOCAL_HOST = "db.hg-alshour.online"
$LOCAL_PORT = "5432"
$LOCAL_USER = "glass_admin"
$LOCAL_PASS = "@Hadysalah1"
$LOCAL_DB   = "glass_system"

$NEON_HOST = "ep-floral-field-ai56366w-pooler.c-4.us-east-1.aws.neon.tech"
$NEON_PORT = "5432"
$NEON_USER = "neondb_owner"
$NEON_PASS = "npg_Gdq7zm6OTpNu"
$NEON_DB   = "neondb"

$STATE_FILE = Join-Path $BACKUP_DIR "failover_state.txt"
$LOG_FILE   = Join-Path $BACKUP_DIR "failover.log"

function Write-Log($msg) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$ts] $msg"
    Write-Host $line
    Add-Content -Path $LOG_FILE -Value $line -Encoding ASCII
}

function Test-LocalDB {
    $env:PGPASSWORD = $LOCAL_PASS
    $psql = Join-Path $PSQL_BIN "psql.exe"
    $null = & $psql -U $LOCAL_USER -h $LOCAL_HOST -p $LOCAL_PORT -d $LOCAL_DB -t -c "SELECT 1;" 2>&1
    return ($LASTEXITCODE -eq 0)
}

function Get-FailoverState {
    if (Test-Path $STATE_FILE) {
        return (Get-Content $STATE_FILE -Raw).Trim()
    }
    return "local_up"
}

function Set-FailoverState($state) {
    Set-Content -Path $STATE_FILE -Value $state -Encoding ASCII
}

$currentState = Get-FailoverState
$localIsUp = Test-LocalDB

if ($localIsUp -and $currentState -eq "local_up") {
    exit 0
}

if ($localIsUp -and $currentState -eq "local_down") {
    Write-Log "LOCAL DB IS BACK ONLINE - syncing Neon data back to Local..."

    # Step 1: Dump from Neon (has the latest data from while local was down)
    $pgDump = Join-Path $PSQL_BIN "pg_dump.exe"
    $psql   = Join-Path $PSQL_BIN "psql.exe"
    $failbackFile = Join-Path $BACKUP_DIR "failback_from_neon.sql"

    $env:PGPASSWORD = $NEON_PASS
    $env:PGSSLMODE = "require"
    $env:PGCLIENTENCODING = "UTF8"

    & $pgDump -U $NEON_USER -h $NEON_HOST -p $NEON_PORT -d $NEON_DB `
        --clean --if-exists --no-owner --no-privileges `
        --inserts --encoding=UTF8 -f $failbackFile 2>&1

    if ($LASTEXITCODE -ne 0) {
        Write-Log "ERROR: pg_dump from Neon failed. Staying on Neon."
        exit 1
    }

    $size = [math]::Round((Get-Item $failbackFile).Length / 1MB, 2)
    Write-Log "Neon dump completed: $size MB"

    # Step 2: Restore to Local
    Write-Log "Restoring Neon data to Local..."
    $env:PGPASSWORD = $LOCAL_PASS
    $env:PGSSLMODE = ""

    & $psql -U $LOCAL_USER -h $LOCAL_HOST -p $LOCAL_PORT -d $LOCAL_DB `
        -f $failbackFile 2>&1 | Out-Null

    # Step 3: Verify
    $env:PGPASSWORD = $LOCAL_PASS
    $localCount = & $psql -U $LOCAL_USER -h $LOCAL_HOST -p $LOCAL_PORT -d $LOCAL_DB `
        -t -c "SELECT count(*) FROM products;" 2>&1

    $env:PGPASSWORD = $NEON_PASS
    $env:PGSSLMODE = "require"
    $neonCount = & $psql -U $NEON_USER -h $NEON_HOST -p $NEON_PORT -d $NEON_DB `
        -t -c "SELECT count(*) FROM products;" 2>&1

    Write-Log "Failback sync done - Local: $($localCount.Trim()) products, Neon: $($neonCount.Trim()) products"

    # Cleanup
    Remove-Item $failbackFile -Force -ErrorAction SilentlyContinue

    Set-FailoverState "local_up"
    Write-Log "State reset to local_up - Local is PRIMARY again"
    $env:PGPASSWORD = ""
    $env:PGSSLMODE = ""
    exit 0
}

if ((-not $localIsUp) -and $currentState -eq "local_down") {
    Write-Log "Local still down, Neon already synced. Waiting..."
    exit 0
}

if ((-not $localIsUp) -and $currentState -eq "local_up") {
    Write-Log "FAILOVER TRIGGERED - LOCAL DB IS DOWN"

    $latestBackup = Get-ChildItem $BACKUP_DIR -Filter "glass_system_*.sql" |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1

    if (-not $latestBackup) {
        # No local backup — try downloading from Google Drive
        Write-Log "No local backup found. Trying Google Drive..."
        $driveBackupFile = Join-Path $BACKUP_DIR "gdrive_latest.sql"
        try {
            $driveResult = & node "$PSScriptRoot\gdrive-helper.js" download $driveBackupFile 2>&1
            $driveResult | ForEach-Object { Write-Log "  [Drive] $_" }
            if ((Test-Path $driveBackupFile) -and (Get-Item $driveBackupFile).Length -gt 0) {
                Write-Log "Downloaded backup from Google Drive"
                $latestBackup = Get-Item $driveBackupFile
            }
        } catch {
            Write-Log "ERROR: Google Drive download failed: $($_.Exception.Message)"
        }
    }

    if (-not $latestBackup) {
        Write-Log "ERROR: No backup files found (local or Drive). Cannot sync to Neon."
        Set-FailoverState "local_down"
        exit 1
    }

    $age = [math]::Round(((Get-Date) - $latestBackup.LastWriteTime).TotalMinutes)
    Write-Log "Restoring to Neon: $($latestBackup.Name) (age: $age minutes)"

    $env:PGPASSWORD = $NEON_PASS
    $env:PGSSLMODE = "require"
    $env:PGCLIENTENCODING = "UTF8"
    $psql = Join-Path $PSQL_BIN "psql.exe"

    & $psql -U $NEON_USER -h $NEON_HOST -p $NEON_PORT -d $NEON_DB -f $latestBackup.FullName 2>&1 | Out-Null

    $env:PGPASSWORD = $NEON_PASS
    $count = & $psql -U $NEON_USER -h $NEON_HOST -p $NEON_PORT -d $NEON_DB -t -c "SELECT count(*) FROM products;" 2>&1
    Write-Log "Neon restore done - products: $($count.Trim())"
    Write-Log "Neon is now PRIMARY until Local returns"

    Set-FailoverState "local_down"
    $env:PGPASSWORD = ""
    $env:PGSSLMODE = ""
}
