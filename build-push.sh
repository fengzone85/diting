#!/usr/bin/env bash
# 构建并推送 diting 镜像到 GHCR
# 用法: sudo bash build-push.sh
# 前置: docker login ghcr.io (用 GitHub Personal Access Token)
#   PAT 最小权限范围：write:packages（仅推送容器镜像，无需 repo/org 读写）
#   ✗ 禁止给 read:org / repo / workflow / admin:org 等多余 scope
set -euo pipefail

NS=ghcr.io/fengzone85
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "==> 构建 diting-server (ghcr.io/fengzone85/diting:latest)"
docker build -t "$NS/diting:latest" -f server/Dockerfile server/

echo "==> 构建 diting-agent (ghcr.io/fengzone85/diting-agent:latest)"
docker build -t "$NS/diting-agent:latest" -f agent/Dockerfile agent/

echo "==> 推送 diting:latest"
docker push "$NS/diting:latest"

echo "==> 推送 diting-agent:latest"
docker push "$NS/diting-agent:latest"

echo "==> 完成! 现在可以运行 ./rebuild-test.sh 部署"
