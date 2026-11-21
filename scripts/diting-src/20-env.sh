# ── 脚本版本（语义化）──────────────────────────────────────────────────────────
# 每次修改本脚本行为，请同步 +1 版本号、更新日期与「本版要点」，方便用户对比是否
# 需要更新，并在更新后直观了解改动内容。远端菜单会据此提示「发现新版」。
SCRIPT_VERSION="1.1.9"
SCRIPT_DATE="2026-10-24"
SCRIPT_NOTES="服务端运行控制支持原生 systemd（新增 --start-server/--stop-server/--restart-server 与菜单「12) 服务端运行控制」，status 自动识别 systemd/Docker）"

# 颜色：仅当 **stdout 是终端** 时着色；管道 / CI / 重定向下一律置空。
# （附录 B 建议按 stderr 判定，但本脚本大量面向人的输出走 stdout——按 stderr 判会让
#   `diting.sh --status | cat` 里混进 ANSI 转义，因此这里按 stdout 判。）
if [[ -t 1 ]]; then
    RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'; BLUE=$'\033[0;34m'; NC=$'\033[0m'
else
    RED=''; GREEN=''; YELLOW=''; BLUE=''; NC=''
fi
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo "$PWD")"
# ── 仓库来源（L-17：REPO_BRANCH 可钉 tag，便于可复现安装）─────────────────────
# 发布时用 `REPO_BRANCH=v1.2.0 sudo bash diting.sh --install-server` 即可锁定版本；
# 默认 master 保持「跟随最新」的行为不变。REPO_RAW/REPO_GIT 仍可被显式覆盖。
REPO_BRANCH="${REPO_BRANCH:-master}"
REPO_RAW="${REPO_RAW:-https://raw.githubusercontent.com/fengzone85/diting/${REPO_BRANCH}}"
REPO_GIT="${REPO_GIT:-https://github.com/fengzone85/diting.git}"
SRC_DIR="/opt/diting-src"

# 把 $SRC_DIR 的工作树同步到 $REPO_BRANCH（分支或 tag 均可）。
# 旧实现把 `fetch origin master` / `reset --hard origin/master` 写死，导致
# `REPO_BRANCH=v1.2.0` 只改到 raw 下载（脚本/载荷），源码仍是 master —— 与
# 注释里"可钉 tag 便于可复现安装"的承诺不符。
# `fetch <ref>` 对分支和 tag 都成立，FETCH_HEAD 指向它；仅分支能设上游。
sync_source_ref() {
    local ref="${1:-$REPO_BRANCH}"
    git -C "$SRC_DIR" fetch origin "$ref" -q || return 1
    git -C "$SRC_DIR" reset --hard FETCH_HEAD || return 1
    git -C "$SRC_DIR" branch -u "origin/$ref" 2>/dev/null || true
    return 0
}

# ── 宿主侧环境（可选）────────────────────────────────────────────────────────
# /etc/diting/host.env 里配置后台可见备份目录与恢复请求路径：
#   BACKUP_VISIBLE_DIR=/opt/diting-backups
#   RESTORE_REQUEST_FILE=/opt/diting-backups/restore.request
# cron 行里也会 source 它；这里在【任何】调用场景下都读一次，这样手动执行
# `diting.sh --backup` 产出的备份同样会同步过去（否则后台列表里看不到）。
#
# ⚠ 必须「环境变量优先」：host.env 是无条件赋值（如 BACKUP_VISIBLE_DIR=xxx），
# 直接 source 会覆盖调用方显式传入的同名变量（例如临时用
# `BACKUP_VISIBLE_DIR=/tmp/x diting.sh --backup` 会失效，且不报错、很难排查）。
# 先存下环境中已存在的值，source 之后再恢复回去。
if [[ -f /etc/diting/host.env ]]; then
    _env_keep_visible="${BACKUP_VISIBLE_DIR:-}"
    _env_keep_request="${RESTORE_REQUEST_FILE:-}"
    # shellcheck disable=SC1091
    . /etc/diting/host.env
    [[ -n "$_env_keep_visible" ]] && BACKUP_VISIBLE_DIR="$_env_keep_visible"
    [[ -n "$_env_keep_request" ]] && RESTORE_REQUEST_FILE="$_env_keep_request"
    unset _env_keep_visible _env_keep_request
fi

# 带值参数的缺值保护：脚本开头 set -u，裸 $2 在漏写值时会让 bash 直接
# 以「$2: unbound variable」中断，连用法提示都来不及打印。
# 用法：need_val_guard <选项名> <值>
need_val_guard() {
    if [[ -z "${2:-}" || "$2" == --* ]]; then
        echo -e "${RED}[错误] 参数 $1 缺少取值${NC}" >&2
        echo -e "       用法见: $0 --help" >&2
        exit 1
    fi
}

# ── 非交互参数（供 CI / 批量部署）─────────────────────────────────────────────
ACTION=""
A_SERVER=""; A_ID=""; A_TOKEN=""; A_TOKEN_FILE=""; A_SETUP=""; A_SETUP_NAME=""; A_INTERVAL=""; A_PROBE_TARGETS=""; A_MONTH_ROTATE=""
A_BACKUP_PATH=""; A_BACKUP_KEEP=""; A_BACKUP_SCHEDULE=""
# 服务端监听端口（安装时确定，写入 .env 的 PORT；空 = 交互询问 / 沿用现值）
A_SERVER_PORT=""
# --logs 的可选参数：行数或 follow
A_LOG_ARG=""
# 跳过保护性检查（当前用于：升级前备份失败仍继续）。默认 0 = 严格模式。
A_FORCE=0

show_usage() {
    cat <<EOF
谛听轻量探针 一键部署脚本

用法（交互）：
  sudo bash diting.sh                 # 显示菜单，逐项选择

用法（非交互 / 一键）：
  # 安装服务端（Docker，自动生成强随机令牌）
  sudo bash diting.sh --install-server

  # 可选：无面板 / 无域名的局域网机器，一键起自签 HTTPS 反代（占用 443）
  #       默认部署请用宝塔 / 1Panel / 已有 Nginx 绑定域名反代，见 reverse-proxy.md
  sudo bash diting.sh --bundled-proxy

  # 安装受控端（需先在服务端后台「新建客户端」拿到 ID/Token）
  sudo bash diting.sh --install-agent --server https://your-server:8008 --id NODE1 --token SECRET

  # 安装受控端（一键自助注册：只需服务端地址 + SETUP_TOKEN）
  sudo bash diting.sh --install-agent --server https://your-server:8008 --setup-token <SETUP_TOKEN>

  # 更新本安装脚本（覆盖为 GitHub 最新版）
  sudo bash diting.sh --update-script

  # 更新服务端（拉取最新源码并重建容器）
  sudo bash diting.sh --update-server

  # 更新受控端（保留已注册身份，拉取最新 agent 代码）
  sudo bash diting.sh --update-agent

  # 查看状态 / 卸载
  sudo bash diting.sh --status
  sudo bash diting.sh --uninstall

  # 服务端进程控制（自动识别原生 systemd 与 Docker 形态）
  sudo bash diting.sh --restart-server
  sudo bash diting.sh --stop-server
  sudo bash diting.sh --start-server

  # 数据库备份 / 恢复 / 管理
  sudo bash diting.sh --backup [输出路径]         # 备份数据库（默认存到 ${DB_BACKUP_DIR:-/var/backups/diting}）
  sudo bash diting.sh --restore <备份文件路径>    # 从备份恢复（自动先备份当前状态）
  sudo bash diting.sh --backup-list               # 列出已有备份（含占用/时间跨度/定时状态）
  sudo bash diting.sh --db-stats                  # 查看数据库统计（大小/记录数/时间范围）
  sudo bash diting.sh --db-vacuum                 # 压缩数据库并启用增量回收（回收空闲页）
  sudo bash diting.sh --logs 200                  # 查看服务端最近 200 行日志（follow=持续跟踪）

  # 每日自动备份（cron，默认凌晨 3 点；默认保留 14 天并自动清理过期）
  sudo bash diting.sh --backup-schedule install      # 安装
  sudo bash diting.sh --backup-schedule status       # 查看是否已启用
  sudo bash diting.sh --backup-schedule uninstall    # 取消
  sudo bash diting.sh --backup --keep-days 30        # 单次备份并保留 30 天

  # 管理员凭据救援（丢失凭据时使用，需 SSH 登录服务器）
  sudo bash diting.sh --reset-admin-token         # 生成新管理员 Token（旧 Token 立即失效）
  sudo bash diting.sh --reset-admin-password      # 清除管理密码与恢复码（回到纯 Token 登录）
  sudo bash diting.sh --reset-2fa                 # 关闭 2FA 并清除 TOTP 密钥与恢复码

  # 版本发布（推进 server/package.json 并打 vX.Y.Z tag，页脚版本随 tag 生效）
  sudo bash diting.sh --release                    # 补丁版 +1（1.0.1 → 1.0.2）
  sudo bash diting.sh --release minor              # 次版本 +1（1.0.x → 1.1.0）
  sudo bash diting.sh --release major              # 主版本 +1（1.x → 2.0.0）
  sudo bash diting.sh --release 1.6.0              # 指定具体版本号

  # IP 白名单配错把管理员锁在门外时的救援（改库即时生效，无需重启）
  sudo bash diting.sh --clear-ip-whitelist        # 清空 admin_allow_ips，恢复全放行

选项：
  --install-server        安装服务端（Docker）
  --port N                服务端监听端口（1-65535，默认 8081；配合 --install-server）
  --install-agent         安装受控端（systemd）
  --update-script         更新本安装脚本为最新版
  --update-server         更新服务端（升级前自动备份数据库；原生 systemd 形态做应用级就绪探测，
                          失败自动回滚代码与数据库；Docker 形态 git pull + 重建容器）
  --force                 跳过保护性检查（升级前备份失败时仍继续，谨慎使用）
  --update-agent          更新受控端（systemd，保留原连接配置）
  --status                查看服务端/受控端状态（自动识别 systemd / Docker）
  --start-server          启动服务端（原生 systemd 或 Docker，自动识别）
  --stop-server           停止服务端
  --restart-server        重启服务端（改完代码/配置后生效）
  --deploy-server         同步服务端运行副本到仓库树外（默认 /data/simple-probe-data/server-data/app，
                          DITING_APP_DIR 可覆盖；含 npm ci 与版本文件写入；不重启服务）
  --logs [行数|follow]    查看服务端日志（自动识别 systemd / Docker，默认最近 100 行）
  --uninstall             卸载服务端与受控端
  --uninstall-server      只卸载服务端（原生 systemd 停止/disable/清理 unit，Docker compose down；
                          保留数据库与 .env，不动受控端）
  --backup [路径]         备份数据库（不指定路径则存到 /var/backups/diting/）
  --keep-days N           备份保留天数（默认 14，超出自动清理；0=不清理）
  --compress / --no-compress   是否 gzip 压缩备份（默认压缩，体积约 20%）
  --restore <路径>        从备份恢复数据库（恢复前自动备份当前状态）
  --backup-list           列出已有备份
  --backup-schedule 动作  每日自动备份：install / uninstall / status
  --process-restore       消费后台「恢复」请求（由 cron 每 5 分钟调用，勿手动执行）
  --db-stats              查看数据库统计信息
  --db-vacuum             压缩数据库（VACUUM）并启用增量回收，回收历史删除留下的空闲页
  --reset-admin-token     重置管理员 Token（丢失时使用，旧 Token 立即失效）
  --reset-admin-password  清除管理密码与恢复码（忘记密码时使用，回到纯 Token 登录）
  --reset-2fa             关闭 2FA 并清除 TOTP 密钥与恢复码（TOTP 设备丢失且恢复码不可用时）
  --release [类型]        版本发布：patch/minor/major/具体版本号（默认 patch），打 tag 并推送
  --clear-ip-whitelist    清除管理端 IP 白名单（误配锁门时救援，改库即时生效）
  --server URL            SERVER_URL
  --id / --token          节点 ID 与令牌（手动模式）
  --token-file FILE       从文件读取令牌（推荐，避免明文暴露）
  --setup-token SECRET    用服务端 SETUP_TOKEN 自助注册（免 --id/--token）
  --setup-name NAME       自助注册的节点显示名（可选）
  --interval SEC          上报间隔（秒，默认 15）
  --probe-targets LIST    网络质量自测目标（label:host[:port] 逗号分隔；覆盖默认）
  --month-rotate N        流量重置日（0=累计口径，1–31；仅 Go 受控端，默认 0）
  --repo URL              自定义 raw 仓库地址（默认本项目 master 分支）
EOF
}

