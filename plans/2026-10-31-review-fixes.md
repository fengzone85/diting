# 方案：审查清单纠偏与修复（2026-10-31）

> **状态**：**已实施**（2026-10-31，master `d93edee`）。P1-1/P1-2/P1-3、P2-1/P2-2、P3-reporter/P3-web 全部落地并推送；
> db.js 拆分按评估结论改为「不拆 + 结构守护」（见 §3 P3 表）。web 覆盖率由 60.09/53 提升到 93.75/85.04，
> 服务端 654 项、web 294 项、Go 全包测试通过。
> **基线**：审查时提交为 `c21398a`（当时工作区另有 4 项未提交改动，已随 Komari 分支一并收尾）。
> **目标**：把外部审查报告的 7 项清单转成可执行修复项，并修正其数据口径、定级与遗漏。
> **约束**：不改主题模板（既定原则：适配在服务端做）；不动受控端指纹红线。

---

## 0. 结论摘要

原报告"7 项中 5 属实、1 不属实、1 部分属实"在**方向上成立**，但存在两类问题：

1. **方法论**：同一张表混用"总行数"与"非空行数"，把同一文件的两种口径误判为"新旧版本"；用行级正则计数当"函数个数"。
2. **定级**：两个 P0 中，SESSION_SECRET 首装已覆盖（应降级），真正的更高优先级缺口（分发链接失效、前端依赖未扫描）反而缺失。

最终修复顺序（相对原报告有 3 处反转）：

| 原报告 | 本方案 | 理由 |
|---|---|---|
| P0 SESSION_SECRET 持久化 | **P1** | Docker 首装已生成；缺口在 Docker 升级（`update_server()`）与原生/systemd/手工部署 |
| P0 AI_API_KEY 加密/强制 env | **P1**（推荐模式 + 清理残留） | "强制"会让后台 Key 表单失效，文档已自我标注 |
| P1 CI 补 Go test + govulncheck | **P1（web audit + npm ci + go 门禁）／P4（govulncheck）** | Go 测试已在发布流水线（tag 门禁）；**web** 前端依赖未扫描（server 侧 audit 已存在）；Go 零第三方依赖 |

---

## 1. 统计口径约定（本方案强制）

后续所有"规模"类数字必须标注口径，三种定义互不通用：

| 口径 | 定义 | 适用 |
|---|---|---|
| 总行数 | `wc -l` | 文件体积、拆分成本 |
| 非空行 | 排除 `^\s*$` | 与历史审查对齐时必须注明 |
| 语义计数 | `Object.keys(require(...))`、AST、`grep` 后去注释 | "函数个数""路由条数""迁移条数" |

**实测对照（基线 c21398a）**

| 文件 | 总行 | 非空行 | 语义计数 |
|---|---|---|---|
| `server/src/api.js` | 2521 | 2385 | 109 条 `router.*` 路由 |
| `server/src/db.js` | 2153 | 2002 | 导出 160 项，其中函数 **155** |
| `agent-go/adaptive.go` | 86 | 79 | — |
| `agent-go/reporter/reporter.go` | 126 | 115 | — |
| `SettingsView.vue` | 1121 | 1058 | 块行 1–610 / 612–1121；**内容行** script 608、template 508；无 `<style>` |

原报告的 `110 个函数` 不复现；上一轮复核中的 `api.js 84 个 helper` 亦不成立——该数字把 26 条 `require` 绑定、28 个普通常量与 1 个 `let` 一并计入，真实 helper 为 21 个 `function` 声明 + 18 个箭头函数 + `asyncHandler` 包装。

---

## 2. 逐项裁定

| # | 原结论 | 终审 | 关键证据 |
|---|---|---|---|
| 1 | 属实 | 方向成立，切分前提需修正 | admin 路由 61 条按功能域聚合为 **5 段**（460/11、1298/15、1696/15、1999/12、2411/8）；`api.js:1224` `POST /public/order` 用 `adminOnly` ⇒ 前缀≠权限边界；db.js 有 19 条 `ALTER TABLE` 文本，其中 `:350`、`:438` 是 `for…of cols` 循环模板串，**语义上 17 条独立 + 2 条循环**，分属不同函数、不构成单一序列 |
| 2 | 属实 / P0 | 事实成立，**降 P1**，需按形态细分 | Docker 首装（`diting.sh:555-570`）已生成；**Docker 升级（`update_server()` :699+）与原生/systemd 形态均未覆盖**（原生 `.env` 全脚本只读不写，`server_native_port()` :903）。本机生产 `.env` 已有非空值，当前未受害。影响面漏项：`distribution.js:142` 由 SESSION_SECRET 派生 `TOKEN_KEY`，重启使**已发出的一次性安装/下载链接失效** |
| 3 | 属实 / P0 | 成立，范围与手段需修 | `db.js:1794` 自述 `api_key`/`smtp_pass`/`telegram_bot_token` 同级明文；`ai/provider.js:103` 只改读取侧；`docs/src/content/docs/env.md:27` 已写明该模式下"后台表单 Key 字段失效" |
| 4 | 属实，可测性高 | 半成立 | `adaptiveInterval` 纯函数高可测；`reporter.go:22` `authBackoff` 为 10 分钟包级常量，401/403 分支测试会真阻塞。另 agent-go 根包（`main`/`runOnce`/主循环）零测试 |
| 5 | 属实 1121 行 | 成立，依据错 | 1121 与 1058 为同一文件两种口径；结构实为 script 块 1–610（内容 608）+ template 块 612–1121（内容 508），无 style 块 |
| 6 | 不属实 | **完全正确** | `auth.js:31` 拒 pending 上报（`api.js:32` 是 `isValidCycle`，原引用有误）；`api.js:363` 未配 SETUP_TOKEN → 403；`:381` `SETUP_REQUIRE_APPROVAL=0` 可关闭审批；`:371` 默认上限 50 |
| 7 | 部分属实 | 不完整 | `agent-go-release.yml` 有 `go test ./...`（出包门禁）；真缺口：`server/web` 无 npm audit、Go 未进 master PR 门禁、CI 用 `npm install` 非 `npm ci` |

细化：`#2` 的"含 TOTP 二次验证状态失效"应表述为"**本次会话的 2FA 通过标记（payload.totp）失效**；TOTP 绑定存于 `admin_config`，无需重新绑定"。

---

## 3. 修复方案

### P1-1 存量部署补 SESSION_SECRET（`diting.sh`）

**现状（两种部署形态，写入点只有一个）**

| 形态 | `.env` 位置 | 谁写 |
|---|---|---|
| Docker（`install_server()`，:505） | `$SRC_DIR/server/.env`（`SRC_DIR=/opt/diting-src`，:104） | 首装分支 :555-570 生成；else 分支只同步 PORT |
| 原生 / systemd | `$(server_workdir)/.env`（`systemctl show -p WorkingDirectory`，:897） | **全脚本只读不写**（`server_native_port()` :903） |

`migrate_env_admin_token` 有两个调用点：`:539`（install）与 `:785`（`update_server()`，从 :699 开始）——**后者才是真正的存量升级路径**。只挂 `install_server` 的 else 分支，`diting.sh --upgrade` 用户依旧不会补齐。

**改法**：新增 `ensure_session_secret()`（仿 `migrate_env_admin_token()`，:1225），按形态解析 env 路径：

1. Docker 形态用 `$SRC_DIR/server/.env`；原生形态用 `$(server_workdir)/.env`（取不到则跳过并提示）。
2. 文件不存在 → 返回（首装分支负责）。
3. 已有非空值（`^SESSION_SECRET=.+`）→ 不动，静默返回。
4. 缺失或为空 → `openssl rand -hex 32`；存在键则 `sed -i` 替换，否则 `printf` 追加。
5. 幂等：重复执行不改变已有值。
6. 输出提示：**"已补齐 SESSION_SECRET；此前发出的一次性安装/下载链接将失效，需重新生成"**。
7. **刻意只补 SESSION_SECRET，不补 SETUP_TOKEN**：后者为空时注册端点直接 403（安全默认），补齐反而扩大暴露面。

**调用点（两处都必须挂）**：`install_server()` 的 else 分支（:571+）与 `update_server()` 开头（:699+，紧跟 `migrate_env_admin_token`）。

**服务端兜底告警**（与部署形态无关）：`server/server.js` 现有 `.env` 权限告警旁（:181-190 风格）增加——若 `!process.env.SESSION_SECRET` 则 `console.warn` 提示"重启将使全部登录态与已发分发链接失效"。覆盖手工/裸跑/原生部署，一行成本。

**备选（不采用）**：server 启动时自动落盘。容器内 `.env` 不持久化、只读 rootfs/多实例会失败，且服务端无法判断部署形态——安装器是唯一掌握该信息的层。

**验收**（复用既有测试模式）
- `server/test/secrets-db.test.js:54-57`（已断言 compose 保留 SESSION_SECRET）与 `diting-admin-token-migrate.test.js:64`（`.env` fixture）作为模板。
- 新建目录（无 `.env`）走完整安装 → 生成 64 hex，重启后登录态保持。
- 空值 `.env` → `--install` 与 `--upgrade` 两条路径分别执行 → 均被填值。
- 已有有效值的 `.env` → 执行两次 → 值不变。
- 原生形态：把 `server_workdir` 指向临时目录，验证走 `$(server_workdir)/.env` 而非 `$SRC_DIR`。
- 空值补齐后重启进程，旧分发链接按预期失效（与提示文案一致）。

### P1-2 CI 补齐三处（`.github/workflows/test.yml`）

| 改动 | 说明 | 预判 |
|---|---|---|
| `server/web` 增加 `npm audit --audit-level=high` | **21** 个前端依赖（5 runtime + 16 dev，`package.json` 实测）未扫描；**server 侧 audit 已存在**（`test.yml:26-28`），缺口仅在 web | 2026-10-31 registry 在线实测 **15 moderate / 0 high**；**接入前必须在目标环境联网重跑**，离线环境不可引用该结果 |
| `npm install` → `npm ci`（两处） | 校验 lockfile，避免"本地/CI 装到不同版本" | 需先本地 `npm ci --dry-run` 验证 lockfile 与 package.json 一致 |
| 新增 `go` job：`setup-go@v5` + `go 1.22` + `go test ./...` | 触发条件同 push/PR master | `agent-go/go.mod` 零第三方依赖、无 `go.sum`，耗时约 20s |

`govulncheck` 不在本批（见 P4）。`agent-go-release.yml` 现有 tag 门禁保持不变。

**验收**：临时把某条 Go 断言改错 → PR CI 必须红；恢复后绿。`npm ci` 在干净 runner 上通过。

### P1-3 密钥口径统一（AI / SMTP / Telegram）

**现状**：三者均以明文 JSON 存 `admin_config`（`db.js:1794` 自述）；`AI_KEY_FROM_ENV=1` 只影响读取（`ai/provider.js:103`），**DB 中历史 key 不清除**；`docker-compose.yml:51-52` 已注入 `AI_KEY_FROM_ENV`/`AI_API_KEY`，通路无需新建；`api.js:2176` 已返回 `key_from_env`，`web/src/services/types.ts:441` 已有该字段。

**不做可逆加密的理由**：加密密钥最终仍需放 env，能拖库的攻击者通常也能读 env，等于把问题平移；且与"ADMIN_TOKEN 只在 env、库中仅哈希"的既定口径冲突。

**改法**

1. 文档：`README.md:265`、`docs/src/content/docs/env.md:27-28` 明确"三类凭据均为明文落库，要么接受 DB 文件保护，要么改用 env 模式"。
2. **入口 + 存储双层丢弃**：
   - `api.js` PUT `/ai/config` 白名单阶段：仅当 `AI_KEY_FROM_ENV !== '1'` 才接受 `allowed.api_key`；
   - `db.setAiConfig` 写盘前再剔除一次，防止未来其他调用方绕过入口。
   两层缺一不可：只改存储层，表单保存会让残留"复活"；只改入口，非 HTTP 路径仍可写入。
3. **启动兜底清理**：在 `server/server.js` 的 `app.listen(...)`（:669）**之前**无条件调用幂等 `purgePlaintextAiKey()`：env 模式且 `ai_config.api_key` 非空 → 清空 + 日志。**不要放进 `ai.start()`**——`ai/index.js` 的 `start()` 在 `config.enabled=false` 时直接 return（日志"未启用，调度器不启动"），而"未启用 AI 的部署"恰恰最可能有历史残留。覆盖"切模式前已落库"与备份恢复带回的明文。
   **测试副作用必须约束**：该位置在 `server.js` 顶层、`app.listen` 之前，每条集成测试加载 `server.js` 都会执行一次。函数在"非 env 模式"或"key 为空"时必须**零日志、零写入**，否则会污染测试输出并意外改写 `ai_config`。
4. 后台表单：`web/src/views/admin/AiView.vue:206` 的 Key 输入在 `config.key_from_env === true` 时 `disabled`，并显示"由环境变量 AI_API_KEY 提供"。**位置不是 SettingsView**（SettingsView 无 AI 配置项）。
5. `smtp_pass`/`telegram_bot_token` 无 env 模式，保持现状，仅文档标注明文。

**边界（重要）**：备份恢复是**整库替换**（`backups.js` 写 `RESTORE_TRIGGER`，由 `diting.sh` 在宿主替换 DB），会绕过第 2 条的写入拦截。恢复后明文 key 会重新出现，靠第 3 条在下次重启时清除。由于 env 模式下 `resolveApiKey` 完全不读 DB，残留**不会被发往模型服务**，属存储卫生问题而非泄露通道——不要为此增加复杂处理。

**风险**：从 env 模式切回 DB 模式需要重新录入 Key（文档注明）。

**验收**
- env 模式 PUT 带 `api_key` → `admin_config.ai_config` 不含 `api_key`；
- 手工向 DB 写入含 key 的 ai_config → 重启后被清空并留日志；
- `key_from_env=true` 时输入框禁用；
- 关闭变量后可正常写回。

### P2-1 `api.js` 按功能域拆分（不是按前缀）

**现状**：61 条 admin 路由按功能域聚合为 **5 段**（460/11、1298/15、1696/15、1999/12、2411/8），与 `/public`、`/agents` 交错；`/public/order` 需 admin 权限 ⇒ 前缀不是权限边界。二级路径分布（实测，合计 61）：theme 15、notify 11、agent 13、security 11、billing 10、dashboard 1。

109 条路由的完整构成：61 admin + 16 `/agents` + 9 `/public` + 9 `/ai` + 5 `/setup` + **9 条无前缀路由**（`/report`:311、`/overview`:723、`/billing`:763、`/client-ip`:1649、`/settings` GET:1963 + PUT:1970、`/test-alert`:2145、`/login`:2347、`/logout`:2400）。

**切法（6 域，dashboard 留在主文件）**

```
server/src/routes/
  _shared.js           # 仅放 api.js 内部定义的中间件 + 纯函数
  admin-theme.js       # /admin/theme/*                                      15 条
  admin-notify.js      # /admin/notify/*                                     11 条
  admin-agent.js       # agents/alert-rules/agent-versions/agent-artifacts/agent-distribution  13 条
  admin-security.js    # 2fa/sessions/api-tokens/audit-logs                  11 条
  admin-billing.js     # backups/capacity/restore-audit/backup-status        10 条
```

- notify 必须独立：11 条并入其他域会让该文件冲到 400+ 行，违背拆分初衷。
- dashboard/layout 仅 1 条且属 UI 布局，与 security 语义无关，**留在主文件**，不单独成域。

**三步走**

1. **先抽共享层（零行为变更，独立提交）**。区分两类，不要重复造：
   - 已是独立模块，**直接 require、不要复制**：`adminOnly`/`agentScope`/`safeEqual`/`auditLog`/`requireAdmin`（`auth.js`）、`bucketKey`/`loginGuard*`（`ratelimit.js`）、`str`/`num`/`sanitizeCss`（`validate.js`）。
   - 真正需要下沉到 `_shared.js` 的是 **api.js 内部定义**的：`rateLimit`(:60)、`loginRateLimit`(:89)、`agentGlobalOnly`(:120)、`setupRateLimit`(:131)、`registerRateLimit`(:353) + 纯函数 `shortHost`/`parseDisks`/`diffKeys`/`clampInt`/`sanitizeBackupSettings`/`sanitizeCapacitySettings`/`buildInstallCommands`/`buildModifyCommands`/`publicDisabled`/`getUptime30d` 等。
   - 依赖方向固定：`_shared.js` → `auth/ratelimit/validate/db`，**不得 require 任何域文件**。
2. **逐域迁移**：theme（最独立）→ notify → billing → security → agent；每迁一个域跑一次 `npm test` + 手工冒烟，目标单文件 200–400 行。
3. **主 api.js 只留组装 + 剩余散路由**：`router.use(rateLimit)`（`api.js:81`）必须仍在最前，全局限流不能因子 router 化而丢失。
4. **加路由快照断言**（`server/test/routes-snapshot.test.js`）：把拆分前的 method+path 清单固化为数组，断言集合完全相等，防拆漏或重复注册。

- 子 router 以 `router.use('/admin/theme', themeRoutes)` 挂载，**保留完整路径**，避免改 61 处路由字符串。
- `module.exports.diffKeys / buildModifyCommands / buildInstallCommands`（`api.js:2518-2521`）迁移后**直接改测试引用路径，不留 re-export 垫片**（符合项目"不做向后兼容层"口径）。
- **明确留在主文件的路由**：16 条 `/agents`、9 条 `/public`、9 条 `/ai`、5 条 `/setup`，以及上述 9 条无前缀路由。其中 `/overview`、`/billing`、`/settings` 同样"前缀≠权限边界"（均带 `adminOrReadonly`/`adminOnly`），拆分时不要误当成漏拆项。

**验收**：`router.*` 计数仍为 109；`npm test` 全绿；路由快照测试通过；手工冒烟覆盖 theme 安装/回滚与 notify 渠道增删。

### P2-2 `agent-go/adaptive_test.go`

表驱动覆盖：`cur=nil`、`prev=nil`（首报）、防抖递减、CPU>15pp、内存>15%、rx/tx>100KB/s 且相对变化>1.0、`Load1` 突增>1.0、平稳落慢档。

必须补两条边界用例（否则分支永远测不到）：
- `changeRatio` 的 `prev <= 0 → 2.0`（`adaptive.go:82-83`）：注释明写这是为了躲开 `1.0 > 1.0 === false` 的漏触发，必须有用例锁定。
- `MemTotal === 0` 的除零守卫（`adaptive.go:45-47`）：`cur.MemTotal > 0` 不成立时不得进入内存分支。

**现行行为偏差**：触发时 `*fastStreak = 3`，随后 3 次递减，实际快档 **4 轮**（触发轮 + 3 轮防抖）。测试按实际行为断言，并把三处"至少 3 轮"注释（`adaptive.go:8`、`:28`、`:33`）统一改为"触发轮 + 3 轮防抖"。

### P3 其余三项

| 项 | 要点 |
|---|---|
| reporter 可测性重构 | `authBackoff` 改为 `Reporter` 字段（默认仍 10min），测试注入 1ms；补 200 / 401 / 403 / 500 重试耗尽 / ctx 取消 5 例 |
| SettingsView 拆分 | **按文件真实 `<h2>` 分组**（AI/主题/安全不在本文件，分别在 `AiView.vue`/`TemplateView.vue` 及 Sessions/ApiTokens/AuditLog 视图）：① 备份+容量（`:786-1043`，template 约 258 行，收益最高）；② 告警阈值 + 分组覆盖（`:671-730`）；③ 通知（`:731-773`）；④ 站点 UI + 社交链接（`:620-670`、`:774-785`）。**不变量**：子组件不得各自持有 local 状态，否则破坏 `useSettingsForm.test.ts` 守护的 watch 注册顺序，以及 `resetLocal()`(:103)/`cloneSettings()`(:206) 的同步规则——状态仍由父组件单一持有，子组件只收 props + emit |
| db.js 域拆分 | **不做**（2026-10-31 评估）：metrics 读路径只有 5 行薄封装（重查询已在 `heavy-queries.js` / `metrics-merge.js`），其余函数共享同一个 `stmts`（113 处引用），拆出需工厂注入 `(db, stmts)`，只减行数不降耦合；且 17 条独立 `ALTER TABLE` + 2 处 `for…of` 循环迁移的顺序、`dbworker.js` 只读连接都是硬约束。**替代方案**：保留 `server/test/db-schema.test.js` 结构守护（19 张表 / 迁移列 / 缺列老库升级 / 只读接口冒烟），防住「改 schema 忘补迁移列」这类真实事故 |

### P4 `govulncheck`

`agent-go/go.mod` 无任何 `require`、无 `go.sum`，扫描面仅标准库。等 Go 侧引入第三方依赖后再接入，本轮不做。

---

## 4. 分支与提交

**P0 前置（阻塞一切实施）**：当前 `master` 工作树带 4 项已修改（`server.js`、`compat.js`、`integration.api.test.js`、`plans/2026-10-26-komari-compat-fields.md`）+ 本方案的未跟踪文件。开工前必须处理，否则后续每个分支都会把脏文件一起带走：

- 本方案文档 → 单独提交到 `docs/review-fixes-plan`；
- 4 项 WIP 若不属于本轮 → `git stash`（或归入各自原分支），**不得混入任一 squash 分支**。

合并口径统一为：**分支内压成 1 个提交 → `git merge --no-ff` 并入 master → 删分支**。若要求 master 不留 merge commit（纯线性），改用 `git merge --squash`；两种方式不可混用。

| 批次 | 分支 | 合并方式 |
|---|---|---|
| P1-1 | `fix/session-secret-upgrade` | squash 单提交 |
| P1-2 | `ci/go-and-web-audit` | squash 单提交 |
| P1-3 | `feat/key-env-mode` | squash 单提交 |
| P2-1 | `refactor/api-admin-routes` | squash 单提交 |
| P2-2 | `test/agent-adaptive` | squash 单提交 |
| P3 | 各自独立分支 | squash 单提交 |

每次 push 前在 `DEVLOG.md` 顶部按批次追加记录。

---

## 5. 明确不做

- 不"强制" `AI_KEY_FROM_ENV`（会让后台 Key 表单失效）。
- 不修改 `SESSION_SECRET` 默认随机行为（安全默认正确，缺的是持久化）。
- 不改 Komari 主题模板（既定原则：适配在服务端）。
- 不在本轮做 db.js 拆分与 govulncheck。
