@echo off
rem Nomad — 停止当前实例
setlocal
set "NOMAD_ROOT=%~dp0"
if exist "%~dp0runtime\node\node.exe" (
  set "NODE_BIN=%~dp0runtime\node\node.exe"
) else (
  set "NODE_BIN=node"
)
"%NODE_BIN%" "%~dp0launcher\nomad.js" stop
pause
endlocal
