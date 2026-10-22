#!/usr/bin/env bash
# ============================================================
# D5/D7 密钥迁移 —— Docker 形态增量验收
#
# 背景：管理员 Token 不再经 compose 注入（D7），SETUP_TOKEN 改以库为权威（D5）。
# T1.9 已验证安装/向导主链路；本脚本只覆盖这批改动在 Docker 形态的**增量**面。
#
# 默认**只读**：只发 GET 与登录探测，不改任何状态。
# 破坏性断言（生成/清除令牌、注册受控端）需显式 --allow-mutations。
#
# 用法：
#   bash scripts/docker-secrets-acceptance.sh \
#        --base-url https://panel.example.com \
#        --admin-token adm_xxxxxxxx \
#        [--src-dir /opt/diting-src] [--container diting-server-1] \
#        [--db /var/lib/docker/volumes/<项目>_server-data/_data/monitor.db] \
#        [--allow-mutations]
#
# Docker 主机上请用 root 跑（`sudo bash …`）：docker 套接字通常不在 feng 组里，
# 非 root 时容器内查库与 docker inspect 会被跳过；宿主无 node 的纯 Docker 主机
# （如 j4125）会自动改走容器内查询，此时 --db 可省略。
#
# 退出码：0 = 全部通过的断言通过；1 = 有失败；2 = 用法/前置错误。
# ============================================================
set -uo pipefail

BASE_URL=""
ADMIN_TOKEN=""
SRC_DIR=""
CONTAINER=""
DB_PATH=""
MUTATE=0
PASS=0; FAIL=0; SKIP=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-url)        BASE_URL="${2:-}"; shift 2 ;;
    --admin-token)     ADMIN_TOKEN="${2:-}"; shift 2 ;;
    --src-dir)         SRC_DIR="${2:-}"; shift 2 ;;
    --container)       CONTAINER="${2:-}"; shift 2 ;;
    --db)              DB_PATH="${2:-}"; shift 2 ;;
    --allow-mutations) MUTATE=1; shift ;;
    -h|--help)         sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

[[ -z "$BASE_URL" ]] && { echo "缺少 --base-url" >&2; exit 2; }
[[ -z "$ADMIN_TOKEN" ]] && { echo "缺少 --admin-token" >&2; exit 2; }

G='\033[0;32m'; R='\033[0;31m'; Y='\033[0;33m'; NC='\033[0m'
ok()   { printf "${G}  ✓ %s${NC}\n" "$1"; PASS=$((PASS+1)); }
bad()  { printf "${R}  ✗ %s${NC}\n" "$1"; FAIL=$((FAIL+1)); }
skip() { printf "${Y}  - %s（跳过：%s）${NC}\n" "$1" "${2:-条件不满足}"; SKIP=$((SKIP+1)); }
head1() { printf "\n${Y}== %s ==${NC}\n" "$1"; }

# 统一走 https 头，兼容未配 TLS 的测试实例（requireProto 的 loopback 例外见 auth.js）
req() { curl -s --max-time 10 -H 'X-Forwarded-Proto: https' "$@"; }
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@"; }

# ============================================================
head1 "A. 部署形态（宿主机侧）"

if [[ -n "$SRC_DIR" && -f "$SRC_DIR/server/docker-compose.yml" ]]; then
  if grep -Eq '^\s*-\s*ADMIN_TOKEN=' "$SRC_DIR/server/docker-compose.yml"; then
    bad "compose 仍在注入 ADMIN_TOKEN（docker inspect 会暴露明文）"
  else
    ok "compose 无 ADMIN_TOKEN 注入"
  fi
  # 反向对照：SESSION_SECRET 不能一起被删（否则重启后会话全失效）
  if grep -Eq 'SESSION_SECRET=\$\{SESSION_SECRET' "$SRC_DIR/server/docker-compose.yml"; then
    ok "compose 仍注入 SESSION_SECRET"
  else
    bad "compose 丢了 SESSION_SECRET（重启将清空所有登录态）"
  fi
  envf="$SRC_DIR/server/.env"
  if [[ -f "$envf" ]]; then
    v="$(sed -n 's/^ADMIN_TOKEN=//p' "$envf" | tr -d '\r\n' | head -1)"
    [[ -z "$v" ]] && ok ".env 的 ADMIN_TOKEN 为空（凭据以库为权威）" \
                  || skip ".env 的 ADMIN_TOKEN 非空" "存量实例升级前的正常状态，应由 migrate_env_admin_token 处理"
  else
    skip ".env 检查" "找不到 $envf"
  fi
else
  skip "compose/.env 静态检查" "未提供 --src-dir 或文件不存在"
fi

if [[ -n "$CONTAINER" ]] && command -v docker >/dev/null 2>&1; then
  # 纯 Docker 主机上 feng 不在 docker 组：先用普通用户，失败再用 sudo -n
  DIN="docker"
  docker info >/dev/null 2>&1 || { sudo -n docker info >/dev/null 2>&1 && DIN="sudo -n docker"; }
  if $DIN inspect "$CONTAINER" >/dev/null 2>&1; then
    if $DIN inspect "$CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | grep -q '^ADMIN_TOKEN='; then
      bad "docker inspect 仍可见 ADMIN_TOKEN（D7 未生效）"
    else
      ok "docker inspect 无 ADMIN_TOKEN"
    fi
  else
    skip "docker inspect" "容器 $CONTAINER 不存在（或无权限）"
  fi
else
  skip "docker inspect" "未提供 --container 或无 docker"
fi

# ============================================================
head1 "B. SETUP_TOKEN 以库为权威（D5）"

st="$(req -H "X-Admin-Token: $ADMIN_TOKEN" "$BASE_URL/api/setup-token")"
c="$(code -H 'X-Forwarded-Proto: https' -H "X-Admin-Token: $ADMIN_TOKEN" "$BASE_URL/api/setup-token")"
[[ "$c" == "200" ]] && ok "GET /api/setup-token → 200" || bad "GET /api/setup-token → $c（期望 200）"
if [[ "$c" == "200" ]]; then
  echo "$st" | grep -q '"configured"' && echo "$st" | grep -q '"source"' && echo "$st" | grep -q '"weak"' \
    && ok "响应含 configured/source/weak" || bad "响应字段不全：$st"
  echo "$st" | grep -q '"token"' && bad "GET 回显了明文令牌（应只报状态）" || ok "GET 不回显明文"
fi

c="$(code -H 'X-Forwarded-Proto: https' "$BASE_URL/api/setup-token")"
[[ "$c" == "401" ]] && ok "无凭证访问 → 401" || bad "无凭证访问 → $c（期望 401）"

# ============================================================
head1 "C. 管理员 Token（D7 后的唯一凭据来源）"

c="$(code -H 'X-Forwarded-Proto: https' -H 'Content-Type: application/json' \
      -d "{\"token\":\"$ADMIN_TOKEN\"}" "$BASE_URL/api/login")"
[[ "$c" == "200" ]] && ok "POST /api/login → 200" || bad "POST /api/login → $c（期望 200；Token 失效？）"

c="$(code -H 'X-Forwarded-Proto: https' -H "X-Admin-Token: $ADMIN_TOKEN" "$BASE_URL/api/admin/alert-rules")"
[[ "$c" == "200" ]] && ok "管理面 /api/admin/alert-rules → 200" || bad "管理面 → $c（期望 200）"

if [[ -n "$DB_PATH" && -f "$DB_PATH" && -x "$(command -v node || true)" ]]; then
  # node -e 的解析根是 cwd，而本脚本可能在仓库根跑 → 找不到 better-sqlite3。
  # 按候选顺序找一个 node_modules 交给 NODE_PATH（宿主机原生部署同款机制）。
  NM=""
  for cand in "${SRC_DIR:-/nonexistent}/server/node_modules" \
              "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/server/node_modules" \
              "./server/node_modules"; do
    [[ -d "$cand/better-sqlite3" ]] && { NM="$cand"; break; }
  done
  if [[ -z "$NM" ]]; then
    skip "库内哈希检查" "未找到 server/node_modules（better-sqlite3）"
  else
    q() { NODE_PATH="$NM" node -e "const D=require('better-sqlite3');const db=new D(process.argv[1],{readonly:true});const r=db.prepare(process.argv[2]).get();process.stdout.write(r&&r.value?r.value:'')" "$DB_PATH" "$1" 2>/dev/null || true; }
    h="$(q "SELECT value FROM admin_config WHERE key='admin_token_hash'")"
    if [[ ${#h} -eq 64 ]]; then
      ok "库中 admin_token_hash 为 64 位十六进制"
    else
      bad "库中无 admin_token_hash（长度 ${#h}）——凭据未落库"
    fi
    raw="$(NODE_PATH="$NM" node -e "const D=require('better-sqlite3');const db=new D(process.argv[1],{readonly:true});const r=db.prepare(\"SELECT value FROM admin_config WHERE key='admin_token_raw'\").get();process.stdout.write(r?'present':'absent')" "$DB_PATH" 2>/dev/null || true)"
    [[ "$raw" == "absent" ]] && ok "无 admin_token_raw 明文残留" || bad "存在 admin_token_raw 明文残留"
  fi
elif [[ -n "$CONTAINER" ]] && command -v docker >/dev/null 2>&1; then
  # 纯 Docker 主机（如 j4125）没有宿主 node：改在容器内查。
  # 必须 -w /app —— node 的模块解析根是 cwd，/tmp 下找不到 /app/node_modules。
  DIN="docker"
  docker info >/dev/null 2>&1 || { sudo -n docker info >/dev/null 2>&1 && DIN="sudo -n docker"; }
  QS="SELECT value FROM admin_config WHERE key='admin_token_hash'"
  RS="SELECT value FROM admin_config WHERE key='admin_token_raw'"
  h="$($DIN exec -w /app "$CONTAINER" node -e "const D=require('better-sqlite3');const db=new D('/data/monitor.db',{readonly:true});const r=db.prepare(process.argv[1]).get();process.stdout.write(r&&r.value?r.value:'')" "$QS" 2>/dev/null || true)"
  raw="$($DIN exec -w /app "$CONTAINER" node -e "const D=require('better-sqlite3');const db=new D('/data/monitor.db',{readonly:true});const r=db.prepare(process.argv[1]).get();process.stdout.write(r?'present':'absent')" "$RS" 2>/dev/null || true)"
  if [[ ${#h} -eq 64 ]]; then
    ok "库中 admin_token_hash 为 64 位十六进制（容器内查询）"
  else
    bad "库中无 admin_token_hash（长度 ${#h}）——凭据未落库"
  fi
  [[ "$raw" == "absent" ]] && ok "无 admin_token_raw 明文残留（容器内查询）" || bad "存在 admin_token_raw 明文残留"
else
  skip "库内哈希检查" "未提供可读的 --db 或无 node / --container"
fi

# ============================================================
head1 "D. 破坏性断言（需 --allow-mutations）"

if [[ "$MUTATE" -ne 1 ]]; then
  skip "生成/清除令牌、受控端注册" "未加 --allow-mutations（默认只读，避免误改线上状态）"
else
  # D1 生成
  gen="$(req -H "X-Admin-Token: $ADMIN_TOKEN" -H 'Content-Type: application/json' \
         -d '{"action":"generate"}' "$BASE_URL/api/setup-token")"
  tok="$(echo "$gen" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
  if [[ ${#tok} -eq 32 ]]; then ok "generate → 32 位十六进制令牌"; else bad "generate 未返回令牌：$gen"; fi

  # D2 弱值/非法值拒绝
  for body in '{"action":"set","token":"1234567890123456"}' '{"action":"set","token":"short"}' '{"action":"nope"}'; do
    c="$(code -H 'X-Forwarded-Proto: https' -H "X-Admin-Token: $ADMIN_TOKEN" -H 'Content-Type: application/json' \
          -d "$body" "$BASE_URL/api/setup-token")"
    [[ "$c" == "400" ]] && ok "拒绝 $body → 400" || bad "$body → $c（期望 400）"
  done

  # D3 生成后状态翻转 + 明文不再回显
  st2="$(req -H "X-Admin-Token: $ADMIN_TOKEN" "$BASE_URL/api/setup-token")"
  echo "$st2" | grep -q '"configured":true' && ok "generate 后 configured=true" || bad "generate 后状态未翻转：$st2"
  echo "$st2" | grep -q '"token"' && bad "GET 回显明文" || ok "GET 仍不回显明文"

  # D4 用该令牌注册受控端
  reg="$(req -H 'X-Forwarded-Proto: https' -H 'Content-Type: application/json' \
         -d "{\"setup_token\":\"$tok\",\"name\":\"acceptance-probe\"}" "$BASE_URL/api/setup/register")"
  c="$(code -H 'X-Forwarded-Proto: https' -H 'Content-Type: application/json' \
        -d "{\"setup_token\":\"$tok\",\"name\":\"acceptance-probe-2\"}" "$BASE_URL/api/setup/register")"
  echo "$reg" | grep -q '"agent_id"' && ok "注册返回 agent_id" || bad "注册失败：$reg"
  [[ "$c" == "200" || "$c" == "429" ]] && ok "重复注册走限流/正常路径（$c）" || bad "重复注册 → $c"

  # D5 清除后停用 + env 不回灌
  c="$(code -H 'X-Forwarded-Proto: https' -H "X-Admin-Token: $ADMIN_TOKEN" -H 'Content-Type: application/json' \
        -d '{"action":"clear"}' "$BASE_URL/api/setup-token")"
  [[ "$c" == "200" ]] && ok "clear → 200" || bad "clear → $c"
  st3="$(req -H "X-Admin-Token: $ADMIN_TOKEN" "$BASE_URL/api/setup-token")"
  echo "$st3" | grep -q '"configured":false' && ok "clear 后 configured=false" || bad "clear 后仍启用：$st3"
  c="$(code -H 'X-Forwarded-Proto: https' -H 'Content-Type: application/json' \
        -d "{\"setup_token\":\"$tok\",\"name\":\"after-clear\"}" "$BASE_URL/api/setup/register")"
  [[ "$c" == "403" ]] && ok "清除后注册 → 403" || bad "清除后注册 → $c（期望 403）"
fi

# ============================================================
printf "\n${Y}== 汇总 ==${NC}\n"
printf "  通过 %d / 失败 %d / 跳过 %d\n" "$PASS" "$FAIL" "$SKIP"
[[ "$FAIL" -eq 0 ]] && printf "${G}验收通过${NC}\n" || printf "${R}存在失败项${NC}\n"
exit $(( FAIL > 0 ? 1 : 0 ))
