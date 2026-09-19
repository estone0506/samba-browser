# SAMBA Browser 실행기(개발 모드) — 콘솔 창 없이 `pnpm dev` 를 띄운다.
# 바탕화면 바로가기: powershell -WindowStyle Hidden -ExecutionPolicy Bypass -File <이 파일>
# 이미 떠 있으면 앱이 기존 창을 앞으로 보내고 새 인스턴스는 스스로 종료한다.
# 로그: %TEMP%\samba-dev.log  (경로는 cmd 가 %TEMP% 를 풀게 둔다 — PowerShell 이 따옴표를 다시 감싸면 cmd 가 명령을 못 읽는다)
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Start-Process -FilePath 'cmd.exe' -WindowStyle Hidden -WorkingDirectory $root `
  -ArgumentList '/c', 'pnpm dev > "%TEMP%\samba-dev.log" 2>&1'
