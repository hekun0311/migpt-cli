#!/usr/bin/env sh
set -eu

[ "$(id -u)" -eq 0 ] || { echo '请使用 root 或 sudo 执行安装。' >&2; exit 1; }
command -v python3 >/dev/null || { echo '请先安装 Python 3（3.9 或更新版本）。' >&2; exit 1; }
repo_dir=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
exec python3 "$repo_dir/deploy/1panel/deploy.py" install "$repo_dir" main
