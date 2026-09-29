# 외부 기입 입력 작업자(샵마인·EMP) 실행 — 작업 스케줄러가 부른다.
# EMP 가 관리자 권한으로 돌기 때문에 이 스크립트도 관리자 권한으로 실행해야 EMP 에 입력된다.
# 로그: samba-agent\logs\export-worker-<날짜>.log
# 점검 중지: samba-agent\PAUSE_EXPORT 파일이 있으면 띄우지 않는다.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$agent = Join-Path $root 'samba-agent'
$python = Join-Path $agent '.venv\Scripts\python.exe'
$logDir = Join-Path $agent 'logs'

if (Test-Path (Join-Path $agent 'PAUSE_EXPORT')) { exit 0 }
if (-not (Test-Path $python)) { throw "파이썬 실행 파일이 없다: $python" }
New-Item -ItemType Directory -Force $logDir | Out-Null

# 이미 떠 있으면 또 띄우지 않는다(작업자는 한 번에 1건만 처리한다 — 둘이 뜨면 화면을 서로 건드린다)
$running = Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" |
  Where-Object { $_.CommandLine -like '*samba_agent.export*worker*' }
if ($running) { exit 0 }

$env:PYTHONIOENCODING = 'utf-8'
$log = Join-Path $logDir ("export-worker-{0}.log" -f (Get-Date -Format 'yyyyMMdd'))
Set-Location $agent
# 출력 방향 전환은 cmd 에 맡긴다 — PowerShell 5 는 외부 프로그램의 stderr(파이썬 로그)를 오류로
# 취급해 ErrorActionPreference=Stop 에서 바로 죽는다(실기 2026-09-28: 종료 코드 1, 로그 0바이트)
cmd /c "`"$python`" -m samba_agent.export worker >> `"$log`" 2>&1"
exit $LASTEXITCODE
