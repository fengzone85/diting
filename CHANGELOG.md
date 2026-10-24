# Changelog

> **注意**：本文件自 **2026-09-07** 起恢复维护（下方该日期及以后的条目为新增）；2026-08-03 前的条目为当时快照，可能与现状有出入，个别条目下方附了「勘误 / 后续修订」。完整变更请以 `git log` 为准。

## 2026-10-24 备份保留份数上限（F8.4）

### ⚠️ 行为变更

- **双重保留策略**：除既有「保留天数」（`backup_keep_days`，默认 14 天）外，新增
  **保留份数** `backup_keep_count`（默认 10，`0` = 不限）。每次备份完成后先按天清理，
  再按 mtime 删除最旧的 `monitor_*`（含 `.db.gz` 与上传件），直到不超过份数上限。
- **升级后首次备份可能清理历史文件**：若现有 `monitor_*` 超过 10 份，下次备份完成时会
  自动清到 10 份。需长期保留请先下载归档，或把「保留份数」调大 / 设为 `0`。
- `pre_restore_*` 永不自动清理：它们是恢复失败时的回滚点，沿用宿主既有约定。
- 可见目录（`BACKUP_VISIBLE_DIR`）的副本执行同样的份数清理，避免源目录与副本双份增长。
- 备份页备份保留区域新增「保留份数」输入；脚本可用 `DB_BACKUP_KEEP_COUNT` 覆盖。

## 2026-10-24 应用内快照与宿主备份一致性修复（F8.1 / F8.5）

### ⚠️ 修复（数据安全）

- **宿主 `--backup` 不再热 cp**：`diting.sh` 的宿主文件分支原先直接 `cp` 正在写入的
  `monitor.db`。rollback journal 模式的提交是「写 journal → 改页 → 删 journal」，cp 落在
  改页窗口会拷到半提交状态的库（原注释写「需先 flush」，但代码既无 flush 也无 checkpoint）。
  现在优先 `sqlite3 VACUUM INTO`（读事务内导出已提交内容，顺带去掉空闲页）；无 sqlite3 时
  先 `systemctl stop diting-server` 再拷贝，**无论成败都恢复服务**。
- 容器分支保持不变（已有 `sqlite3 .backup`）；卷分支在容器停止时拷贝，本身安全。

### 新增

- **应用内一致性快照**：`POST /api/admin/backups` 经 `db.backupTo()`（better-sqlite3
  `db.backup()` 在线备份）生成 `monitor_YYYYMMDD_HHMMSS.db`，无需停服；产物沿用宿主命名规则，
  权限收紧为 0600，并写 `create_backup` 审计（含文件大小）。
- **备份页「立即备份」按钮**：点击即在服务内生成快照，成功后刷新列表与备份监控。
- API 文档补充 `POST /api/admin/backups`。

### 说明

- 应用内快照产物为未压缩 `.db`，与上传件一样受既有保留策略管理；需长期保留请下载归档。

## 2026-10-24 备份完整性预检（F8.3）

### ⚠️ 行为变更

- **恢复前强制校验**：`POST /api/admin/backups/:name/restore` 对选中的 `.db` 先做
  `PRAGMA integrity_check`（只读连接、独立子进程、10 秒超时）；失败或超时返回 400 并拒绝恢复，
  不会写恢复请求文件。`.gz` 备份无法就地打开 → 标 `unknown` 放行，由 `diting.sh` 解压后
  在同一流程里校验（宿主无 sqlite3 时仅校验魔数）。
- **列表显示三态**：`GET /api/admin/backups` 的每项新增
  `integrity: 'ok' | 'fail' | 'unknown'` 与 `integrity_reason`。为避免每次刷新都完整扫描
  大库，列表每个请求最多抽查 1 个未缓存文件（`quick_check`），结果按 `size + mtime` 缓存；
  其余显示「未校验」，多次刷新逐步覆盖。
- **前端**：备份文件列表新增「完整性」列（正常 / 异常 / 未校验，异常悬停显示原因）；
  恢复提示补充校验时机说明。

## 2026-10-24 恢复后一致性审查（F8.6）

### ⚠️ 行为变更

- **恢复动作能查到了**：恢复会用备份整库覆盖当前库，后台点「恢复」时记的 `request_restore_backup`
  会随旧库一起消失。现在 `diting.sh` 在恢复完成后向新库补记 `restore_backup`
  （`ok` / `failed` / `cancelled`，含 `pre_restore` 回滚点），服务端审查完成后再记
  `restore_completed`（来源备份、8 项结果摘要、待清理预估）。审计 `admin` 列记录发起者
  （`admin(session) 1.2.3.4` / `host(cli)`），`via=script`。
- **恢复后自动审查 8 项**：`diting.sh` 在替换数据库前把 `admin_config.restore_audit_pending`
  写进「即将生效」的副本（无 sqlite3 时降级为备份目录 `.restore_audit_pending.json`），
  服务启动时依次检查：结构完整性、retention 预演、折叠水位线、明细/小时重叠、流量缺口、
  孤儿数据、软删过期、容量水位。S2 / F11 / F12 未落地时对应项标「跳过」而不是失败。
- **流量缺口不计入当月用量**：`traffic_state.last_ts` 落后超过 `max(3 × 上报间隔, 1h)` 时，
  把 `last_rx/last_tx` 重置为 NULL（下一条上报只建基线），避免整段缺口的累计增量被
  `max(baseRx - last_rx, 0)` 一次性算进当月、误触配额告警；内存 `trafficCache` 同步重置，
  防止下次 flush 写回旧基线。
- **孤儿与过期软删立即清理**：`metrics` / `metrics_hour` / `traffic_state` / `alert_state` /
  `alert_overrides` / `online_sessions` 中 agent 已不存在的行直接删除；`agents.deleted_at`
  超过 7 天的节点在启动审查时即 purge。
- **结构完整性失败拒绝启动**：提示从 `pre_restore_*.db` 回滚；标记保留，修好后重启会再查一次
  （避免带着坏库继续写入）。审查自身异常只记日志，不影响启动。
- **备份页新增「最近一次恢复审查」面板**：恢复时间、来源备份（含备份文件时间）、发起者、
  各项检查结果与待清理预估；retention 一项额外给出过期数据的最早/最晚时间与**按保留周期分段的批次**；
  `GET /api/admin/backups` 增加 `restore_audit` 字段（只读角色不返回，口径同审计日志）。
- **后台顶部黄条**：恢复自较早的备份且过期数据占比超过 30% 时，后台所有页面顶部提示
  「恢复自 N 天前的备份：X% 数据（Y 行）将在下次清理中被删除」，可跳转备份页或按报告忽略；
  `GET /api/admin/restore-audit` 为黄条提供轻量数据源（避免为一个提示拉整个备份目录）。
- **WAL 提示**：当前用 rollback journal，覆盖 `monitor.db` 安全；若将来启用 WAL，替换流程必须
  同时删除 `-wal`/`-shm`（已写入 `diting.sh` 注释与宿主机分支）。

## 2026-10-24 节点删除改为软删（7 天缓冲）

### ⚠️ 行为变更

- **删除节点不再立即物理删除**：节点立即从面板 / 公开页 / 告警 / AI 统计中消失，但 `agents` 行与
  全部历史（`metrics` / `traffic_state`）保留 **7 天**；期间可在「最近删除」一键恢复——身份、配置、
  历史原样，恢复后最多 10 分钟自动重新上报（agent 对 401/403 只做 10 分钟退避、不会退出）。
- **删除确认文案**：列表 / 批量 / 详情三处改为「身份与历史保留 7 天后自动清理」口径，不再提示「无法恢复」。
- **新增 API**：`GET /api/agents/deleted`（最近删除，含剩余天数）、`POST /api/agents/:id/restore`（恢复）。
  `DELETE /api/agents/:id` 响应兼容（200 + `grace_days: 7`），但实际执行软删。
- **7 天后物理清理**：每小时 prune 顺带执行 `purgeDeletedAgents()`——先显式清 `alert_state` /
  `alert_overrides`（以及存在时的 `metrics_hour`）与内存流量缓存，再删 `agents` 行，
  由 FK CASCADE 带走 `metrics` / `traffic_state`；整条清理在一个事务内，失败整体回滚。
- **软删期间告警冷却与覆盖保留**：`alert_state` / `alert_overrides` 不动，恢复后不会立刻重复通知。
- **新增 `agents.deleted_at` 列**（`ALTER TABLE ADD COLUMN`，存量数据 NULL = 未删除，毫秒级）。

## 2026-10-22 安装向导（对照 komari）+ 管理员 Token 入库哈希 + 安装器端口 / 升级备份

首次部署体验向 komari 对齐：未安装时全站 307 到 `/install`，管理员 Token 由向导生成且**只存 sha256 哈希**；
同时修掉 `--reset-admin-token` 改完 `.env` 却不生效的老问题（改库即生效，无需重启）。

### 说明

- **管理员 Token 入库哈希**（`admin_config.admin_token_hash`）：明文只在向导完成页显示一次，
  库文件 / 备份泄露不再等于拿到 Token。启动时若库中无哈希而 `.env` 有可用值，会自动迁移一次，
  之后 `.env` 的 `ADMIN_TOKEN` 仅打印「已废弃」告警、不再参与鉴权。
- **未安装判据 = 库中无哈希**：对齐 komari 的 users 计数语义，不再依赖环境变量，也不需要
  `admin_initialized` 之类的标志位——哈希存在性本身就是锁（多实例并发由 `INSERT OR IGNORE` 收敛）。
- **安装向导 `/install`**：未安装时页面 GET 一律 307 进向导、管理面 API 返回 404（对齐 komari
  `guideNoRoute`，不暴露"未安装"指纹）；agent 上报面与 `SETUP_TOKEN` 自助注册不受影响。
  表单字段：站点名称、描述、站点网址（选填）、**上报地址（必填）**、管理员 Token（自动生成 / 自定义）。
  上报地址是受控端安装命令的前置依赖（`getPublicBaseUrl` 优先级 `agent_server_url > site_url > PUBLIC_URL`），
  在向导里一次填好，装完不必再回设置页补。
- **HTTPS 强制的本地例外**：`requireProto` 允许「本机 / 内网来源 + 零代理头」的明文请求，
  供安装向导的 `ssh -L` 隧道使用。Docker 端口发布（`127.0.0.1:PORT->PORT`）经 DNAT 后，
  容器里看到的来源是**网桥地址 `172.17.0.1`** 而不是 127.0.0.1，因此判据覆盖 RFC1918 私网
  而非只认回环（只认回环会让隧道在 Docker 部署下必 403 —— 全新 Docker 验收实测）。
  带任何 `X-Forwarded-*` / `Forwarded` 头的请求仍按原规则判定，公网来源直连仍 403。
- **安装器不再预生成 ADMIN_TOKEN**（旧版"首装不弹引导"的直接原因），只生成 `SESSION_SECRET` / `SETUP_TOKEN`；
  新增 `--port N` 与交互式端口选择（1–65535，默认 8081），`.env` 的 `PORT` 驱动 compose 的
  `ports` / `PORT` 参数化。
- **`--reset-admin-token` 改为直接写库哈希**：不再改 `.env`、不再 `docker compose restart`
  （`restart` 用容器创建时的配置，新值根本进不去），写库后下一个请求即生效，并吊销既有会话。
- **`--update-server` 升级前自动备份数据库**（在 `compose down` **之前**，否则容器已停、定位不到库），
  备份失败默认中止、`--force` 才继续；重建后再用容器运行态复核，失败给出数据 / 代码两条回滚命令。
- **交互层改纯文本**：移除 whiptail/dialog 两套渲染路径，`UI_BIN` 退场；颜色仅在 stdout 是终端时输出
  （`--status | cat` 不再混入 ANSI）；`ui_menu` / `ui_prompt` EOF 返回非零（管道场景不再静默成功），
  `ui_confirm` 保持"空 = 取消"（卸载 / 重置类操作安全优先）。

### 兼容性

- **存量 Docker 部署**：`docker-compose.yml` 暂时保留 `- ADMIN_TOKEN=${ADMIN_TOKEN}`，让启动迁移
  能读到旧明文；待存量迁移完成后该行可删（新装实例的 `.env` 已是空值，`docker inspect` 看不到明文）。
- `.env` 的 `ADMIN_TOKEN` 可删；删之前请确认服务端启动日志已出现「管理员 Token 已就绪（来源：数据库哈希）」。
- 端口参数化后，若曾手工改过 compose 的端口映射，请改用 `.env` 的 `PORT`；改完需
  `docker compose up -d --force-recreate server`（`restart` 不会重新发布端口）。

## 2026-10-21 通知组收尾：迁移提示 + NOTIFY_GROUPS=0 回退开关（S2-F2 收尾）

补齐 S1-F2 方案（§8/§9）遗留的两项与测试独立化。

### 说明

- **新增回退开关 `NOTIFY_GROUPS=0`**：设为 `0` 时整体退回 F2 之前的「邮件 + Telegram 直发」路径
  （按 `notify_config` 凭据投递，完全绕开通知组与事件路由），供通知组上线后的紧急灰度回退；
  默认 `1` = 通知组路由。`notify.groupsEnabled()` 供端点与测试查询当前态。
- **新增迁移状态端点** `GET /api/admin/notify/migration-status`：返回
  `{ legacy_config_present, default_group_present, banner, groups_enabled }`。
  判定幂等（不依赖一次性状态位）：旧凭据仍在 `notify_config` 且 `default` 组已存在 ⇒ 迁移已生效。
- **后台通知面板新增迁移提示横幅**：检测到上述条件时提示「旧版通知配置已自动迁移到 default 通知组，
  行为与升级前一致」；用户点「知道了」后记入 `localStorage` 不再出现。
  `groups_enabled=false` 时额外提示当前正按旧版直发。
- **测试独立化**：种子迁移用例从 `notify.test.js` 移入新文件 `notify-migration.test.js`
  （幂等 / default 组恢复 / 端点三种判定 / 启用态对照），新增 `notify-legacy-path.test.js`
  专测 `NOTIFY_GROUPS=0` 回退态（含「配了 webhook 渠道也零请求」的绕开证明）。
- 文档：`docs/env.md` 补 `NOTIFY_GROUPS`，`docs/api.md` 补迁移状态端点。

## 2026-10-21 登录会话管理：列表 / 单点踢出 / 批量注销（S2-F6）

### ⚠️ 行为变更

- **登录态可按会话粒度吊销**：登录成功后服务端写入 `sessions` 表，并把 `sid`（24 位 hex）放进签名
  Cookie。此前只有全局水位线（`session_revoked_before`），无法踢出单台设备。
- **新增后台「登录会话」页**（系统 → 登录会话）：列出每台已登录设备的来源 IP、浏览器标识、登录时间与
  最后活动，可逐条踢出，或「踢出其它设备」（保留当前会话）/「全部注销」（含当前会话）。
- **吊销立即生效**：吊销时同步失效服务端会话校验缓存，被踢设备的下一次请求即 401（不等缓存 TTL）。
- **DB 故障时的会话校验取舍（需安全评审知悉）**：查 `sessions` 表异常时**默认 fail-open**（Cookie 签名
  有效且未过全局水位线即放行并记错误日志），避免单机 SQLite 损坏把管理员永久锁死；设
  `STRICT_SESSION_DB=1` 切换 fail-close（DB 故障时拒绝一切会话）。
- **旧 Cookie 兼容**：升级前签发、不带 `sid` 的 Cookie 仍放行至自然过期（12 小时 TTL），下次登录即带 `sid`。
- **会话行自动清理**：每小时 prune 任务删除 `last_seen` 超过 2×SESSION_TTL 的会话行（含已吊销行）。

### 说明

- 会话列表含来源 IP 与浏览器标识，属跨设备敏感信息：仅全局作用域管理员可读；节点白名单 Token
  （`agent_ids` 非空）一律返回 `403 forbidden_scope`。
- 新增管理端点：`GET /api/admin/sessions`、`DELETE /api/admin/sessions/:id`、
  `POST /api/admin/sessions/revoke-all`（body `{ keep_current?: boolean }`，默认保留当前会话）。
- 审计：单点吊销记 `session_revoke`，批量吊销记 `session_revoke_all`。
- 会话校验带 5 秒内存缓存（每 sid 每 5 秒查一次表）；缓存上限 1000 条，吊销时立即失效。
- 登录时若会话行写入失败（DB 异常），降级为不带 `sid` 的旧格式 Cookie —— 与 fail-open 取舍一致，
  不让 DB 故障把管理员挡在门外。
- 实施计划见 `dev-docs/IMPLEMENTATION_PLAN_2026-10-19.md` F6。

## 2026-10-21 登录暴力防护：失败计数 + 指数封禁（S2-F9）

### ⚠️ 行为变更

- **登录失败 3 次起按 IP 指数封禁**：封禁时长 = 失败次数 ^ 4（3 次 → 81 秒、4 次 → 256 秒、
  5 次 → 625 秒，上限 24 小时）。封禁期内 `POST /api/login` 返回 `429` + `Retry-After` 响应头
  （响应体 `error=login_blocked` + `retry_after` 秒数）。
- **成功登录即清零**：该 IP 的失败计数与封禁一并解除 —— 管理员自己输错后不必再等封禁结束。
- **计数维度是来源 IP**：diting 登录是「管理员 Token + TOTP」，Token 唯一且共享、本就没有
  用户名维度，故以 IP 为计数单元。同一出口 NAT 下的他人输错会一并影响你，反之亦然。
- **管理员本人输错 3 次同样会被封**：需等 `Retry-After` 到期，或重启服务端立即解除
  （封禁状态在内存中，重启即清零）。
- **原有固定窗口限流保留**：`每 IP 每 60 秒 5 次` 仍在，与指数封禁叠加；两者 429 的错误码不同
  （`too many login attempts, retry in 60s` = 窗口限流，`login_blocked` = 指数封禁）。
- **登录页错误提示改为统一错误码映射**（`apiErrorMessage`）：`login_blocked`、
  `too many totp failures` 等已本地化，不再把原始错误码（如 `login_blocked (HTTP 429)`）
  直接显示给用户。

### 说明

- 封禁公式对齐 nezha `model/waf.go` 的 `count^4`；封禁触发时写审计（action=`login_banned`，
  detail 只记 IP 的 sha256 前 16 位哈希，不落明文）。
- 内存态实现（`server/src/ratelimit.js` 的 `loginGuard`）：状态经 `loadState`/`saveState`/
  `deleteState` 三个钩子存取，将来升级持久化只需替换钩子实现；状态表有上限（10000 条）并
  惰性淘汰，内存有界。
- 失败计数保留 1 小时（无失败则归零）；封禁条目的存活期覆盖封禁期，避免 24 小时封禁在
  1 小时后被 TTL 清零而使计数意外归零。
- 实施计划见 `dev-docs/IMPLEMENTATION_PLAN_2026-10-19.md` F9。

## 2026-10-21 S5：主题市场

主题从「只能把目录拷进镜像」升级为可安装、可配置、可回滚的市场体系（插件市场暂不做）。

- **目录策略**：新增 `THEMES_DIR`（默认 `<DB_PATH 同级>/data/themes`）作为安装目录，随数据卷持久；
  `public/themes` 降级为只读内置目录。资源查找改为「安装目录 → 内置目录」两级，
  同名安装版覆盖内置版，Docker 重建镜像不再丢失已装主题。
- **manifest 三级兼容**：`diting-theme.json` → `komari-theme.json` → `manifest.json`；
  新增 `short` / `version` / `diting.compatibility` / `diting.needsRelaxedCsp` /
  `configuration`（仅 `managed`）。`name`/`description` 支持 i18n map 归一化；
  旧 `manifest.json` 仍可用且豁免版本/兼容性校验。
- **CSP nonce 动态化**：`THEME_NEEDS_NONCE` 不再硬编码主题名，由 manifest 声明后
  `src/theme.js` 原地重建同一个 Set（server.js 持有引用）。
- **主题市场后端**：新增 `theme_market_sources` 表与源 CRUD、catalog 缓存（10 分钟）、
  ZIP 安装/URL 导入/GitHub 仓库导入/更新/备份回滚。下载复用通知模块的 SSRF 防护
  （钉 IP、禁 3xx、默认拒绝私网与明文 http），ZIP 解压做路径穿越/绝对路径/符号链接/
  声明大小/文件数/总量校验。
- **配置值与只读接口**：`theme_config_<short>` 持久化；新增
  `GET /themes/<short>/config`（受 `public_enabled` 门控，注册在静态资源正则之前）。
- **后台 UI**：「设置 → 主题市场」面板，含已安装（内置只读标识/启用/配置/更新/备份/删除）、
  市场目录安装、来源管理、URL/GitHub 导入。
- **测试**：新增 `theme-manifest` / `theme-market` / `theme-regression` / `theme-zip-security` /
  `theme-ssrf` / `theme-server` 六个后端测试文件；前端 i18n 覆盖守卫同步通过。
- **错误码映射**：新增 `web/src/utils/themeError.ts`，把 `insecure_scheme` / `blocked_target` /
  `http_404` 等 60+ 个服务端码翻译成可操作提示（来源卡片与操作报错统一使用）。
- **DNS 伪答案**：`resolveHost` 忽略 `::` / `0.0.0.0` 这类不可路由的 AAAA/A 伪答案，
  不再因单条伪答案误判 `blocked_target`；真实私网地址仍按"任一受限即拒绝"处理。

## 2026-10-21 模板设置页配色与文案修复

- **内嵌区块配色与整体不一致**：暗色/亮色「背景」与「公告」三块原用 `bg-surface`
  （`#3a3e44`，设计系统里是 hover/accent 深灰），放进暗色 glass 卡片后明显发亮、发灰。
  新增 `.inner-panel`（`--glass-inner-tint` + `--glass-inner-border`，随暗/亮主题切换）并替换。
- **5 个 i18n 键漏配导致页面直接显示原始 key**：模板设置页曾渲染出
  `settings.glassPreset` / `settings.colorVision` / `settings.cardScheme` /
  `settings.cardSize` / `settings.announcement`。改为复用已有的
  `theme.glassPreset` / `theme.colorVisionMode` / `theme.cardScheme` /
  `theme.cardSize` / `theme.announcement`。
- **新增 i18n 覆盖守卫**：`src/utils/i18n/coverage.test.ts` 扫描源码中所有静态
  `t('key')`，断言键在中英词典均存在、且两侧键集合一致；动态拼接键（`t('x.' + y)`）自动跳过。
  前端单测 56 → 60 项。

## 2026-10-21 后台侧栏与页面健壮性修复（代码审查）

对上一版侧栏改动做逐页核验时发现并修复的 4 个缺陷：

- **移动端抽屉继承了桌面收起态样式**：`.is-collapsed` 的「隐藏文案 + 居中 + 零内边距」
  写在媒体查询之外，桌面收起过（localStorage=1）后打开移动端抽屉，菜单图标与文字
  会浮在行中间。现统一收进 `@media (min-width: 1024px)`。
- **移动端点品牌不关抽屉**：品牌区是 `RouterLink`，点击后抽屉与遮罩仍开着；补 `emit('close')`。
- **429 / 网络异常导致后台白屏**（既有缺陷）：`getAuthStatus()` 对非 2xx 直接抛错，
  `router.beforeEach` 未捕获 → 初始导航中断，URL 正确但 `#app` 为空。现抽出
  `router/guard.ts::makeAuthGuard`：未登录仍跳登录页（保留 `redirect`），
  探活本身失败则**放行**（服务端鉴权仍在，白屏比错误提示更糟）；附 4 条单测。
- **设置页冷加载抛 TypeError**（既有缺陷）：模板 `v-model="local.ui.alert!.cpu_pct"`
  在 settings 未到达（冷加载 / 429 / 5xx）时读到 `undefined`，整页渲染中断、只剩残缺 DOM。
  `resetLocal()` 补上与服务端一致的 `alert` 默认值（90/90/60）。
- 顺带：收起态菜单项补 `aria-label`（文案 `display:none` 后保住可访问名）。

回归：新增 `npm run e2e:pages`（8 个后台页逐页渲染 + 高亮唯一 + 收起态跨页保持）。

## 2026-10-21 后台侧栏信息架构整理（参考 Komari）

### 变更

- **菜单按「监控 / 运维 / 系统」分组**：仪表盘·受控端·账单概览 / AI 运维分析·审计日志 /
  API Token·设置·模板设置。分组标题在收起态隐藏，靠间距分隔。
- **新增收起 / 展开侧栏**：桌面端可收成 4.5rem 图标轨（仅图标，`title` 作悬浮提示），
  状态记在 `localStorage['diting.admin.sidebar.collapsed']`，刷新后保持；移动端抽屉始终全宽。
  收起态隐藏「D」字标与站名，由展开图标居中顶替该位置（对齐 Komari，避免图标与字标重叠）。
- **新增「返回主页」**：侧栏底部直达公开首页（`/`），与「退出」并列。
- **侧栏改为桌面端 sticky 满高**：页面很长时底部入口仍固定在视口内，菜单区自己滚动
  （此前 `position: static` 会让 footer 掉到长页面最底部）。
- **修正菜单高亮**：`/admin` 改为精确匹配，此前任何 `/admin/*` 子页都会把「仪表盘」标为激活。
- 菜单文案改由 `computed` 派生，切换语言时即时更新（此前为一次性数组，切语言不刷新）。
- 回归：新增 `npm run e2e:menu`（`server/test/e2e/admin-sidebar.e2e.mjs`），
  覆盖分组标题、收起/展开宽度、localStorage 持久化、视口内底部入口、返回主页、移动端抽屉。

## 2026-10-20 API Token 细粒度作用域 + 管理端点（S2-F5）

### 新增

- **`api_tokens` 表**：库中只存 `token_hash`（SHA-256），`agent_ids` 为 JSON 数组
  （`[]` = 不限节点），另含 `scope` / `expires_at` / `last_used_*` / `revoked`。
- **`X-API-Token` 认证通道**：`resolveRole` 只在该头查 Token；`Authorization: Bearer`
  仍**仅**用于受控端上报与 `/metrics`，从协议层消除「同一 Bearer 是 Admin 还是 Agent」的歧义。
- **中层 `agentScope` / `inAgentScope`**：`agent_ids` 非空时把请求标记为受限，供 handler 判定归属。
- **Token 管理端点**（仅 admin）：`POST /api/admin/api-tokens`（明文 `diting_<48hex>`
  只回显一次）、`GET`（列表脱敏，无明文/哈希）、`DELETE /:id`（吊销即时生效）。

### ⚠️ 行为变更（仅影响受限 Token，全局凭证行为不变）

- **单节点面越权 → `403 forbidden_node`**：`/agents/:id`、`/agents/:id/metrics`、
  `PUT`/`DELETE /agents/:id`、`approve` / `renew` / `reset-token` / `commands`、
  `/admin/alert-rules/agent/:id`、`/ai/analyze-node/:id`、`/ai/node-reports?agent_id=`。
- **全局面拒绝 → `403 forbidden_scope`**：`/overview`、`/agents/sparklines/overview`、
  `/billing`、`/admin/alert-rules`、`/ai/usage`、`/ai/reports`、`/ai/reports/:id`、
  `/admin/audit-logs`（含全部节点 id/操作轨迹，无法裁剪成「仅自己的记录」）、Token 管理端点。
- **`/agents` 与 `/agents/sparklines` 改为按白名单过滤**（而非拒绝），受限 Token 仍能看自己的节点。
- **全局配置 / 基础设施写接口同样 `403 forbidden_scope`**：`POST /agents`、`PUT /settings`、
  `POST /test-alert`、`PUT /ai/config`、`POST /ai/run`、通知渠道与通知组增删改/测试、
  `PUT/DELETE /admin/alert-rules/group/:grp`、备份下载/删除/恢复、`/admin/2fa/*`、
  `POST /public/order`。受限 Token 的授权范围是「这几个节点」，全局变更（关掉全站告警、
  改系统设置、重建 2FA）与节点边界无关，必须拒绝。
- `READONLY_TOKEN` / `X-Admin-Token` 等既有凭证不受影响（等价于 `agent_ids=[]`）。

### 说明

- **提权路径已封**：受限 Token 调用 Token 管理端点一律 `forbidden_scope`；否则签发一个
  `agent_ids=[]` 的 Token 即可绕过节点边界。
- 创建校验：`name` 必填、`scope` 仅 `readonly|admin`（缺省 `readonly`）、`agent_ids`
  须为已存在节点（`400 unknown_agent_id`）、`expires_in_days` 为 1–3650 整数。
- 吊销语义：不存在或已吊销统一 `404`（底层 `UPDATE` 对已吊销行同样算命中，故先查状态）。
- 回归：`test/api-token-scope.test.js`（9 组）、`test/api-tokens-admin.test.js`（6 组），
  含「越权写不落库」「吊销后立即 401」「受限 Token 不能管理 Token」等断言。
- 可选 E2E（真实浏览器，不进 `npm test`）：`npm run e2e:tokens`，覆盖
  登录→签发→一次性明文→复制→作用域→吊销全链路；Playwright 需在仓库外安装
  （见 `server/test/e2e/api-tokens.e2e.mjs` 头注释），避免 CI 拉浏览器。

## 2026-10-20 通用 Webhook 通知渠道 + 通知组（S1-F2）

### ⚠️ 行为变更

- **通知投递改为「通知组 × 事件」路由**：新增 `notify_channels` / `notify_groups` /
  `notify_group_channels` 三表，启动时幂等种子化（mail/telegram 内置渠道 + `default`
  组订阅 `*`）。升级后默认行为与旧版一致，无需配置迁移。
- **新增通用 Webhook 渠道**：支持 URL / GET-POST / JSON-Form / 自定义头 / 请求体模板
  （`{{title}} {{message}} {{event}} {{agent}} {{agent_id}} {{time}} {{emoji}}`，
  JSON 值自动转义），可对接钉钉/飞书/企业微信/Bark/Server酱等。
- **出站安全默认收紧**：Webhook 仅允许 `https://` 且目标解析地址不得为私网/回环/
  链路本地/保留段（含 `169.254.169.254` 云元数据），禁重定向，禁止覆盖
  `Host`/`Content-Length`/`Connection`/`Transfer-Encoding` 等头。内网自托管接收端需显式
  `ALLOW_PRIVATE_WEBHOOK=1`（明文 http 另需 `ALLOW_INSECURE_WEBHOOK=1`）。
- **恢复通知与指标同组**：CPU/内存/磁盘/温度恢复使用对应指标事件（不设独立
  `recovery` 事件），避免 `*` 组对同一次恢复重复投递。
- **测试告警语义**：`POST /api/test-alert` 经通知组路由，任一启用通道（邮件 / Telegram /
  Webhook）即可；全部通道失败返回 `502`（此前恒 `200`）。
- **AI 日报通道判定**：`notifyStatus()` 现同时统计启用 Webhook；仅有 Webhook 时日报也会发送。

### 说明

- 内置 mail/telegram 渠道的凭据仍存 `notify_config`（单一事实源），渠道行只承载启用开关；
  管理端渠道表对内置渠道仅开放启用/禁用与测试。
- 同一 `(agent, event)` 的告警→恢复串行投递并保证顺序，链完成即清理（内存有界）。
- 单通道失败隔离：一个渠道 5xx/超时不影响同组其它渠道；全失败才回滚告警态。
- 新增 env：`NOTIFY_CONCURRENCY`（默认 8）、`ALLOW_PRIVATE_WEBHOOK`、
  `ALLOW_INSECURE_WEBHOOK`。
- 实施计划见 `dev-docs/IMPLEMENTATION_PLAN_2026-10-19.md` F2。

## 2026-10-19 告警规则精细化：节点/分组覆盖 + 采样窗口 + 上线通知（S1-F1）

### ⚠️ 行为变更

- **告警判定从「连续 N 次全超限」改为「窗口内 ≥70% 超限」**：默认 5 个采样窗口、触发/恢复
  比例 0.7（env `ALERT_WINDOW_SAMPLES` / `ALERT_TRIGGER_RATIO`）。单次尖刺不再告警，持续超阈
  触发最多比旧行为晚 2 个采样。**要恢复旧的「连续 2 次」行为，显式设置 `ALERT_SUSTAIN_SAMPLES=2`**
  （内部转为窗口=2、比例=1.0）。
- **缺数据语义显式化**：`null` 样本不参与窗口计算；已知样本不足 2 个时既不触发也不恢复
  （对齐 nezha known=false）。此前 null 会被静默过滤但恢复路径可能误判。
- **新增上线通知**：离线超过 `ONLINE_NOTIFY_GRACE_SEC`（默认 180 秒）后重连发送「已上线」；
  此前恢复只清告警态、不发通知。设 `0` 关闭。
- **告警阈值支持按节点/分组覆盖**：解析链 `节点 > 分组 > 全局`，字段独立继承，留空 = 继承。
  新增管理 API `GET /api/admin/alert-rules`、`PUT/DELETE /api/admin/alert-rules/agent/:id`、
  `PUT/DELETE /api/admin/alert-rules/group/:grp`（分组 `-` 表示未分组默认组）。
  管理端「受控端」列表新增「告警」入口，「设置 → 分组告警覆盖」新增分组面板。
- **`muted` 只压制指标类告警**（cpu/mem/disk/temp）；离线、到期、配额、流量不可信属经营告警，
  永不被静音（防「静音=失联」）。
- `/api/agents` 响应新增 `alert.effective/overridden/muted`；**在线状态判定同步改用节点生效的
  `offline_sec`**，修复「看板显示在线、告警判离线」的双源分裂。

### 说明

- 新表 `alert_overrides` / `alert_group_overrides` 刻意不声明外键：本库未启用
  `PRAGMA foreign_keys`，级联不会执行；删除受控端时由 `db.deleteAgent` 同事务清理。
- 覆盖值按与全局阈值一致的范围钳制（越界/非数字视为未设置）。
- 审计：覆盖写/清操作记录 `alert_rule_update` / `alert_rule_reset`。
- 实施计划见 `dev-docs/IMPLEMENTATION_PLAN_2026-10-19.md` F1。

## 2026-10-19 流量周期口径：month_rotate / net_rx / net_tx（P1–P4 安装链路）

### ⚠️ 行为变更

- **Go 受控端新增上报绝对网络计数器** `net_rx/net_tx`（接口累计字节）与 `month_rotate`
  （环境变量 `MONTH_ROTATE`，兼容别名 `AGENT_MONTH_ROTATE`）。服务端新增 `traffic_state`
  小表做周期累加，并按
  `agents.month_rotate` / agent 上报值决定口径：`0`=自网卡建立累计，`1–31`=每月重置日
  （短月顺延规则对齐 Komari），未上报计数器的 Python/legacy 节点继续透传其本地自然月累计。
- 管理端 Agent 详情新增「流量重置日」：仅对已有 `has_counter=true` 的 Go 节点显示；留空表示
  采纳受控端上报值，显式 `0` 表示累计口径，保存后下一条上报生效。
- **配额单位统一为 GiB**：`alerts` / 前端 / AI 原本按 GiB，`compat` 与 `v1` 的
  `traffic_limit` 由十进制 GB 改为 `monthly_quota_gb * 1024³`；使用社区主题按字节展示配额的
  界面数值会相应变大（约 7.37%），属修正而非超量。
- 一键安装/更新链路新增 `--month-rotate` / `-MonthRotate` / `-e MONTH_ROTATE`：
  `diting.sh`、`agent-go/install.sh`、`api.js` 生成的 native/Docker/Windows 命令、
  `install-go.ps1` 的 `run_scheduled.bat` 均已贯通；`diting.sh --update-agent` 会保留
  `/etc/diting/agent.env` 里的 `MONTH_ROTATE`。

### 说明

- 服务端月流量字段仍是 `metrics.net_rx_month/net_tx_month`，但 Go 节点的值已由服务端累加器
  回写；升级切档日历史曲线可能出现台阶（legacy Python 节点不变）。
- **Go agent 本地 `state.json` 月累计已删除（P4 cleanup）**：`agent-go/state` 包移除，
  `STATE_FILE` 环境变量与 `diting-state` Docker 卷不再使用（存量环境变量/卷被忽略，无影响）。
  周期口径完全由服务端 `traffic_state` 按 `month_rotate` 决定（见
  `dev-docs/TRAFFIC_PLAN_2026-10-13.md` P4）。
- 整数口径按 JS 安全整数收敛：超过 `Number.MAX_SAFE_INTEGER` 的计数器字段按 legacy 透传处理，
  不承诺 uint64 满量程。

## 2026-10-18 Token 强度判定收敛：弱 ADMIN_TOKEN 全入口失效 + READONLY_TOKEN 告警

### ⚠️ 行为变更

- **弱 `ADMIN_TOKEN` 现在在所有入口都失效**：示例占位符 `change-me-admin-token` 与短于 16 位的值，
  统一由新增的 `server/src/token-policy.js` 判定为「未设置」。此前管理接口已拒绝，但
  `GET /metrics` 直接比对原始 `process.env.ADMIN_TOKEN`，弱值仍可拉取指标；现两者一致返回 `401`。
  若线上确在使用 <16 位 Token，升级后 `/metrics` 需改用强值：
  `sudo bash diting.sh --reset-admin-token`（生成 `adm_` + 48 位 hex，并重启服务）。
- **启动日志分档**：不再把「占位符 / 过短」误报成「未设置」，明确提示已被忽略、将走 Web
  初始化向导，并给出 `openssl rand -hex 32`。日志只打印长度，不打印 Token 内容。

### 改进

- `READONLY_TOKEN` 增加启动期强度告警（占位符 / <16 位），仍保持「生效但不阻断」，
  避免存量部署升级后突然失去只读访问；该 Token 可读全部节点指标、备份列表与客户端 IP
  诊断，弱值应尽快轮换。
- Token 判定由 `server.js` / `auth.js` / `api.js` 三份副本收敛为 `src/token-policy.js`；
  新增 `test/token-policy.test.js`（判定四态、阈值、断言复用同一函数引用）与
  `test/metrics-token.test.js`（`/metrics` 拒绝弱值与占位符）。

## 2026-10-16 Windows 受控端安装器：最小权限运行（LocalService）+ 状态文件路径修正

### ⚠️ 行为变更

- **Go Windows 安装器的计划任务运行账户由 `SYSTEM` 改为 `LocalService`（最小权限）**。
  原因：以完整 SYSTEM 常驻违背「提权只用于安装、agent 只在自身权限内运行」的原则。
  做法对齐 Linux 版（安装期以 root 建目录/授权 → 运行时以非 root `diting` 跑）：
  安装期由管理员 `icacls` 显式授予 LocalService 对 `%ProgramData%\diting-agent` 的
  Modify 权限（`(OI)(CI)(M)`），并加入系统内置「Performance Monitor Users」组，
  以保证 PDH 计数器（`\PhysicalDisk`、`\System\Processes`、`\Thermal Zone Information`）可读。
  **不新建专用本地账户**：专用账户需口令管理、「作为批处理作业登录」权、卸载残留清理，
  反而增加用户排障成本（对照：Komari 的 Windows 受控端直接以 SYSTEM 运行，无专用账户先例）。
- **修复状态文件路径**：安装器此前未设 `STATE_FILE`，Go 端默认 `/data/state.json`
  在 Windows 被解析为 `C:\data\state.json`（不在授权目录内、非管理员亦无权写入）。
  现显式设 `STATE_FILE=%ProgramData%\diting-agent\state.json`，与 Python 版同路径、可复用。
  **升级既有 Go Windows 节点会有一次月流量归零**（状态文件路径迁移，属预期一次性）。
- **新增隐藏启动器 `run_hidden.vbs`**：解决"手动启动弹窗、关窗即停"。计划任务已在
  session 0 运行（无窗口）；但直接双击 `run_scheduled.bat` 会留下 cmd 窗口，关窗即杀
  agent。现安装器额外生成 `run_hidden.vbs`（`WScript.Shell.Run "cmd /c …", 0` 隐藏窗口），
  手动启动请用它或 `Start-ScheduledTask`，**勿直接双击 bat**。

> 待 Windows 真机验证：任务以 LocalService 注册并启动成功、agent 能写 state.json、
> 磁盘IO/进程数/温度三个 PDH 字段有值、OS 名称正常。

## 2026-10-12 移除从未可用的「GZIP 上报」选项

- Go 受控端 `GZIP` 环境变量（请求体压缩）**移除**：服务端从未提供解压中间件，
  开启即被 400 拒收——属从未可用过的死选项；正常上报体仅 ~1KB，压缩收益本就有限。
  **存量部署若设过 `GZIP=1`：该变量现被忽略、上报恢复正常，无需任何操作。**
- 文档同步：README 中英 / `docs/env.md` / `docs/agent.md`。
- 响应方向压缩由反代负责（与 TLS/限流同级，不做应用层开关）；正确开法见
  `nginx/monitor.conf.example`（实测 10s 轮询总传输降 80%）。

## 2026-10-12 Windows 受控端：磁盘 IO 恢复 + 新增进程数/温度采集（红线修订）

### ⚠️ 行为变更

- **Windows Go 受控端的 `disk_r_rate` / `disk_w_rate` 由恒 0 恢复为真实值**：
  `pdh.dll` 直调英文性能计数器 `\PhysicalDisk(_Total)\Disk Read|Write Bytes/sec`
  （零外部依赖，与既有 `syscall.NewLazyDLL` 模式一致；普通用户可读；失败回退 0）。
  背景：M2 曾把磁盘 IO 列为「不抄 PDH」而砍掉，但 Python 版经 `psutil.disk_io_counters`
  一直有真值（并行对比期 7 万+ 条记录）——属**功能回归**而非采集面扩张，本次修订恢复。
  前端 IO 胶囊与趋势图自动生效，无需改动。
- **新增进程总数采集（全平台）**：Windows 用 PDH `\System\Processes`、Linux 数 `/proc`
  数字目录。**仅"数量"一个整数，不含任何进程明细**（无进程名/命令行/PID 列表/连接，
  满足零指纹红线——指纹指个体级信息，聚合计数不属此列）。服务端 `metrics` 新增
  `process_count` 列，Komari 兼容层恢复 `process.count → process_count` **真值**映射
  （此前因 CPU 冒充被断开，现为真采集）——社区主题进程数图自动恢复。
  0 = 未采集（老 agent / 老数据）。
- **Windows 温度改走 PDH 热区计数器（尽力而为）**：`\Thermal Zone Information(*)\Temperature`
  （Win10 1803+ 且有 ACPI 热区的机器才存在；多热区取最高）。**有值就报、无热区/无数据
  保持 nil，绝不造假**。此前"温度需 WMI（不引）"的结论修正为：WMI 仍不引（依赖重），
  但 PDH 路线零依赖可行；Python 版 Windows 从未上报温度，无回归语义。
- **管理端显示链路修复**（采集之外的第二处坑）：Windows 卡片"进程"胶囊此前
  取值仍是恒定 0 的 `load1`（"进程数当负载"时代的僵尸设计），现改取 `process_count`
  真值（含迷你图曲线）；简单卡片、列表行 hover、**节点详情页 "Load 1m" 图**（Windows
  改画进程数曲线）、标准 v1 API（`process` 字段 + `capability.process`）同步。
  三处数据通路修复：`/api/public/agents` 顶层字段、public sparklines 响应白名单、
  sparklines SQL 列集。

### 说明

- 红线口径澄清：**零指纹 = 不采个体级信息**（进程名/命令行/连接明细/GPU 型号）；
  聚合计数（进程总数）与硬件遥测（温度/磁盘 IO）不属指纹面。
- 服务端另修：`LOAD_COLS` 列集补 `process_count`（兼容层普通指标查询走该列集，
  否则映射恢复后仍查不到值）；`insertMetric` 对老调用方缺列做默认值 0 兜底。

## 2026-09-16 M3：安装链路切换 Go 受控端（含行为变更）

### ⚠️ 行为变更（升级后可见）

1. **`diting.sh --install-agent` / `--update-agent` 现在安装 Go 版受控端**（单二进制
   `/opt/diting/diting-agent`，从 GitHub Release 下载并强制 SHA256 校验），不再安装
   Python 三件套。存量 Python 节点执行 `--update-agent` 会迁移到 Go 版
   （agent.env 身份与月流量 state 保留）。
2. **Windows 一键命令切换为 `agent-go/install-go.ps1`**：计划任务形态升级——
   AtStartup（开机即启，无需登录）、LocalService 最小权限运行（2026-10-16 起修正，原为 SYSTEM）、自动重启 10×1min、
   **单实例互斥**（MultipleInstances=IgnoreNew + bat 内 tasklist 守卫），
   修复 Python 版「重复安装叠加实例 / 连崩躺平 / 重启需登录」三缺口。
3. **Docker 形态切换为 Go scratch 镜像**（~7.5MB，多阶段构建；`USER 1000` +
   `cap_drop ALL` + `no-new-privileges`，纯 TCP 探测无需 NET_RAW，权限面比 Python
   版更小）。`/:/host:ro` + `DISK_PATH=/host` + `--network host` 约定继承，多盘识别
   已在 J4125 实测一致（3 盘）。ghcr 镜像随 `agent-go-v*` tag 发布；
   `diting-state` 卷通用（state.json 格式两端一致）。

### 分发基建

- `.github/workflows/agent-go-release.yml`：推送 `agent-go-v*` 标签触发三平台
  （linux amd64/arm64 + windows amd64）构建，先 `go test` 后出包，附 SHA256，
  自动附加到 GitHub Release。安装器默认拉 `releases/latest/download`，
  `--repo` 可钉指定 tag 的 release 地址。
- `agent-go/` 新增 `install.sh`（Linux systemd 安装器）、`uninstall.sh`、
  `diting-agent.service`（只读系统加固）、`install-go.ps1`（Windows 安装器）。

## 2026-09-14 受控端探测后台化 + 探测标签两字母化（含行为变更）

### ⚠️ 行为变更（升级后可见）

1. **探测标签默认值改为两字母缩写**：`CM`=移动门户（`www.10086.cn:443`）/ `CT`=电信 DNS /
   `CU`=联通 DNS / `GG`=谷歌公共 DNS（此前为中文「移动/电信/联通/公共」）。原因：
   ① 状态卡片宽度有限，中文标签溢出；② 中文经 Windows 安装链 ascii 编码会吞成 `?`；
   ③ 运营商 DNS（含移动全系 6 个候选 IP）对 TCP 53/443/80 全拒（J4125 电信出口与
   Windows 实机双测一致），CM 无法用移动 DNS 的 TCP 表达，改用移动自家门户测
   "移动入口可达性"。**已入库的历史数据保留旧标签键**，新数据从新键起画
   （时间序列在标签变更点自然分段）。
2. **Go 受控端探测改为后台缓存架构**：探测以独立 60s 节奏在后台 goroutine 并发刷新，
   上报主循环只取最近一轮快照（对齐 Linux Python 版 `_probes_cache` 设计）。不可达目标
   （如对 TCP 443/80/53 全拒的运营商 DNS）只体现为该目标 `loss=100` 离线，
   **不再把每轮上报拖慢最多 22.5s**；首个探测周期内上报暂不带 `probes` 字段。
3. **单目标探测新增 5s 总预算**：拨号重试累计超预算立即放弃（旧口径最坏
   3轮×3端口×2.5s=22.5s）。

### 改动文件

- `agent-go/`：`collector/probe.go`（`ProbeRunner` + budget `probeOne`，删同步 `ProbeAll`）、
  `main.go`（接线）、`config/config.go`（默认标签）、新增 `collector/probe_test.go`（4 组单测）。
- `agent/`：`agent.py`、`windows/windows_agent.py`、`windows/run.bat`、`Dockerfile`、
  `docker-compose.yml` 默认标签同步。
- `server/src/db.js`：新装实例 `ui_settings.probe_targets` 默认值同步。
- 文档：`README_EN.md`、`docs/src/content/docs/env.md`、`agent/windows/README.md`。

## 2026-09-13 安全体检整改（10 个 PR，含行为变更）

> 来源：`dev-docs/AUDIT_REMEDIATION_PLAN_2026-09-13.md`（独立安全/代码审计 F1–F8 之后的
> 又一轮体检）。共 10 个 PR，后端测试 113 → 162。以下按「用户能否感知」排序。

### ⚠️ 行为变更（升级后可见）

1. **Windows 受控端负载不再显示数值**：`load1` 此前用**进程数**近似上报（进程列表属指纹
   字段，是审计认定的红线污染），现恒为 `0.0`。Windows 节点的「负载」列将显示 0。
   Linux 端不受影响（读 `/proc/loadavg`）。
2. **审计日志现在会被自动清理**：此前 `pruneAudit` 实现完整但**从未被调用**，
   `audit_logs` 无限增长。现随每小时 prune 清理，默认保留 **90 天**
   （新增环境变量 `AUDIT_RETENTION_DAYS`，下限 7）。**升级后首次 prune 会删掉
   90 天前的历史审计记录**——如需留档请在升级前导出。
3. **`GET /api/agents/:id/metrics` 返回行数大幅减少**：改走 SQL 层均匀采样
   （30d 实测 135,500 行 → 362 行，1.4MB → 352KB）。响应**字段结构不变**，
   但点数变少；新增 `X-Sampled: 1` 响应头，可用 `?points=` 覆盖（60–1440）。
   注意仍为全列（含 `probes`/`disks`），要再压体积需改显式列（后续优化）。
4. **社区主题（Komari 兼容）：Swap 图变为正确值**：`swap.used/total` 此前**错映射到
   内存列**，Swap 图一直在显示内存值；现改为真实 `swap_used/swap_total`。
5. **社区主题：5 个指标不再出图**：`process.count`、`connections.tcp`、
   `connections.udp`、`gpu.usage`、`gpu.device.usage` 此前都映射到 CPU 列
   （用 CPU 值冒充），现断开映射 → 这些图不再渲染。**宁可缺图，不可错值。**
6. **TOTP 一次性化**：同一 6 位码在一个时间步内只能成功一次（原可重放约 90 秒）。
   另外同一 IP 10 分钟内 5 次 TOTP 失败后进入锁定（返回 `429`）。
7. **Go 受控端新增 `loss` 字段**：纯 TCP 探测无 ICMP 丢包统计，故只给二值
   （成功 0 / 三轮全失败 100），不伪造中间值。Python 版仍为真实丢包率。
8. **`/api/agents/:id/renew` 日期计算修正**：此前用 `toISOString()`（UTC）格式化，
   在 UTC+8 下**每次续费提前 1 天且逐次累积**（实测 30 天周期变成 30/29/29 天）。
   现走本地日历日，严格 +N 天。
9. **`--install-agent` 会先校验 SERVER_URL**：`--setup-token` 配 `http://` 非本地地址时，
   现在会在**凭据外发之前**报错退出（此前会先把一次性注册凭据 POST 到明文地址）。
10. **`--install-server` 生成 `/etc/diting/host.env` 骨架**：避免
    `BACKUP_VISIBLE_DIR` 未配导致后台「恢复」静默失效（已存在则**不覆盖**）。
11. **Nginx 示例新增 WebSocket/SSE 支持**：`/api/clients`、`/api/clients/sse`、
    `/api/rpc2` 现在有正确的升级头与 3600s 长连接超时（此前用默认 60s，
    长连接每分钟被切断）。**已在生产用自定义 nginx 配置的实例需手动同步。**

### 安全与加固

- **审计粒度**：`update_agent` / `update_settings` / `update_ai_config` 的审计
  从「静态标签」升级为**记录变更字段名**（敏感键打码为 `k=*`，不记值）。
- **systemd 能力**：`diting-agent.service` 新增 `AmbientCapabilities=CAP_NET_RAW`
  + `CapabilityBoundingSet=CAP_NET_RAW`（`NoNewPrivileges=true` 下文件 capabilities
  会被忽略，此前 ping 探测可能静默退化）。
- **指纹收敛**：Linux `os_name` 兜底不再拼 `platform.release()`（内核版本属指纹）。
- **发布可复现**：`diting.sh` 新增 `REPO_BRANCH`（可钉 tag）；
  `--update-script` 下载后打印本次文件 SHA256，便于留档与强校验。

### 性能

- **`/api/agents/:id/metrics`**：30d 单节点 135,500 行 → 362 行。
- **公开快照共享缓存**：`/api/clients`（WS）、`/api/clients/sse`（SSE）、
  `/api/rpc2`（WS）此前**每个连接**各自每 5s 全量构造并序列化一次快照，
  现改为全局每 5s 只构造一次、所有连接复用。实测 5 连接 30s 的 CPU 增量
  由 46 ticks 降至 11 ticks（约 -76%）。

### 兼容层修复

- `/api/clients` 的 ping/探针数据改为**按实体独立采样**（此前跨节点取全局配额）；
  `entity_ids` 上限 50、`metric_keys` 上限 32（防单请求触发 N 次 SQL）。

## 2026-09-07 安全与健壮性修复（含 Breaking 变更）

### ⚠️ Breaking：安装命令类接口要求显式配置服务器地址
- 涉及端点：`GET /api/agents/:id/commands`、`POST /api/agents`、`POST /api/agents/:id/reset-token`。
- 变更：不再从 `X-Forwarded-Host` / `Host` 请求头推导服务器地址。未显式配置时直接返回 `400 {"error":"server_url_not_configured"}`，且**在写入之前中止**（不会创建 agent、不会轮换 Token）。
- 影响与处理：升级后若后台出现该错误，到「设置 → Agent 连接地址」填写即可；也可填「项目网址」或设置环境变量 `PUBLIC_URL`。此前依赖 Host 头自动推导、又从未配置过上述三项的实例会受影响。
- 动机：一键安装命令内嵌 `AGENT_TOKEN`，若地址可控则会把 Token 暴露给任意被诱导访问的地址（纵深防御）。三个端点均为 `adminOnly`，属主动加固而非已利用漏洞。

### 其他修复
- **稳定性**：新增统一错误中间件与 `asyncHandler`（`src/util.js`），async 路由抛错不再导致进程崩溃——此前 Node ≥15 会因未捕获的 rejection 直接退出进程，是现存的全站 DoS 触发点。非法 JSON 现在返回 `400 application/json`，而不是默认处理器的 HTML 页。
- **前端**：请求失败时透传服务端 `error` / `message`（此前只显示 `400 Bad Request`），并新增机器可读错误码到本地化文案的映射（`web/src/utils/apiError.ts`）。
- **性能/健壮性**：`metrics` 采样 SQL 的 `step` 改用绑定参数；告警检查并行化（可配 `ALERT_CONCURRENCY`，默认 8）并加重入保护。
- **CI**：开始运行前端 vitest 与 `vue-tsc` 类型检查；后端纳入此前从未执行的 `src/ai/schedule.test.js`。

## 计费系统 + AI 日报到期 + 告警规则 + Phase 4 前端增强（2026-08-03）
> 本期为一组功能增强，覆盖服务端计费/到期/告警与前端交互。所有改动已端到端验证（见各条「验证」）。

### A. 计费系统（Phase 1 及周期扩展 / 白嫖修复）
- `server/src/db.js`：`agents` 表新增 `price` / `billing_cycle` / `currency` / `auto_renewal` 四列；`createAgent` / `updateAgent` 透传这四列。billing_cycle 落地逻辑修复——原 `|| 30` 会把白嫖（0）吞成 30，改为「undefined/null/''/NaN 才回退 30」，**保留 0**。
- `server/src/api.js`：
  - 新增 `GET /api/billing`：返回 `monthly_total`（月费，price×30/cycle 累加）、`currency`、`agent_count`、`per_group`（分组月费）、`expiring_soon`（7 天内到期列表，用 `util.daysUntil` 计算）。
  - 新增 `POST /api/agents/:id/renew`：在当前到期日（或今天）基础上顺延一个计费周期。修复 `billing_cycle=0` 被 `|| 30` 误推进 30 天的 bug——现显式保留 0，白嫖续费不改变到期日（仅刷新为今天标识已确认）。
  - 创建/更新接口透传 `price` / `billing_cycle` / `currency` / `auto_renewal`，并做白名单与范围校验（`billing_cycle ∈ [0,30,60,90,180,365,730,1095]`、`price ∈ [0,99999]`、`currency ∈ [¥,$ €,£]`）。
- `server/src/util.js`（新增）：导出 `daysUntil(dateStr)`（距今天数，null=未设/无效，负=已过期）与 `cycleLabel(days)`（30月/90季/180半年/365年/730两年/1095三年/0白嫖）。
- 周期选项扩展：在年付(365)后新增 **两年(730) / 三年(1095) / 白嫖(0)**，前端 `admin.html` 的 `c_cycle` / `e_cycle` select 同步加三项；`util.cycleLabel` 加对应映射。
- 前端 `admin.js` / `admin.html`：概览页新增「📊 费用概览」区块（月费总额 + 分组费用 + 7 天内到期提醒）；卡片价格 badge 加白嫖专属「白嫖」标签；创建/编辑表单回填 `billing_cycle`（含 0）、提交 `value==='' ? 30 : Number(value)` 保留 0。
- **验证**：`/api/billing` 正常返回（5 节点、月费 0.82、分组费用、无临期）；创建白嫖节点后回读 `billing_cycle:0 / price:0 / auto_renewal:0` 落库正确；白嫖续费不再被推进到 30 天后（返回今天附近日期）。

### B. AI 日报：计费/到期信息（Phase 2）
- `server/src/ai/summarizer.js`：`summarizeAgent` 输出新增 `billing` 字段（`price` / `currency` / `billing_cycle` / `cycle_label` / `auto_renewal` / `expire_at` / `days_until_expire`）。
- `server/src/ai/report.js`：新增双语 i18n（中/en）`expire_upcoming` / `expire_overdue` / `expire_free` / `expire_no_date`；新增 `renderExpireSection()` 渲染单节点到期行（白嫖不显示到期；无日期显示「未设到期日」）；统计文本节点循环追加到期行；flagged 过滤加入临期（≤7 天）判断。
- `server/src/ai/prompt.js`：`PROMPT_VERSION` 升 `1.1`；SYSTEM_PROMPT 新增第 5 条引导（关注到期：≤7 天临期、<0 已过期、白嫖节点标注可用性）。

### C. 告警规则（Phase 3）
- `server/src/alerts.js`：新增 `checkExpiringAgents(now)`（白嫖跳过，≤7 天触发到期提醒，24h 冷却，远离到期清除状态）与 `checkTrafficQuota(now)`（月流量超 `monthly_quota_gb` 触发，24h 冷却）；`start()` 新增 `dailyTimer` 每 6 小时跑一次、启动即跑一次；导出两函数。
- **验证**：服务端重启日志显示 `[alerts] checker started`，无加载错误，证明 `util.daysUntil` 与两新函数已正确加载。

### D. 前端 Phase 4 交互增强
- `server/public/admin.js` / `admin.html` / `style.css`：
  - **全局搜索**：toolbar 加搜索框，按名称/分组/商家/备注/国家/ID 过滤（`filterAgents`），grid/client 渲染均应用。
  - **批量操作**：卡片加复选框 + `selectedIds` 集合；选中后显示批量条（批量续费 / 批量删除 / 取消）；`renderBatchBar` 在未选中时 `hidden`。
  - **紧凑模式**：`compactMode` 存 `localStorage('compactMode')`，toolbar 加切换按钮，`body.compact` 收紧卡片间距。
  - **图表记忆**：`detailRange` 从 `localStorage('detailRange')` 读取并回填，切换时写回。
- 前端缓存破译：`admin.js` 引用升 `?v=47`、`style.css` 引用随每次样式改动递增（本次到 `?v=49`），配合 server.js no-store 中间件防浏览器缓存旧资源。

### E. 前端批量条 UI 修复（本期对话内）
- 现象：搜索框下方出现一条「大长条」且选中后过长、左缘未与卡片对齐。
- 根因与修复（`style.css`）：
  1. 空长条常显：`.batch-bar` 设 `display:flex` 覆盖了 `hidden` 属性的默认 `display:none` → 加 `.batch-bar[hidden]{display:none!important}`。
  2. 选中后过长：改为 `inline-flex` + `width:fit-content` + `flex-wrap:wrap` + 更小内边距（7px 12px），贴左按内容收缩，不再横贯整行。
  3. 左缘未对齐：`.grid` 有 `padding:14px 26px 0`，批量条是 grid 兄弟节点无此缩进 → 加 `margin:0 0 12px 26px` 与 `max-width:calc(100% - 26px)` 对齐卡片左缘。
- `admin.html` 的 CSS 版本号同步递增至 `?v=49` 触发重新拉取。

## 第三方主题皮肤支持 + 安全审查文档（2026-08-03，独立工作，与本期 A–E 无关）
- `server/server.js`：首页 `/` 若命中 `public/themes/<id>/index.html`，用一次性随机 `nonce` 注入主题内联 `<script>` 并**仅对该响应**放宽 CSP（允许内联脚本 + Iconify/IP 地理定位等外部源）；`admin.html`/API 等其他路由仍走全局严格 CSP，不受影响；响应加 `no-store` 防止 nonce 复用。
- `server/public/themes/`：新增多套皮肤（demo / komari-demo / neobrutalism / glassmorphism 等）及 `README.md`。
- `docs/CODE_REVIEW_2026-07-31.md`：全组件代码审查报告（v2，修正 5 处误判）。
- 说明：上述三项属「主题皮肤 + 审查文档」独立任务，未纳入本期 A–E 的功能验证范围；如随本期一并提交，建议分开 commit 或在 PR 描述中标注。

## 受控端多盘识别兼容增强：支持仅挂 /host 的部署（2026-07-24）
- 在「修复 Docker 形态多盘识别」基础上，将 `disk_list` 的 `mounts_path` 选择逻辑改为：Docker 形态始终读取**容器 mount 命名空间视图**（优先 `/hostproc/mounts`，否则回退容器自身 `/proc/mounts`），二者宿主真实盘均以 `/host` 前缀出现；**不再回退到 `/host/proc/mounts`**（那是宿主视图，宿主盘无 `/host` 前缀，会被前缀过滤全部跳过、读不到任何盘）。从而使 README 中仅挂 `-v /:/host:ro`（不挂 `/hostproc`）的示例也能正确识别多块硬盘。
- 配套：`Dockerfile` 将 `apt` 安装 ping 前置为独立层，agent 代码改动不再使 apt 缓存失效（离线/弱网可复用缓存）；`README.md` 受控端 Docker 部署段落补充多盘识别原理与可选 `-v /proc:/hostproc:ro`。

## 修复受控端 Docker 形态下多盘识别错误（2026-07-24）
- 现象：Docker 部署的受控端在 dashboard 看不到宿主真实磁盘（根盘与第二块数据盘缺失），且 docker 状态卷被误报为一块盘。
- 根因：`/hostproc/mounts` 实际是容器 mount 命名空间视图，宿主真实盘在里面临时带 `/host` 前缀（如 `/host`、`/host/data`）；`disk_list` 又盲拼一次 `/host` 前缀变成 `/host/host/...`，导致 `isdir` 全 False、宿主盘全部被跳过，而容器内 docker 卷 `/data`（无前缀）反而被当成真实盘误报。
- 修复（`agent/collector.py` `disk_list`）：Docker 形态下仅保留带 `/host` 前缀的挂载条目（宿主真实盘），统计用 mount 本身（bind 可达），展示时去掉 `/host` 前缀还原为宿主路径（如 `/`、`/data`）；容器自身挂载（docker 卷、`/etc/hosts` 等伪盘）被排除。
- 验证：`disk_list('/host')` 正确返回宿主 `/`(根盘)、`/data`(第二块盘)、`/boot/efi`；服务端收到的 `disks` 字段一致。

## 初始化向导 UX 修复：adm_ Token 被 .env 静默覆盖陷阱（2026-07-24）
- 现象：用户在「首次设置」向导生成了 `adm_xxx` 管理员 Token，之后 `install.sh` 把 `ADMIN_TOKEN` 写进 `.env` 并重启，`.env` 的 token 通过 `getAdminToken()` 的 env 优先逻辑覆盖了 DB 里的 `adm_xxx`，导致用户保存的 `adm_xxx` 永远登不进后台；更严重的是用户把 `adm_xxx`（管理员 Token）误当受控端 Token 配进受控端，导致 Agent 连接失败。
- 修复 1（服务端 `api.js` `/setup/generate`）：当 `.env` 已配置有效 `ADMIN_TOKEN`（与 `getAdminToken()` 的 env 分支判定逐字一致）时，**拒绝生成**会被静默覆盖的 `adm_` token，返回 `400 {error, envConfigured:true}` 并提示改用 `.env` 的 token。彻底堵住「先向导后补 `.env`」的时序陷阱；首次部署（无 `.env`）流程不受影响。
- 修复 2（前端 `admin.html` 向导页）：新增醒目提示，明确「这是**管理员后台登录** Token，**不能用于受控端**；受控端用『客户端』列表生成的客户端 Token（无 `adm_` 前缀）」，从源头消除概念混淆。
- 配套操作：受控端 `j4125-self` 经 `/api/agents/:id/reset-token` 重置新客户端 Token（无前缀纯 hex），旧 Token 立即失效，配回受控端即可恢复连接（需保证 `SERVER_URL` 为 https）。

## 数据保留天数后台配置（未版本化，开发中）
- 后台「设置 → 告警规则」新增「指标保留天数」输入框（范围 7-3650 天，默认 30 天）
- 服务端 prune 逻辑改为从数据库动态读取保留天数（`db.getRetentionDays()`），设置变更后 1 小时内自动生效，无需重启
- 三级优先级：后台显式设置 > 环境变量 `RETENTION_DAYS` > 硬编码默认 30 天
- 边界保护：小于 7 天钳制为 7，大于 3650 天钳制为 3650（10 年），无效值自动回退到下一级
- 旧行为兼容：之前仅通过环境变量 `RETENTION_DAYS`（默认 30）控制，现仍可作为初始默认值生效

## install.sh 数据库管理子命令（未版本化，开发中）
- `install.sh` 新增数据库备份/恢复/统计管理子命令，集成到统一安装管理脚本：
  - `--backup [路径]`：热备份数据库，默认存到 `/var/backups/diting/monitor_时间戳.db`。优先通过 `sqlite3 .backup` 命令热备份（不中断服务），无 sqlite3 时回退到 `docker cp` / `cp`
  - `--restore <路径>`：从备份恢复数据库。恢复前自动备份当前状态（`pre_restore_*.db`，可回滚），自动校验备份文件完整性（SQLite 魔数 + `PRAGMA integrity_check`），需输入 `yes` 确认
  - `--backup-list`：列出 `/var/backups/diting/` 下已有备份
  - `--db-stats`：查看数据库统计（文件大小、各表记录数、指标时间范围、占用明细）
- 智能定位数据库：自动检测 Docker 命名卷 `server-data`（容器内拷贝 / 临时容器挂载卷）或宿主机文件路径
- 交互菜单新增 `8) 数据库管理（备份/恢复/统计）` 子菜单
- 适用场景：整机迁移、Docker 卷误删恢复、定时自动备份（cron）、数据库容量监控

## install.sh v1.1.1（2026-07-10）
- 修复「更新服务端」仍报 8081 占用：根因是**运行中的 install.sh 是旧实例**（先 `git pull` 新源码但内存逻辑仍是旧的，旧逻辑缺 `docker compose down`）。
- 新增：源码同步完成后 `exec` 磁盘上的最新 `install.sh --update-server`，确保后续停旧容器/重建一定用最新代码（防「拉新跑旧」）。用 `SP_REEXECED` 环境变量防自循环。
- 端口兜底：`docker compose down --remove-orphans` 后，若 8081 仍被任意容器占用（孤儿容器/其它 compose 项目），`docker ps --filter publish=8081` 定位并 `docker rm -f` 强制释放。
- 版本号升至 `1.1.1`。

## install.sh 版本化 + 更新检查 v1.1.0（2026-07-10）
- 脚本引入语义化版本号：头部新增 `SCRIPT_VERSION` / `SCRIPT_DATE` / `SCRIPT_NOTES`（本版要点）。
- 菜单横幅显示 `vX.Y.Z (日期) + 本版要点`；进菜单时静默拉取远端版本（3s 超时、失败即跳过），有新版黄字提示「▲ 发现新版，建议选 4) 更新安装脚本」，否则绿字「✓ 已是最新」。
- 「4) 更新安装脚本」覆盖前显示 `旧版 → 新版` 与新版要点，直观了解改动。
- 「5) 更新服务端」记录 git 旧/新短 commit，并列出本次拉取的提交（`git log --oneline old..new`），更新内容一目了然。
- 修复：更新服务端重建前先 `docker compose down` 释放端口，避免 8081 被旧容器占用导致新容器起不来。
- 维护约定：以后每次改脚本行为，同步 +1 版本号、更新日期与要点。

## 仓库卫生：从公开仓库移除测试 SQLite 库（2026-07-09）
- 现象：公开仓库 `fengzone85/diting` 的历史提交 `b27bc0a`（READONLY_TOKEN）曾把 `server/tmp_auth_test.db`、`server/tmp_http.db` 提交并 push。
- 内容核实：
  - `tmp_http.db` 的 `admin_config` 含 `admin_2fa_secret = REDACTED`（base32）与一条 agent 记录（`token_hash` 前缀 `d0b3789…33af0`，id `agt_7525d0d18e80`，name `t2`）。
  - `tmp_auth_test.db` 仅 schema、无数据行。
  - **经用户确认：上述 2FA 密钥与 agent token 均为测试用假数据，项目未实际部署，无任何真实凭据风险。**
- 处置（作为仓库卫生实践，避免误导外部读者）：
  - 已 `git rm --cached` 两文件、`*.db` 加入 `.gitignore`，并 push（`3825dbe`）→ 远程**当前树**已不再含文件，raw URL 已 404。
  - 历史上第三个 `server/tmp_test.db` 一并纳入清理；已用 git filter-repo + force push 重写全部历史，彻底移除 `tmp_*.db` 文件与明文密钥（2026-07-09 执行）。
  - 本地两文件已删除（含仅存于历史副本的 `tmp_test.db` 已被重写消除）。

## CI：GitHub Actions 自动跑安全单元测试（2026-07-09）
- 新增 `.github/workflows/test.yml`：push / PR 到 `master` 时，在 ubuntu-latest + Node 22 上自动 `npm install` 并运行 `npm test`（核心安全函数单元测试）。`better-sqlite3` 走 ubuntu 预编译二进制，无需手动 build。
- 配合上轮单元测试形成审计闭环：核心安全函数（totp / auth / validate）在每次提交自动回归。

## 单元测试：核心安全函数覆盖（2026-07-09）
- 落实安全审查 v3.1「推荐后续关注 #2：为核心安全函数增加单元测试」。
- 新增 `server/test/security.test.js`（Node 内置 `node:test`，零第三方依赖），覆盖：
  - `totp.js`：RFC 6238 标准向量（8 位 SHA1，t=59/1111111109/…/20000000000）逐条比对；`verifyTOTP` 接受当前码与 ±1 窗口、拒绝越界/非数字、去除空格；`generateSecret` 输出合法 base32。
  - `auth.js`：`safeEqual` 先哈希再比较、不同长度正确判否（验证长度侧信道已消除）；`signSession/verifySession` 往返一致、篡改签名与过期均拒绝。
  - `validate.js`：正常负载、缺失核心字段返回字段为 `null`（拒绝逻辑在 `/report` 路由）、越界/非有限数归 `null`、字符串数字强制、probes 约束（≤8 键 / label≤24 / ms 范围 / ok 强制布尔 / 非对象与数组退回 `{}`）、`os`/`hostname` 超长归空串；`num`/`str` 边界。
- 重构：`api.js` 中内联的 `num`/`str`/`validateReport` 抽离到独立 `server/src/validate.js`（纯函数、无 I/O/DB 依赖），`api.js` 改为引用，便于独立审计与测试；`package.json` 增加 `"test": "node --test test/security.test.js"`。

## 安全加固：Token 比较消除长度侧信道（2026-07-09）
- 落实安全审查 v3.1 的 8.2#4（可选低危）：`auth.js` 的 `safeEqual()` 原实现在两端长度不等时提前 `return false`，会泄露 Token 长度（长度侧信道）。改为先对两端统一做 SHA-256 哈希，再对固定长度摘要做 `timingSafeEqual`，彻底消除长度差异带来的时序泄漏。哈希确定且等长，`timingSafeEqual` 不再可能因长度不同而抛错。

## 遗留项修复：ECharts 实例释放 + SQLite 文件权限收敛（2026-07-09）
- ECharts 实例未释放（审查观察项）：重写 `ensureChart()`，在每次取用时检测缓存实例是否已脱离文档（详情页 DOM 重写 / 切换 agent 场景），脱离则 `dispose()` 旧实例并在当前 DOM 上重建，修复「图表空白 + 实例泄漏」；`drawLine()` 增加 `ensureChart` 返回 `null` 的保护。
- SQLite 明文（审查观察项）：`db.js` 打开数据库后将文件权限 `chmod 0o600`（仅属主可读写），按最小权限原则收敛监控数据的暴露面；挂载文件系统不支持 chmod 时静默忽略。

## 受控端网络质量自测加固：探测目标格式校验（2026-07-09）
- 落实安全审查 v3 的 4.1 建议：在 `parse_probe_targets()`（Linux `collector.py` / Windows `win_collector.py`）增加基础格式校验——`host` 非空且长度 ≤ 253（域名上限）、`port` 落在 [1,65535]、`label` 超限截断到 24（与服务端 `api.js` 校验一致）。防御 operator 误配（空 host / 超长字符串导致 ping 异常）；因 host 来自本地 `PROBE_TARGETS` 配置、非服务端下发，无注入面。其余审查发现（4.2 线程阻塞、4.3 psutil 依赖、4.4 iputils-ping）均判定为信息级/可接受，未改动。

## 受控端网络质量自测（固定公共目标，本地配置，无指令通道）（2026-07-09）
- 受控端（Linux `collector.py` / Windows `win_collector.py`）新增本地网络质量自测：从本机 ping / TCP 探测**写死在本地配置**的固定公共基础设施（默认联通/电信/移动 DNS + 8.8.8.8）。目标是"集中式主动探测"越界功能的安全等价物——探测目标来自 Agent 本地 `PROBE_TARGETS` 环境变量、服务端永不可下发，故**指令通道不复存在**，三大安全支柱（无指令通道 / Agent 零耦合 / 数据最小化）完全不受影响。
- 采集逻辑：`probe_one()` 优先 ICMP（系统 `ping -c 1` / Windows `ping -n 1`），解析 RTT（Linux 取 avg、Windows 取平均）；若 `ping` 不可用或被禁，自动回退到目标端口（默认 53）的 TCP 握手测延迟。各目标用 `ThreadPoolExecutor` 并行探测，单次采集额外耗时约 1–2 秒；`parse_probe_targets()` 解析 `label:host[:port]` 格式。
- 服务端：`metrics` 表启动时自动迁移新增 `probes TEXT` 列（存 JSON，列名/类型硬编码，无注入风险）；`/api/report` 对 `probes` 做受控校验（对象、键≤8、label≤24 字符、ms∈[0,100000] 或 null、ok 布尔）。
- 前端：客户端卡片新增「网络」一行（如 `移动 18ms · 电信 23ms · 联通 ✕`）；详情页新增「网络质量（到探测点延迟 ms）」多系列 ECharts 折线图（动态解析每行的 `probes` 按 label 聚合）；`drawLine` 调色板扩展到 8 色。
- 部署：Linux Agent `Dockerfile` 增加 `iputils-ping` 安装（其 `/bin/ping` 自带 `cap_net_raw`，monitor 非 root 用户亦可执行 ICMP；无 ping 时自动回退 TCP）。
- 文档同步：中英文 README 在「环境变量 / 仪表盘功能 / 主动探测小节 / 网络质量自测专节 / 威胁模型表 / 对比表」处新增并统一表述；原"刻意不实现集中式主动探测"小节补充"本地固定目标自测"这一安全等价物的说明。
- Agent 自述与启动脚本补强：在 `agent/docker-compose.yml`（注释示例）、`agent/windows/run.bat`（默认开启三家 DNS）、`agent/windows/install.ps1`（新增 `-ProbeTargets` 参数并透传进计划任务脚本）与 `agent/windows/README.md`（环境变量表 + 安装示例）补齐 `PROBE_TARGETS` 说明。此前 Windows 启动/计划任务脚本未透传该变量，会导致其在计划任务场景下不生效——本次一并修复。

## 受控端新增温度 / Swap / 开机时长非指纹指标（2026-07-09）
- 受控端（Linux `collector.py` / Windows `win_collector.py`）新增本地采集：温度（Linux 读 `/sys/class/thermal/thermal_zone*/temp` 毫摄氏度转 °C 取最高值；Windows 用 `psutil.sensors_temperatures()`）、Swap 使用量/总量/百分比、开机时长（`uptime` 已含）。三者均为**非指纹**指标（无内核版本/CVE 定向、无公网 IP、无 GPU），不触碰任何安全支柱（无指令通道、Agent 零耦合、数据最小化）。
- 服务端：`metrics` 表在启动时自动迁移新增 `temp` / `swap_used` / `swap_total` / `swap_pct` 四列（兼容已有数据库；列名与类型为硬编码常量，无注入风险）；`/api/report` 校验新增字段，其中 `temp` 允许 `null`（无传感器时）。
- 前端：详情页新增「温度」「Swap 使用率」两张 ECharts 折线图；客户端卡片新增温度与 Swap 读数（含 sparkline，无传感器时温度显示「—」）；`sparkline` 增加非有限值过滤以容错。
- 文档同步：中英文 README 将「数据最小化 / 支柱③ / 诚实标注 / 指纹小节 / 仪表盘功能」处的「6 类/6 项」表述更新为「基础状态（含温度/Swap/开机时长等非指纹指标）」，并明确坚决反对的仍是内核/GPU/公网IP/连接数/进程数等指纹。

## 前端新增「即时流量」实时速率读数（2026-07-09）
- 详情页新增实时上下行速率读数（每 3 秒用轻量 `/api/agents/:id` 轮询刷新，展示于既有「网络速率」折线图上方）。
- 速率数据由受控端在本地基于自身两次采样计算（`collector.py` 的 `net_rx_rate`/`net_tx_rate`），经既有 `/api/report` 上报通道入库，前端仅做轮询展示——不新增指令通道、不采集指纹、不改动 Agent，完全落在已有安全边界内。
- 该增强作为「可安全实现的功能」范例，同步写入两份 README「为什么我们刻意不实现这些功能」收尾说明。

## README 新增「为什么我们刻意不实现这些功能」（2026-07-09）
- 两份 README 在「关于其它 agent 类探针的澄清」之后新增「为什么我们刻意不实现这些功能」小节，以「不做的原因」而非「可复制性」视角，逐条说明四类刻意不实现的功能及其安全理由：① 集中式主动探测（需指令通道 → 破坏无指令通道保障，服务端沦陷则成探测跳板）；② 主机指纹采集（内核/GPU/公网IP/连接数 → 拖库即暴露攻击面）；③ 服务端实时下发采样/策略（指令通道变体）；④ 把 Agent 当跳板探测第三方（前三项推论）。并说明仪表盘/历史图表/分组/告警/多用户+TOTP 等纯服务端能力完整提供，因其只读取已上报的 6 项数据、不依赖下行指令。

## README 新增「关于其它 agent 类探针的澄清」（源码级证据）（2026-07-09）
- 两份 README 在「与 Nezha 信任边界对照」之后新增「关于其它 agent 类探针的澄清（源码级证据）」小节，基于某开源 agent 类探针项目的 `agent/main.go` 真实源码逐条反驳两种常见误判：
  - 误判一「Agent 会被 RCE」：ICMP 路径为 `executeICMPPing` → `resolvePublicIPs`（DNS+黑名单）→ `ips[0].String()` → `exec.Command("ping",...)`，参数恒为 `net.IP.String()` 输出、且 `exec.Command` 走 `execve` 不过 shell，故非 RCE，仅为参数类型受限的命令调用；TCP/HTTP 路径用已校验 `net.IP` 直连 `dialResolvedTCP`，无 DNS rebinding/TOCTOU。
  - 误判二「加任务签名即可修复服务端沦陷」：在「服务端不可信」威胁模型下，服务端即签名私钥持有者，签名只能防传输途中篡改、防不了服务端自身为攻击者；唯一根治是移除指令通道（即本项目做法）。
- 明确界定：这类 agent 类探针在服务端沦陷后是「分布式探测跳板 / 受限受控探测代理」，非 RCE 肉鸡；其探测能力是核心功能、架构内无法消除，只有无指令通道才彻底。

## README 设计理念文档化增强（2026-07-09）
- 两份 README 顶部新增「设计原则（5 条）」短清单（信任隔离优先 / 无指令通道 / Agent 零耦合 / 数据最小化 / 服务端不可信+凭据不裸奔），便于快速阅读。
- 两份 README 威胁模型章节之后新增「与主流监控的信任边界对照（以 Nezha 为例）」表，从受控端入站、通信方向、远程执行、Agent 耦合、采集内容、最坏情况、信任模型 7 个维度横向对比指令通道型监控，说明本项目以「功能减法」换取「安全加法」。

## 威胁模型：信任边界分析（设计理念）文档化（2026-07-09）
- 在 `README.md` 与 `README_EN.md` 新增「威胁模型：信任边界分析（设计理念）」章节，向公众说明项目核心设计原则：**信任隔离比功能丰富更重要**，安全靠「不做什么」实现。
- 三大支柱（均经代码核实）：① 无指令通道（Agent→Server 单向，`/api/report` 仅 POST，响应体只用于日志、无 WebSocket/SSE 下行）；② Agent 之间零耦合（每 Agent 仅知自身 URL+Token，指标按 `agent_id` 分表，无跨 Agent 通信机制）；③ 采集数据不含可利用信息（仅 6 类基础状态，不采内核版本/GPU/公网IP/连接数）。
- 三种攻破场景对照表（服务端被攻破 / 某 Agent 被攻破 / 服务端+某 Agent 同时被攻破），并细化场景 ③：Token 以 SHA-256 哈希存储（非明文），只读拖库拿不到明文 Token，伪造需 DB 写权限。
- 诚实标注两个细微点：`hostname`/`os` 仍入库（轻量标识，非攻击指纹）；Token 哈希将「明文泄露」降级为「需 DB 写权限才能伪造」，非完全免疫。

## Agent 上报通道加固（2026-07-09）
- **受控端客户端强制 HTTPS**：`agent/agent.py` 与 `agent/windows/windows_agent.py` 启动时对 `SERVER_URL` 校验——非 `localhost` 的 `http://` 直接 `exit(1)` 拒绝，避免 Token 明文外发（服务端 `X-Forwarded-Proto` 白名单之外的纵深防御）；`localhost` 的 `http` 仅用于本地测试。
- **401/403 长退避**：上报收到 `401/403` 时不再立即重试（静态 Agent Token 无法自愈），进入 `AUTH_BACKOFF=600s` 长退避后返回，避免坏 Token 刷日志与对服务端暴力探测；其余瞬时错误（5xx、网络抖动）仍走原有指数退避重试（上限 3 次）。
- 验证：stub 平台采集模块后实跑，Linux / Windows 两端均通过「拒绝非 localhost http / 放行 https / 放行 localhost http / 401→False / 403→False / 500→重试后 False」共 12 项。

## P3：管理员两步验证 TOTP（⑧）（2026-07-09）

- **TOTP 第二因素（RFC 6238，零依赖）**（`server/src/totp.js`）：新增 `/api/admin/2fa/{status,setup,enable,disable}`。启用后，所有管理**写操作**（`POST /agents`、`PUT/DELETE /agents/:id`、`reset-token`、`/test-alert`）除静态 Token 外还需动态码——`adminOnly` 守卫在 `is2FAEnabled()` 时要求 `cookie.totp` 或 `X-TOTP` 头，纯静态 Admin Token 单独调用写接口将返回 `401 {need_totp:true}`。
- **登录态改为签名 Session Cookie**（`server/src/auth.js`）：Dashboard 登录 `POST /api/login` 校验 Token（+TOTP）后签发 `HttpOnly; Secure; SameSite=Strict` 签名 Cookie，前端**不再明文存储 Admin Token**（`localStorage` 方案改为 Cookie），从根本上消除前端 XSS 窃取 Token 的风险；`/api/logout` 清除会话。
- **兼容性**：只读拉取（Grafana、`/metrics` Bearer、`READONLY_TOKEN`）不强制 2FA，保持无感；旧式 `X-Admin-Token` 头仍被接受（用于程序化访问，但不满足 2FA 时写操作仍被拒）。
- **前端**（`public/index.html`、`public/app.js`）：登录/退出按钮 + 动态码输入；「安全」面板内新增 2FA 启用/禁用流程（密钥手动录入，不依赖外部二维码服务，符合 CSP）。
- **配置**（`server/.env.example`）：新增 `SESSION_SECRET`（Cookie 签名密钥，建议固定随机值）、`SESSION_TTL_MS`（默认 12h）。
- 单测：TOTP 算法通过 RFC 6238 标准测试向量校验。

## P3：Windows 受控端（⑨）（2026-07-09）

- **新增 `agent/windows/`**：与 Linux Docker Agent **协议完全兼容**的 Windows 原生受控端（基于 `psutil`），上报相同字段结构，服务端无需任何改动即可接收。
- `win_collector.py`：采集 CPU / 内存 / 磁盘 / 网络速率与月累计 / 开机时长；Windows 无 load average，`load1`/`load5`/`load15` 固定占位 `0.0`（仪表盘显示 0，已在文档说明）。
- `windows_agent.py`：HTTP `Bearer` 上报 + 指数退避重试（逻辑与 Linux `agent.py` 一致）。
- `install.ps1`：自动 `pip install psutil` 并注册「登录即启动、崩溃自动重启」的计划任务（`HostMonitorAgent-<AgentId>`），实现开机自启；`run.bat` 提供便捷临时启动。
- 安全：延续主项目原则——受控端零入站、无远程执行接口、全程 `HTTPS + Token` 鉴权；月流量累计持久化到 `state.json`，重启不丢。

## P3：轻量只读账号（READONLY_TOKEN）（2026-07-09）

- **独立只读 Token**（`server/src/auth.js` + `server/src/api.js` + `.env.example`）：新增可选 `READONLY_TOKEN`，通过 `X-Readonly-Token` 头携带。读接口（`GET /agents`、`/agents/sparklines`、`/agents/:id`、`/agents/:id/metrics`、`/overview`）改由 `adminOrReadonly` 守卫，admin 与 readonly 均可访问；写接口（`POST /agents`、PUT/DELETE `/agents/:id`、`reset-token`、`/test-alert`）改由 `adminOnly` 守卫，readonly 访问返回 `403`、无 Token 返回 `401`。避免给查看者共享全量管理 Token，是 RBAC 的最小可用基础。
- admin/readonly 均走恒定时间比较与 `X-Forwarded-Proto` 白名单（https 强制）；`req.role` 透传供后续扩展。

## P3：Prometheus /metrics 导出（2026-07-09）

- **`GET /metrics`（Prometheus 文本格式）**（`server/server.js`）：导出每个 Agent 的最新 CPU / 内存 / 磁盘 / 负载 / 网络速率与累计量 / 运行时长，以及 `monitor_up`（复用 `OFFLINE_THRESHOLD_SEC` 判定在线）。便于直接喂给 Grafana + Prometheus 做仪表盘与告警，无需轮询 JSON API。
- **鉴权**：`/metrics` 与后台一致使用 `Authorization: Bearer <ADMIN_TOKEN>`（恒定时间比较），未携带有效 Token 返回 401。
  > **后续修订**：该端点现已**默认强制 HTTPS**（M-2 修复，`server/server.js:151-157`，仅 `ADMIN_ALLOW_HTTP=1` 放行明文），并受管理端 IP 白名单约束（M-4）；本条「不强制 https，方便内网抓取」的描述已过时。另 `/metrics` **不认** `READONLY_TOKEN`。
- 指标名带单位后缀（`_bytes` / `_percent` / `_seconds`），label 为 `agent` 与 `name`（已转义），符合 Prometheus exposition 规范。

## P2 改进：Express 5 / 镜像固定 / 变量化邮箱 / 应用层限流（2026-07-09）

- **升级 Express 5**（`server/package.json`）：`express` 由 `^4.19.2` 升到 `^5.0.0`（Express 4 已 EOL）。本项目仅使用稳定 API（简单 `:id` 路由、`express.json`、静态托管），迁移无破坏性改动；需 `npm install` 重新安装依赖并重建镜像。
  > **勘误（2026-10-16 核对）**：该升级**实际未落地**——`server/package.json` 仍为 `"express": "^4.21.0"`。如需升级请作为独立变更重新评估。
- **Dockerfile 固定基础镜像版本**（`server/Dockerfile`）：`FROM node:22-slim` → `node:22.21.1-slim`，避免不同时间构建的镜像 Node 小版本漂移。
- **compose 邮箱占位符变量化**（`server/docker-compose.yml`）：`SMTP_USER/ALERT_FROM/ALERT_TO` 改为 `${...}`（与现有 `ADMIN_TOKEN` 一致），由运行环境 / `.env` 注入，消除硬编码占位。`cp .env.example .env` 后 compose 会自动插值，行为不变。
- **应用层 Admin 限流（兜底）**（`server/src/api.js` + `server.js`）：新增每 IP 每 10s 20 次的固定窗口限流，作用于除 `/report` 外的全部 `/api` 路由；并设 `app.set('trust proxy', true)` 使 `req.ip` 在 Nginx 后取真实客户端 IP，不再完全依赖 Nginx 限流（S7）。
  > **后续修订（H-02，2026-09-10）**：`trust proxy` 已由 `true` 收紧为**默认只信任 loopback**（含 `::ffff:` 映射形态的自研判定），反代在其它主机 / 容器时须显式设 `TRUST_PROXY`。原因是 `8081` 可被直连时，客户端可自造 `X-Forwarded-For` 绕过 IP 白名单与限流、自造 `X-Forwarded-Proto: https` 让管理接口走明文 HTTP。详见 `server/server.js:44-76` 与文档《环境变量》。

## P1 改进：Token 重置 / 告警态清理 / sparkline 批量（2026-07-09）

- **Agent Token 重置接口**（`server/src/api.js` + `server/src/db.js` + 前端）：新增 `POST /agents/:id/reset-token`，返回新 token 并使旧 token 立即失效，避免 token 泄露只能删库重建（S5）；仪表盘编辑弹窗新增「重置 Token」按钮并即时展示新 token。
- **删除 Agent 清理 `alert_state`**（`server/src/db.js`）：`deleteAgent` 现同步清除该 Agent 的告警冷却记录，避免残留影响后续告警判断（C5）。
- **sparkline 批量接口**（`server/src/api.js` + 前端 `app.js`）：新增 `GET /api/agents/sparklines?range=6h`，一次返回所有 Agent 的历史，前端由 N+1 并发改为单请求，消除 Agent 数量多时被 Nginx 限流 429 导致 sparkline 为空的问题（C4）。

## 安全修复 P0：令牌比较与 HTTPS 白名单（2026-07-09）

- **恒定时间令牌比较**（`server/src/auth.js`）：`agentAuth` / `adminAuth` 改用 `crypto.timingSafeEqual()`（新增 `safeEqual` 辅助，长度不等直接返回 false），消除令牌比较的时序侧信道（`S1`）。
- **`X-Forwarded-Proto` 改为白名单**（`server/src/auth.js`）：原逻辑为"有头且非 https 才拒绝"，会漏掉直连 :8081 的空头请求、且头可被伪造；现改为默认拒绝、仅 `proto === 'https'` 放行（`S2`）。本地明文测试可显式设 `ADMIN_ALLOW_HTTP=1`（生产切勿设置）。
- **quick-start 兼容**（`docker-compose.yml` 根目录）：因上述白名单，明文 http 直连会 403，故为该示例显式加 `ADMIN_ALLOW_HTTP=1`，保持快速测试可用。

## 前端可靠性与安全可观测性（2026-07-09）

- **概览/卡片独立刷新**（`server/public/app.js`）：`refresh()` 改用 `Promise.allSettled` 并发加载 `loadOverview()` 与 `loadAgents()`，任一接口异常不再阻断另一视图更新；仅当两者都失败时才显示错误横幅，并顺带由串行改并发、首屏加载更快。
- **仪表盘「测试告警」按钮**（`server/public/index.html` + `app.js`）：右上角新增「📨 测试告警」，点击校验 Token 后调用 `POST /api/test-alert`，按钮进入「发送中…」禁用态；`api()` 失败时优先回显服务端 `error` 字段。
- **「安全」说明弹窗**（`server/public/index.html` + 样式）：新增「🔒 安全」按钮，打开部署/安全说明（源站不直连、TLS、强口令、CSP、独立鉴权、/api 限流、CF 盾非必需、Tunnel 隐藏源站），提升安全实践可发现性。
- **Nginx 加固**（`nginx/monitor.conf.example`）：新增 `apilimit` 限流 zone 覆盖 `/api/` 后台接口，并补充 `X-Content-Type-Options` / `X-Frame-Options` / `HSTS` 安全响应头。
- **隐藏源站指南**（`TUNNEL-GUIDE.md` 新建）：提供 Cloudflare Tunnel 与 Tailscale 两种零入站端口方案及完整命令；README 中/英均已链接。

## 安全加固（2026-07-09）

针对代码审查报告的高/中优项及部分低优项完成一轮安全加固。

### 安全（修复）
- **CSP 收紧**（`server/server.js`）：移除 `script-src`/`style-src` 中的 `'unsafe-inline'`，改为 `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'`。前端所有 `onclick` 改为 `addEventListener` 事件委托，内联 `style=` 改为 CSS class / JS 赋值（`.v.green`/`.v.red`、`.metric.disk`、`data-pct` 磁盘条宽度）。
- **弱口令启动拦截**（`server/server.js`）：启动时校验 `ADMIN_TOKEN`，空值 / 等于 `change-me-admin-token` / 长度 < 16 直接 `process.exit(1)`。
- **管理接口强制 HTTPS**（`server/src/auth.js`）：`adminAuth` 校验 `X-Forwarded-Proto`，非 `https` 返回 `403 https required`。
- **告警循环隔离**（`server/src/alerts.js`）：`check()` 按 Agent 包裹 `try/catch`，单个 Agent 的 DB 异常不再中断整轮、饿死其余 Agent 的告警。
- **`.dockerignore`**（`server/.dockerignore` 新增）：排除 `data/`、`.env`、`node_modules` 等，避免 SQLite 数据库与凭据进入镜像构建上下文。
- **`sendAlert` 改为 await**（`server/src/alerts.js`）：`alertThreshold`/`check` 改为 `async`，三处告警发送均 `await`，不再 fire-and-forget。
- **prune 失败告警**（`server/server.js`）：`prune` 连续 3 次失败推送邮件告警，避免 metrics 表无限膨胀无感知。

### 前端可靠性的提升
- **错误态横幅**（`server/public/app.js` + `index.html` + `style.css`）：`refresh()` 改为 `async` 统一捕获 API 错误并显示 `#banner` 横幅（常驻、不刷屏），原 `loadOverview`/`loadAgents` 的静默空 `catch` 已移除。

### 审查结论（未改动 / 维持原状）
- 告警定时器「静默停止」前提不成立（Node `setInterval` 回调异常不会停止定时器），故仅修复循环隔离（#2b）。
- `PUT /agents/:id` 的 `name` 空值问题为误报（`str("",100) || a.name` 回退旧值），非安全问题。
- 低优项（admin 限流依赖 Nginx、Agent 重试退避注释、Token 恒定时间比较、默认邮箱运行时校验、SQLite WAL 模式）风险可控，暂未处理。

### 部署注意
- 服务现已拒绝弱/默认 `ADMIN_TOKEN`，部署前务必在 `.env` 设置足够随机、≥16 位的管理员 Token。
- 修改后需**重建镜像**（`docker compose build`）以使 `.dockerignore` 生效。
- 务必保持 Server 端口不发布到公网、只暴露 Nginx，HTTPS 强制检查才完整生效。
