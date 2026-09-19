' SAMBA Browser 실행기(개발 모드) — 콘솔 창 없이 `pnpm dev` 를 띄운다.
' 바탕화면 바로가기가 이 파일을 가리킨다. 이미 떠 있으면 앱이 기존 창을 앞으로 보내고 종료한다.
' 로그: %TEMP%\samba-dev.log
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
logPath = sh.ExpandEnvironmentStrings("%TEMP%") & "\samba-dev.log"
sh.CurrentDirectory = root
sh.Run "cmd /c pnpm dev > """ & logPath & """ 2>&1", 0, False
