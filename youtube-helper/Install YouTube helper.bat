@echo off
rem Double-click this file to install or repair the 3iaw.com YouTube helper on this PC.
rem It runs setup.py (read the top of that file for what it does) and keeps the window open at the end.
title 3iaw YouTube helper setup
cd /d "%~dp0.."
where python >nul 2>nul
if %errorlevel%==0 (
  python "%~dp0setup.py" %*
) else (
  py -3 "%~dp0setup.py" %*
)
echo.
pause
