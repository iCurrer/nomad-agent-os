@echo off
rem Nomad — 重启（停止 → 重新启动），开发循环里最常用的一步
rem 客户端插件 / profile / 补丁层都在「启动时」被读取组装，所以改完代码必须重启实例才生效。
rem 同样只用 %~dp0 推导路径，不写死任何宿主绝对路径。
setlocal
set "NOMAD_ROOT=%~dp0"
if exist "%~dp0runtime\node\node.exe" (
  set "NODE_BIN=%~dp0runtime\node\node.exe"
) else (
  set "NODE_BIN=node"
)
"%NODE_BIN%" "%~dp0launcher\nomad.js" restart
if errorlevel 1 pause
if "%~1"=="" pause
endlocal
