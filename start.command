#!/bin/sh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo '请先从 https://nodejs.org 安装 Node.js LTS，再重新启动。'
  printf '按回车退出…'
  read -r reply
  exit 1
fi
node scripts/start.mjs
result=$?
if [ "$result" -ne 0 ]; then
  printf '按回车退出…'
  read -r reply
fi
exit "$result"
