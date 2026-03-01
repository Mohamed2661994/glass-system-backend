# ============================================================
#  Register all 3 scheduled tasks for Glass System
# ============================================================

Write-Host "=== Registering Glass System Scheduled Tasks ===" -ForegroundColor Green

# ── Task 1: Hourly Backup (every hour) ──
$action1 = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument '-NoProfile -ExecutionPolicy Bypass -File "D:\glass-backend\scripts\hourly-backup.ps1"'
$trigger1 = New-ScheduledTaskTrigger -Once -At (Get-Date).Date `
    -RepetitionInterval (New-TimeSpan -Hours 1) `
    -RepetitionDuration (New-TimeSpan -Days 365)
$settings1 = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "GlassDB-HourlyBackup" `
    -Action $action1 -Trigger $trigger1 -Settings $settings1 `
    -Description "Hourly backup of glass_system from local server" -Force
Write-Host "[OK] GlassDB-HourlyBackup registered (every 1 hour)" -ForegroundColor Cyan

# ── Task 2: Daily Sync to Neon (3:00 AM) ──
$action2 = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument '-NoProfile -ExecutionPolicy Bypass -File "D:\glass-backend\scripts\daily-sync-neon.ps1"'
$trigger2 = New-ScheduledTaskTrigger -Daily -At "03:00AM"
$settings2 = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "GlassDB-DailySyncNeon" `
    -Action $action2 -Trigger $trigger2 -Settings $settings2 `
    -Description "Daily sync from local to Neon at 3 AM" -Force
Write-Host "[OK] GlassDB-DailySyncNeon registered (daily at 3:00 AM)" -ForegroundColor Cyan

# ── Task 3: Failover Monitor (every 5 minutes) ──
$action3 = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument '-NoProfile -ExecutionPolicy Bypass -File "D:\glass-backend\scripts\failover-monitor.ps1"'
$trigger3 = New-ScheduledTaskTrigger -Once -At (Get-Date).Date `
    -RepetitionInterval (New-TimeSpan -Minutes 5) `
    -RepetitionDuration (New-TimeSpan -Days 365)
$settings3 = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "GlassDB-FailoverMonitor" `
    -Action $action3 -Trigger $trigger3 -Settings $settings3 `
    -Description "Monitor local DB, auto-sync to Neon on failover" -Force
Write-Host "[OK] GlassDB-FailoverMonitor registered (every 5 minutes)" -ForegroundColor Cyan

Write-Host ""
Write-Host "=== All tasks registered! ===" -ForegroundColor Green
Get-ScheduledTask -TaskName "GlassDB-*" | Format-Table TaskName, State, Description -AutoSize
