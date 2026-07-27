#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$ROOT_DIR"

PYTHON_BIN="${PYTHON:-python3}"
if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  printf '错误：未找到 %s，请先安装 Python 3.9 或更高版本。\n' "$PYTHON_BIN" >&2
  exit 1
fi
if ! "$PYTHON_BIN" -c 'import sys; raise SystemExit(sys.version_info < (3, 9))'; then
  printf '错误：知库需要 Python 3.9 或更高版本。\n' >&2
  exit 1
fi

if [ ! -x .venv/bin/python ]; then
  printf '首次运行，正在创建虚拟环境...\n'
  "$PYTHON_BIN" -m venv .venv
fi

.venv/bin/python -m pip install --disable-pip-version-check -q -r requirements.txt

PORT="${PORT:-8000}"
printf '\n  知库已启动，请在浏览器打开：http://127.0.0.1:%s\n\n' "$PORT"
exec .venv/bin/python -m uvicorn backend.main:app --host 127.0.0.1 --port "$PORT"
