# SAMBA Browser 실행기(개발 모드) — 콘솔 창 없이 `pnpm dev` 를 띄운다.
# 바탕화면 바로가기: powershell -WindowStyle Hidden -ExecutionPolicy Bypass -File <이 파일>
# 이미 떠 있으면 앱이 기존 창을 앞으로 보내고 새 인스턴스는 스스로 종료한다.
# 로그: %TEMP%\samba-dev.log
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$log = Join-Path $env:TEMP 'samba-dev.log'
Start-Process -FilePath 'cmd.exe' -WindowStyle Hidden -WorkingDirectory $root `
  -ArgumentList '/c', "pnpm dev > `"$log`" 2>&1"
