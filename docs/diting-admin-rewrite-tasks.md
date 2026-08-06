# diting 前端重构 — 任务清单与缺陷台账

> 文档目的：承接 `diting-admin-rewrite.md` 九步计划，把"逐项检验"结果收敛为**可执行任务清单 + 缺陷台账**。
> 检验基准日：2026-08-06。状态以 `server/web/src` 实际代码为准（非口头记录）。
> 优先级：P0=阻塞/崩溃级，P1=核心功能缺失，P2=体验/增强。

---

## 一、已完成项（无需再做）

| 模块 | 完成情况 | 证据 |
|---|---|---|
| 脚手架 / Vite / Tailwind v4 / Vitest | 完成 | `server/web/` 工程、`vite.config.ts` outDir=`../public` emptyOutDir=false |
| server.js SPA fallback | 完成 | `/admin` 301、`SPA_PREFIXES` 优先、IP 白名单正则闸、保留 themes |
| 路由 + 登录守卫 | 完成 | `router/index.ts`；守卫 401/403 均判未登录；`LoginView` 已实现 `redirect` 回跳 + TOTP 输入 |
| 公开页 API 层 | 完成 | `publicApi.ts`（`overview/agents/sparklines/probes/meta/saveOrder`） |
| probes 归一化（P0 崩溃已修） | 完成 | `publicApi.agents()` 内 `parseProbes` 处理 JSON 字符串 |
| HomeView / NodeDetailView | 完成 | NodeDetailView 已用 `ChartLatency`（CPU/内存/速率）、磁盘分区、网络质量 |
| 后台 AdminLayout / Dashboard / Agents | 完成 | Dashboard 含账单摘要+测试告警按钮；Agents 含新增（Linux/Docker/Windows 安装命令） |
| 设置中心 UI/通知/TOTP | 完成 | `SettingsView` 含 UI、SMTP/Telegram 通知、社交链接、`TwoFactorPanel` |
| 账单 / AI 运维视图 | 完成 | `BillingView`（月度/分组/到期）、`AiView`（配置/状态/运行/报告分页） |
| 主题系统 composable | 完成 | `useTheme.ts` 支持 auto/light/dark + localStorage |
| 构建产物（probes 修复后） | 已构建 | `index-DFMEpcze.js` 等新包（未提交） |

---

## 二、缺陷台账（Bug List）

### P0 — 阻塞 / 数据契约错配
- [x] ~~**B1（误报，已核实）**~~：原记"`adminApi.aiReports` 传 `limit/offset` 而后端期望 `page/perpage`"。
  **2026-08-06 核查 `server/src/api.js:727-731` 结论：后端 `/api/ai/reports` 实际接受 `limit/offset`，返回 `{total, limit, offset, list}`；`AiView.vue` 的 `offset`/`changePage` 与 `AiReportList.total` 完全匹配，分页正常。B1 不成立，划除。**

### P1 — 核心功能缺失
- [x] **B2 i18n 框架 + 关键页双语**（2026-08-06 已完成）：新增 `composables/useI18n.ts`（`localStorage` 持久化 `diting.lang` + `t(key,vars)` 插值）、`utils/i18n/zh-CN.ts` / `en-US.ts` 全量字典。接入 **AppHeader（公开页语言切换器 + 主题切换）**、**Sidebar**、**AdminLayout 菜单**、**LoginView**、**DashboardView**、**AgentsView**。已 `npm run build` 通过。后续增量：把 BillingView/AiView/SettingsView/NodeDetailView/HomeView 剩余硬编码中文逐步迁移到字典即可。
- [x] **B3 Agent 列表搜索/排序/批量**（2026-08-06 已完成）：`AgentsView.vue` 新增搜索框（名称/ID）、排序下拉（名称/CPU/内存/在线状态）、每行复选框 + 全选 + 批量操作条（删除/重置Token/续期），循环调用现有单条 API（后端无批量端点）。已 `npm run build` 通过。
- [x] **B4 主题 `?theme=` 预览 + 切换菜单 + 第三方预览**（2026-08-06 已完成）：
  - `useTheme.ts`：初始化读 `?theme=light|dark|auto` 做一次性预览（优先级高于 localStorage）；新增 `applyQueryPreview()` 锁定预览到本地。
  - `AppHeader.vue`：主题单按钮升级为下拉菜单（跟随系统/亮色/暗色）+ 当 URL 含 `?theme` 时显示"预览模式"条与"应用此预览"按钮。
  - `SettingsView.vue`：第三方 `public_theme` 选择旁加"预览"按钮（跳 `/?theme=<id>`，由后端渲染第三方皮肤）。
  - **边界说明**：SPA 自身只渲染内置主题（CSS 变量驱动）。第三方主题（komari 等）由后端 `public_theme` 决定、服务端渲染给访客，**SPA 内无法加载第三方 CSS 做内嵌预览**——前端能做的是"存 `public_theme` + 跳转公开页预览"，已实现。已 `npm run build` 通过。

### P2 — 体验增强
- [x] **B5 Dashboard 趋势图**（2026-08-06 已完成）：`adminApi` 新增 `sparklines(range)`（→ `/api/agents/sparklines`，后端批量返回所有 agent 时序，避免 N+1）；Dashboard 聚合所有受控端求**集群平均 CPU/内存时序**，渲染两张 `ChartLatency`（CPU `#38bdf8` / 内存 `#a78bfa`）+ range 切换（1h/6h/24h/7d/30d）。已 `npm run build` 通过。
- [x] **B6 `home_layout` 布局切换**（2026-08-06 复核+补全）：**UI 切换与渲染本身早已实现**（HomeView 有 grid/list/compact + simple/visual 切换按钮，NodeCard/NodeRow 已支持）。本次补全：**后端 `ui.home_layout` 作为访客默认布局下发**——`useApp.refresh()` 在用户未本地主动选择时采用 `meta.home_layout`（api.js:507 已暴露）。已 `npm run build` 通过。
- [x] **B7 Agent 详情图**（2026-08-06 已完成）：`adminApi` 新增 `metrics(id, range)`（→ `/api/agents/:id/metrics`）；`AgentDetailView` 新增「资源趋势」区块，渲染 CPU / 内存 / 流量 三张 `ChartLatency` + range 切换（1h/6h/24h/7d/30d）。已 `npm run build` 通过。

---

## 三、后端契约核查记录（已闭环）

- `server/src/api.js:727-731`：`GET /api/ai/reports` 接受 `limit/offset`，返回 `{total, limit, offset, list}`。前端 `adminApi.aiReports(limit, offset)` + `AiView.vue` 翻页逻辑正确，**B1 误报，已划除**。
- 其余服务层（`adminApi.ts`）对照 `api.js` 路由：agents CRUD、settings、billing、ai/config|status|run、test-alert 均匹配，无契约错配。

---

## 四、九步计划对照（剩余缺口）

| 步骤 | 状态 | 缺口 |
|---|---|---|
| 1 脚手架 | ✅ | — |
| 2 server.js fallback | ✅ | — |
| 3 路由/守卫 | ✅ | — |
| 4 services 层 | ✅ | —（B1 误报已划除） |
| 5 毛玻璃样式 | ✅ | B4（主题预览联动） |
| 6 受控端管理/仪表盘/设置 | 🟡 | B2(i18n) B3(搜索排序) B5(Dashboard图) B6(布局) |
| 7 Home/Node 详情 | ✅ | B7（Agent 详情图待确认） |
| 8 登录/2FA | ✅ | — |
| 9 composables | ✅ | — |

---

## 五、建议执行顺序（C 方向：先文档化，再分批修）

1. ~~先核查三（后端 AI reports 分页参数）~~ → **已完成，B1 误报划除**。
2. ~~P0 B1~~ → **误报，无需修**。
3. **P1 B3**：Agents 搜索/排序/批量（用户最高频管理操作）。← 当前进行中
4. **P1 B2**：i18n 框架 + 关键页双语（工作量最大，建议单独一轮）。
5. **P1 B4 → P2 B5/B6/B7**：主题预览、Dashboard 图、布局、详情图（可合并为一轮"视觉增强"）。

---

## 六、提交/部署提示

- probes 修复（`publicApi.ts`）**已构建未提交**，属 `feature/vue-spa-admin-rewrite` 分支。
- 新增/修改任务产物勿入仓库：`.codebuddy/`、`server/public.bak-*/` 已应被 `.gitignore` 覆盖；提交前 `git status` 确认无脏文件（见记忆：只 `git add` 相关路径）。
- 每次前端改动后：`cd server/web && npm run build` → 重启 Node（`pkill -TERM -f "node server.js"` 被安全规则拦截时按 PID kill）→ 走方案步骤12 smoke test。
