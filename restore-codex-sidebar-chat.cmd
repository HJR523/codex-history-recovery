@echo off
setlocal EnableExtensions
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found in PATH.
  echo Install Node.js 22.5 or later first.
  pause
  exit /b 1
)

node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 22 || (major === 22 && minor >= 5) ? 0 : 1)"
if errorlevel 1 (
  echo Node.js 22.5 or later is required.
  echo Current version:
  node -v
  pause
  exit /b 1
)

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo npm.cmd was not found in PATH.
  echo Install Node.js 22.5 or later first.
  pause
  exit /b 1
)

if not exist "%~dp0node_modules\react\package.json" (
  echo Installing project dependencies...
  call npm.cmd install
  if errorlevel 1 (
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)

echo Building modern UI...
call npm.cmd run build
if errorlevel 1 (
  echo Build failed.
  pause
  exit /b 1
)

echo.
echo Starting local recovery server...
echo The browser should open automatically.
echo Keep this window open while using the tool.
echo.
node --no-warnings "%~dp0server.cjs"

echo.
echo Server stopped.
pause
