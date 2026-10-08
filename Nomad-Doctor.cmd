@echo off
rem Nomad — 体检（路径 / 隔离 / 运行时 / 端口 / 宿主探针）
setlocal
set "NOMAD_ROOT=%~dp0"
if exist "%~dp0runtime\node\node.exe" (
  set "NODE_BIN=%~dp0runtime\node\node.exe"
) else (
  set "NODE_BIN=node"
)
"%NODE_BIN%" "%~dp0launcher\nomad.js" doctor
pause
endlocal
