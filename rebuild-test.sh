#!/usr/bin/env bash
# 一键重建 diting 测试环境（diting 镜像）
# 用法: sudo bash rebuild-test.sh
# 前置: docker daemon 正常; ghcr.io/fengzone85/diting:latest 与 diting-agent:latest 本地已存在(或已登录可拉取)
set -euo pipefail

NS=ghcr.io/fengzone85
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_ID="${AGENT_ID:-agt_5f4f4bfd979b}"
# 令牌不入库：由环境变量注入，避免真实凭证进入 git 历史。
AGENT_TOKEN="${AGENT_TOKEN:-}"
if [[ -z "$AGENT_TOKEN" ]]; then
  echo "错误: 请通过环境变量 AGENT_TOKEN 提供受控端令牌后重试" >&2
  echo "  例: AGENT_TOKEN=<token> sudo -E bash rebuild-test.sh" >&2
  exit 1
fi
PROBE_TARGETS="${PROBE_TARGETS:-移动:211.136.192.6,电信:101.226.4.6,联通:202.106.0.20,公共:8.8.8.8}"

echo "==> [1/5] 准备卷 server-data-test + 备份 admin_config"
docker volume create server-data-test >/dev/null
# 重建前备份 admin_config（站点信息/分组/通知等设置）
if docker ps -q -f name=diting-server-test >/dev/null 2>&1; then
  docker exec diting-server-test node -e "
    const Database=require('/app/node_modules/better-sqlite3');
    const db=new Database('/data/monitor.db');
    const rows=db.prepare('SELECT key,value FROM admin_config').all();
    console.log(JSON.stringify(rows));
  " 2>/dev/null > /tmp/diting_admin_config_backup.json && echo "    已备份 admin_config"
fi

echo "==> [2/5] 启动测试服务端 diting-server-test (diting:latest, 8081)"
docker rm -f diting-server-test >/dev/null 2>&1 || true
docker run -d --name diting-server-test -p 8081:8081 \
  -v server-data-test:/data -e DB_PATH=/data/monitor.db -e ADMIN_ALLOW_HTTP=1 \
  -v "$SCRIPT_DIR/server/public:/app/public:ro" \
  "$NS/diting:latest"

echo "==> [3/5] 等待服务端就绪"
for i in $(seq 1 30); do
  if curl -s -m 5 http://localhost:8081/api/overview >/dev/null 2>&1; then
    echo "    server up after ${i}x2s"; break
  fi
  sleep 2
done

echo "==> [4/5] 注入受控端身份(复用原 token, 免重新注册)"
docker exec -e AGENT_TOKEN="$AGENT_TOKEN" -e AGENT_ID="$AGENT_ID" diting-server-test node -e "
const Database = require('/app/node_modules/better-sqlite3');
const crypto = require('crypto');
const db = new Database('/data/monitor.db');
const t = process.env.AGENT_TOKEN;
const h = crypto.createHash('sha256').update(t).digest('hex');
db.prepare('INSERT OR IGNORE INTO agents (id,name,token_hash,created_at,last_seen) VALUES (?,?,?,?,0)')
  .run(process.env.AGENT_ID,'test-agent',h,Date.now());
console.log('    seeded:', JSON.stringify(db.prepare('SELECT id,name FROM agents').all()));
"

echo "==> [4.5/5] 恢复 admin_config（站点信息/分组/通知等设置）"
if [ -f /tmp/diting_admin_config_backup.json ] && [ -s /tmp/diting_admin_config_backup.json ]; then
  # 将备份拷进容器再恢复
  docker cp /tmp/diting_admin_config_backup.json diting-server-test:/tmp/backup.json
  docker exec diting-server-test node -e "
    const Database=require('/app/node_modules/better-sqlite3');
    const db=new Database('/data/monitor.db');
    const fs=require('fs');
    const rows=JSON.parse(fs.readFileSync('/tmp/backup.json','utf8'));
    const ins=db.prepare('INSERT OR REPLACE INTO admin_config(key,value) VALUES (?,?)');
    db.transaction(()=>{ rows.forEach(r=>ins.run(r.key,r.value)); })();
    console.log('    已恢复', rows.length, '条设置');
  " 2>/dev/null || echo "    恢复跳过（备份为空或格式异常）"
fi

echo "==> [5/5] 重建受控端 diting-agent (diting-agent:latest, 复用身份)"
docker rm -f diting-agent >/dev/null 2>&1 || true
docker run -d --name diting-agent --network host \
  -e SERVER_URL=http://localhost:8081 \
  -e AGENT_ID="$AGENT_ID" -e AGENT_TOKEN="$AGENT_TOKEN" \
  -e INTERVAL=15 -e DISK_PATH=/host \
  -e PROBE_TARGETS="$PROBE_TARGETS" \
  -e STATE_FILE=/data/state.json \
  -v /:/host:ro -v /proc:/hostproc:ro -v diting-state:/data \
  "$NS/diting-agent:latest"

echo "==> 完成, 等待 20s 后查 overview"
sleep 20
curl -s -m 10 http://localhost:8081/api/public/overview | head -c 600
echo; echo "=== agents ==="
curl -s -m 10 http://localhost:8081/api/public/agents | head -c 600
echo
