@echo off
rem rpa connection, rpa status and rpa policy apply: see scripts\rpa.ps1, which this runs in Windows PowerShell,
rem found by its full path. The arguments go on as they were typed, all of them at once, so that a quoted path
rem stays one argument.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\rpa.ps1" %*
exit /b %ERRORLEVEL%
