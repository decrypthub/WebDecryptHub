Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!define APP "WebDecryptHub"
!define VER "1.3.1"
!define UNKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP}"

Name "${APP}"
Caption "${APP} ${VER} 安装"
OutFile "..\..\dist\${APP}-${VER}-win-x64-setup.exe"
InstallDir "$LOCALAPPDATA\${APP}"
InstallDirRegKey HKCU "Software\${APP}" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
; hooks.nsh defines Functions, so it has to come after SetCompressor.
!include "..\src-tauri\windows\hooks.nsh"
BrandingText "${APP} ${VER}"
VIProductVersion "${VER}.0"
VIAddVersionKey /LANG=2052 "ProductName" "${APP}"
VIAddVersionKey /LANG=2052 "FileVersion" "${VER}"
VIAddVersionKey /LANG=2052 "FileDescription" "${APP} 安装程序"
VIAddVersionKey /LANG=2052 "LegalCopyright" "${APP}"

!define MUI_ICON "..\src-tauri\windows\installer.ico"
!define MUI_UNICON "..\src-tauri\windows\installer.ico"
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_RIGHT
!define MUI_HEADERIMAGE_BITMAP "..\src-tauri\windows\header.bmp"
!define MUI_HEADERIMAGE_UNBITMAP "..\src-tauri\windows\header.bmp"
!define MUI_WELCOMEFINISHPAGE_BITMAP "..\src-tauri\windows\sidebar.bmp"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP "..\src-tauri\windows\sidebar.bmp"
!define MUI_ABORTWARNING

Var OLDVER
Var UPGRADE
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfUpgrade
!insertmacro MUI_PAGE_WELCOME
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfUpgrade
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP}.exe"
!define MUI_FINISHPAGE_RUN_TEXT "立即启动 ${APP}"
!define MUI_FINISHPAGE_RUN_CHECKED
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_WELCOME
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ; 检测已安装的旧版本：沿用原安装目录，升级时跳过欢迎/目录页（/S 时完全静默）
  StrCpy $UPGRADE "0"
  ReadRegStr $OLDVER HKCU "${UNKEY}" "DisplayVersion"
  ReadRegStr $0 HKCU "Software\${APP}" "InstallDir"
  ${If} $0 != ""
  ${AndIf} ${FileExists} "$0\${APP}.exe"
    StrCpy $INSTDIR $0
    StrCpy $UPGRADE "1"
  ${EndIf}
FunctionEnd

Function SkipIfUpgrade
  ${If} $UPGRADE == "1"
    Abort
  ${EndIf}
FunctionEnd

Section "${APP} (必需)" SecMain
  SectionIn RO
  ; 先移除旧版「逆影 NiYing 1.0.0」（设置与密钥会由新版自动迁移）
  ReadRegStr $1 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\NiYing" "UninstallString"
  ${If} $1 != ""
    DetailPrint "正在移除旧版 逆影 NiYing..."
    ReadRegStr $2 HKLM "Software\NiYing" "InstallDir"
    ExecWait '"$1" /S _?=$2'
    Delete "$1"
    RMDir "$2"
  ${EndIf}
  Call WDH_StopInstallDirProcesses
  Sleep 400
  ${If} $UPGRADE == "1"
    DetailPrint "正在升级：$OLDVER → ${VER}（保留设置、密钥与项目数据）"
  ${EndIf}
  ; 清理旧版可能残留的运行组件，避免新旧混用
  RMDir /r "$INSTDIR\resources\patchright-core"
  RMDir /r "$INSTDIR\resources\node"

  SetOutPath "$INSTDIR"
  !insertmacro WDH_Extract "payload\${APP}.exe" "$INSTDIR\${APP}.exe"
  !insertmacro WDH_Extract "payload\jsra-sidecar.exe" "$INSTDIR\jsra-sidecar.exe"
  SetOutPath "$INSTDIR\resources"
  File /r "payload\resources\patchright-core"
  SetOutPath "$INSTDIR\resources\node"
  File /r /x node.exe "payload\resources\node\*.*"
  !insertmacro WDH_Extract "payload\resources\node\node.exe" "$INSTDIR\resources\node\node.exe"
  SetOutPath "$INSTDIR"
  File "/oname=app.ico" "..\src-tauri\windows\installer.ico"
  File "payload\MicrosoftEdgeWebview2Setup.exe"
  ReadRegStr $0 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ${If} $0 == ""
    ReadRegStr $0 HKCU "SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ${EndIf}
  ${If} $0 == ""
    DetailPrint "正在安装 WebView2 运行时..."
    ExecWait '"$INSTDIR\MicrosoftEdgeWebview2Setup.exe" /silent /install'
  ${Else}
    DetailPrint "检测到 WebView2 运行时: $0"
  ${EndIf}
  WriteRegStr HKCU "Software\${APP}" "InstallDir" "$INSTDIR"
  CreateDirectory "$SMPROGRAMS\${APP}"
  CreateShortcut "$SMPROGRAMS\${APP}\${APP}.lnk" "$INSTDIR\${APP}.exe" "" "$INSTDIR\app.ico"
  CreateShortcut "$SMPROGRAMS\${APP}\卸载 ${APP}.lnk" "$INSTDIR\uninstall.exe"
  CreateShortcut "$DESKTOP\${APP}.lnk" "$INSTDIR\${APP}.exe" "" "$INSTDIR\app.ico"
  WriteRegStr HKCU "${UNKEY}" "DisplayName" "${APP}"
  WriteRegStr HKCU "${UNKEY}" "DisplayVersion" "${VER}"
  WriteRegStr HKCU "${UNKEY}" "Publisher" "${APP}"
  WriteRegStr HKCU "${UNKEY}" "URLInfoAbout" "https://ios.decrypthub.com/"
  WriteRegStr HKCU "${UNKEY}" "DisplayIcon" "$INSTDIR\app.ico"
  WriteRegStr HKCU "${UNKEY}" "UninstallString" "$INSTDIR\uninstall.exe"
  WriteRegStr HKCU "${UNKEY}" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKCU "${UNKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNKEY}" "EstimatedSize" 260000
  WriteRegDWORD HKCU "${UNKEY}" "NoRepair" 1
  WriteUninstaller "$INSTDIR\uninstall.exe"
SectionEnd

Section "Uninstall"
  Call un.WDH_StopInstallDirProcesses
  Delete "$INSTDIR\${APP}.exe"
  Delete "$INSTDIR\jsra-sidecar.exe"
  Delete "$INSTDIR\MicrosoftEdgeWebview2Setup.exe"
  Delete "$INSTDIR\app.ico"
  RMDir /r "$INSTDIR\resources"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\${APP}\${APP}.lnk"
  Delete "$SMPROGRAMS\${APP}\卸载 ${APP}.lnk"
  RMDir "$SMPROGRAMS\${APP}"
  Delete "$DESKTOP\${APP}.lnk"
  DeleteRegKey HKCU "${UNKEY}"
  DeleteRegKey HKCU "Software\${APP}"
SectionEnd
