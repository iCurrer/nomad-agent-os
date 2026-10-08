#!/bin/sh
# Nomad — Portable Agent OS / POSIX 启动入口（Linux / macOS）
# 一切路径从脚本自身位置派生，不写死宿主路径。
set -e
SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NOMAD_ROOT="$SELF_DIR"
export NOMAD_ROOT

if [ -x "$SELF_DIR/runtime/node/bin/node" ]; then
  NODE_BIN="$SELF_DIR/runtime/node/bin/node"
elif [ -x "$SELF_DIR/runtime/node/node" ]; then
  NODE_BIN="$SELF_DIR/runtime/node/node"
else
  NODE_BIN=node
fi

exec "$NODE_BIN" "$SELF_DIR/launcher/nomad.js" "$@"
