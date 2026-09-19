# SAMBA Browser 실행기(개발 모드) — 콘솔 창 없이 `pnpm dev` 를 띄운다.
# 바탕화면 바로가기: powershell -WindowStyle Hidden -ExecutionPolicy Bypass -File <이 파일>
# 이미 떠 있으면 앱이 기존 창을 앞으로 보내고 새 인스턴스는 스스로 종료한다.
# 로그: %TEMP%\samba-dev-<시각>.log — 실행마다 새 파일을 쓴다. 죽은 앱의 자식 프로세스가
# 예전 로그 핸들을 쥐고 있어도 새 실행이 막히지 않게(같은 이름 덮어쓰기는 '사용 중' 오류로 실패했다).
# 7일 지난 로그는 지운다.
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Get-ChildItem -Path $env:TEMP -Filter 'samba-dev-*.log' -ErrorAction SilentlyContinue |
  Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-7) } |
  Remove-Item -Force -ErrorAction SilentlyContinue
$log = Join-Path $env:TEMP ("samba-dev-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
# 경로에 공백이 있으면 cmd 인용이 꼬이므로 8.3 짧은 경로로 바꾼다
if ($log -match ' ') {
  $fso = New-Object -ComObject Scripting.FileSystemObject
  $log = Join-Path $fso.GetFolder($env:TEMP).ShortPath (Split-Path -Leaf $log)
}
Start-Process -FilePath 'cmd.exe' -WindowStyle Hidden -WorkingDirectory $root `
  -ArgumentList '/c', "pnpm dev > $log 2>&1"
