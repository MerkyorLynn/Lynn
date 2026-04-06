; installer.nsh — NSIS custom hooks for Lynn installer
;
; Kills running Lynn processes before install/uninstall to prevent
; "file in use" errors on Windows overlay installs.

; Disable CRC integrity check — electron-builder's post-compilation PE editing
; (signtool + rcedit) corrupts the NSIS CRC when no signing cert is configured,
; causing "Installer integrity check has failed" on Windows.
CRCCheck off

!macro customInit
  ; Kill Electron main process
  nsExec::ExecToLog 'taskkill /F /IM "Lynn.exe"'
  ; Kill bundled server process (renamed node.exe)
  nsExec::ExecToLog 'taskkill /F /IM "lynn-server.exe"'
  ; Wait for file handles to release
  Sleep 2000
!macroend

!macro customUnInit
  nsExec::ExecToLog 'taskkill /F /IM "Lynn.exe"'
  nsExec::ExecToLog 'taskkill /F /IM "lynn-server.exe"'
  Sleep 2000
!macroend
