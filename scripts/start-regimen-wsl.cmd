@echo off
rem REGIMEN - Windows logon hook: boots WSL and starts the server there.
rem Autostart lives at: %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\regimen.vbs
rem
rem The repo can live anywhere: WSLENV's /p flag hands the path to WSL and lets
rem WSL translate it (C:\repo -> /mnt/c/repo), which also gets the drive-letter
rem case right. Set REGIMEN_WSL_DISTRO if your distro isn't the WSL default.
setlocal

rem This script's directory, minus the trailing backslash.
set "SCRIPT_DIR=%~dp0"
set "REGIMEN_WIN_DIR=%SCRIPT_DIR:~0,-1%"
set "WSLENV=REGIMEN_WIN_DIR/p"

if defined REGIMEN_WSL_DISTRO (
  set "DISTRO_ARG=-d %REGIMEN_WSL_DISTRO%"
) else (
  set "DISTRO_ARG="
)

wsl.exe %DISTRO_ARG% -e bash -lc "exec \"$REGIMEN_WIN_DIR/start-wsl.sh\""
endlocal
