@echo off
chcp 65001 >nul
pushd "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先从 https://nodejs.org 安装 Node.js LTS，再重新启动。
  pause
  popd
  exit /b 1
)
node scripts/start.mjs
set "jevExit=%errorlevel%"
if not "%jevExit%"=="0" pause
popd
exit /b %jevExit%
