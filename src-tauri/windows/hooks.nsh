; Runs inside the Windows installer Tauri builds.
;
; ChatterLayer 0.4 and earlier were Electron apps with their own per-user
; installer, registered under this key (electron-builder derives it from the
; appId, com.ruptz.chatterlayer). Installing over one would otherwise leave two
; "ChatterLayer" entries in Apps and two sets of shortcuts. Its uninstaller
; keeps %APPDATA%\ChatterLayer, so settings and downloaded models carry over.

!macro NSIS_HOOK_PREINSTALL
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\4678f0ce-0ffb-57e6-b2c0-fb22bd381533" "QuietUninstallString"
  StrCmp $0 "" +3
    DetailPrint "Removing the previous ChatterLayer (0.4 or earlier)..."
    ExecWait $0
!macroend
