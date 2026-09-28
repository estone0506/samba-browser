# 외부 기입 입력 작업자를 작업 스케줄러에 등록한다(관리자 권한 PowerShell 에서 1회 실행).
#
#   등록:  powershell -ExecutionPolicy Bypass -File scripts\register-export-worker.ps1
#   해제:  powershell -ExecutionPolicy Bypass -File scripts\register-export-worker.ps1 -Remove
#
# - 로그온할 때 시작하고, 죽었으면 5분마다 다시 띄운다(이미 떠 있으면 아무것도 하지 않는다).
# - '가장 높은 권한으로 실행' — EMP 가 관리자 권한이라 필요하다.
# - 화면을 조작하므로 '사용자가 로그온한 경우에만 실행'(대화형)으로 등록한다.

param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$taskName = 'SambaExportWorker'

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw '관리자 권한 PowerShell 에서 실행해야 한다' }

if ($Remove) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "해제함: $taskName"
  exit 0
}

$script = Join-Path $PSScriptRoot 'run-export-worker.ps1'
if (-not (Test-Path $script)) { throw "실행 스크립트가 없다: $script" }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$atLogon = New-ScheduledTaskTrigger -AtLogOn -User $user
$every5 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 5)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($atLogon, $every5) `
  -Principal $principal -Settings $settings -Force | Out-Null
Write-Host "등록함: $taskName (로그온 시 + 5분마다 확인, 최고 권한)"
Write-Host '지금 시작: Start-ScheduledTask -TaskName SambaExportWorker'
