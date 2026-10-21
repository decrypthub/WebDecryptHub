; WebDecryptHub NSIS hooks.
; Include this file after LogicLib.nsh.
; Same allowlist as src-tauri/src/shutdown.rs: only WebDecryptHub.exe, jsra-sidecar.exe,
; and node.exe whose image path is inside $INSTDIR. Never by image name, and never Chrome.

!define WDH_WRITE_RETRIES 16
!define WDH_WRITE_WAIT_MS 500

; Extract one payload file. SetOverwrite try suppresses Abort/Retry/Ignore.
; The dialog is only possible on the final attempt, after several seconds of retries.
!macro WDH_Extract src dest
  !define WDH_ID ${__COUNTER__}
  Push $R7
  Push $R8
  StrCpy $R8 0
  wdh_try_${WDH_ID}:
    SetOverwrite try
    ClearErrors
    File /a "/oname=${dest}" "${src}"
    IfErrors 0 wdh_ok_${WDH_ID}
    IntOp $R8 $R8 + 1
    ${If} $R8 < ${WDH_WRITE_RETRIES}
      DetailPrint "文件仍被占用，正在重试 ($R8/${WDH_WRITE_RETRIES})：${dest}"
      IntOp $R7 $R8 % 4
      ${If} $R7 == 1
        Call WDH_StopInstallDirProcesses
      ${EndIf}
      Sleep ${WDH_WRITE_WAIT_MS}
      Goto wdh_try_${WDH_ID}
    ${EndIf}
    DetailPrint "多次重试后仍无法写入，将提示手动处理：${dest}"
    SetOverwrite on
    ClearErrors
    File /a "/oname=${dest}" "${src}"
  wdh_ok_${WDH_ID}:
    SetOverwrite on
    Pop $R8
    Pop $R7
  !undef WDH_ID
!macroend

!macro WDH_STOP_BODY SUFFIX
  Push $R7
  Push $R8
  Push $R9
  InitPluginsDir
  ClearErrors
  FileOpen $R9 "$PLUGINSDIR\wdh-stop.ps1" w
  IfErrors wdh_stop_done_${SUFFIX}
  FileWrite $R9 "$$ErrorActionPreference = 'SilentlyContinue'$\r$\n"
  FileWrite $R9 "$$Root = '$INSTDIR'$\r$\n"
  FileWrite $R9 "if (-not $$Root) { exit 0 }$\r$\n"
  FileWrite $R9 "$$root = [IO.Path]::GetFullPath($$Root)$\r$\n"
  FileWrite $R9 "if (-not $$root.EndsWith('\')) { $$root += '\' }$\r$\n"
  FileWrite $R9 "$$names = @('WebDecryptHub.exe','jsra-sidecar.exe','node.exe')$\r$\n"
  FileWrite $R9 "foreach ($$p in Get-CimInstance Win32_Process) {$\r$\n"
  FileWrite $R9 "  $$path = $$p.ExecutablePath$\r$\n"
  FileWrite $R9 "  if (-not $$path) { continue }$\r$\n"
  FileWrite $R9 "  $$name = [IO.Path]::GetFileName($$path)$\r$\n"
  FileWrite $R9 "  if ($$names -notcontains $$name) { continue }$\r$\n"
  FileWrite $R9 "  if (-not $$path.StartsWith($$root, [StringComparison]::OrdinalIgnoreCase)) { continue }$\r$\n"
  FileWrite $R9 "  Stop-Process -Id $$p.ProcessId -Force -ErrorAction SilentlyContinue$\r$\n"
  FileWrite $R9 "}$\r$\n"
  FileClose $R9
  nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\wdh-stop.ps1"'
  wdh_stop_done_${SUFFIX}:
  Pop $R9
  Pop $R8
  Pop $R7
!macroend

Function WDH_StopInstallDirProcesses
  DetailPrint "正在结束安装目录内的进程"
  !insertmacro WDH_STOP_BODY "Inst"
FunctionEnd

Function un.WDH_StopInstallDirProcesses
  DetailPrint "正在结束安装目录内的进程"
  !insertmacro WDH_STOP_BODY "Uninst"
FunctionEnd

!macro NSIS_HOOK_PREINSTALL
  !insertmacro MUI_HEADER_TEXT "正在安装" "先结束安装目录内的进程，再写入文件"
  DetailPrint "步骤：结束安装目录内的 WebDecryptHub、sidecar 与捆绑 Node"
  Call WDH_StopInstallDirProcesses
  Sleep 400
!macroend

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "步骤：文件已写入"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  Call un.WDH_StopInstallDirProcesses
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
!macroend
