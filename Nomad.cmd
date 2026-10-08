@echo off
rem Nomad — Portable Agent OS / Windows 启动入口
rem 只用 %~dp0 推导路径，不写死任何宿主绝对路径（含非 ASCII 路径也不会出问题）。
setlocal
set "NOMAD_ROOT=%~dp0"
if exist "%~dp0runtime\node\node.exe" (
  set "NODE_BIN=%~dp0runtime\node\node.exe"
) else (
  set "NODE_BIN=node"
)
"%NODE_BIN%" "%~dp0launcher\nomad.js" %*
if errorlevel 1 pause
if "%~1"=="" pause
endlocal
