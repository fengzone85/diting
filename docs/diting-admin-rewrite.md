# diting 前端彻底重构方案（对齐 komari 标准结构）

> 背景：admin 页面与 index/node 风格反复不一致（两天未解决）。根因是架构——
> 当前 `server/public/` 是「单 HTML + 原生 JS + 单 style.css」轻量结构，三页各自维护一套
> class 与样式，永远对不齐。决定采用 **方案 A：彻底对齐 komari 标准结构**，将前端重构为
> Vue3 + Vite + Tailwind + TS 的组件化 SPA（状态层用 Vue3 `reactive()` 轻量 composables，**替代 Pinia**），
> admin 不再是独立 `admin.html`，而是与 Home/Node 同构的 route，三页共用同一套 Header/Footer/Sidebar
> 组件与毛玻璃令牌。

---

## 一、komari 标准结构（已对官方主题 repo 实测）

参考 `komari-theme-Glassmorphism`（komari 官方主题，含真实前端源码）：
- 技术栈：**Vue 3 + Vite + Pinia + Tailwind v4 + TypeScript**
- 结构：`src/main.ts` 入口 → `App.vue` 全局布局（Header + RouterView + Footer）
  → `src/router` 路由 → `src/views/`（HomeView / InstanceDetail）→ `src/components/`
  （Header/Footer/NodeCard）→ `src/stores/`（Pinia：app/nodes）→ `src/services/`（API 层）
  → `src/utils/`（echarts/chartPalette/glassTheme…）
- **admin 是同一 SPA 内的 route**（package.json 有 `sync:admin` 脚本，后台与前台共用一套 Vue 前端），
  **不是独立 html 文件** —— 这正是我们要对齐的关键。

---

## 二、目标架构

```
server/
  public/                     # Vite 构建产物输出目录（由 server/web 构建写入）
    index.html                # 单入口（Vite 生成）：<div id="app"></div> + 引 assets
    assets/                   # 构建后的 js/css（带 hash）
    setup.html                # 保留独立（初始化向导，komari 同）
    themes/                   # 保留（第三方皮肤，不动，见七.2 emptyOutDir 注意）
  src/                        # 【已有，后端】api.js / auth.js / db.js / compat.js / validate.js ...
  web/                        # 【新增】前端工程根目录（独立子工程，避免与后端 package.json/src 冲突）
    src/                      # 前端源码（编译期输入）
      main.ts                 # Vue 入口：挂载 router + 全局 composables
      App.vue                 # 全局布局：<AppHeader/> + <RouterView/> + <AppFooter/>
      router/index.ts         # / 状态页 | /node/:id 详情 | /admin/* 后台 | /login 登录
      styles/
        main.css              # Tailwind 入口 + 毛玻璃设计令牌（移植自 Glassmorphism 主题）
      components/
        AppHeader.vue         # 三页统一页头（毛玻璃、固定列宽居中）
        AppFooter.vue         # 三页统一页脚（含 QQ 图标，对齐指令 59）
        Sidebar.vue           # 后台左侧吸附菜单（fixed、可收起、不影响卡片）
        NodeCard.vue          # 受控端卡片（毛玻璃）
        StatCard.vue          # 统计卡片
        ChartLatency.vue      # 延迟分析图（移植 node.js 已实现逻辑）
        ui/ ...               # 通用 UI 组件
      views/
        HomeView.vue          # 状态页（对应原 index）
        NodeDetailView.vue    # 详情页（对应原 node，含延迟图/剩余价值/磁盘分区）
        LoginView.vue         # 登录（对应原 admin 登录态）
        admin/
          AdminLayout.vue     # 后台外壳：Sidebar + 内容区（替代原 admin.html 结构）
          DashboardView.vue   # 总览
          AgentsView.vue      # 受控端管理 CRUD
          SettingsView.vue    # 设置中心（UI/notify/TOTP）
      composables/            # 【替代 Pinia】轻量状态层，基于 reactive() + provide/inject
        useApp.ts             # 主题/语言(localStorage) + 登录态(内存布尔，Cookie 驱动)
        useAdmin.ts           # agents / settings 缓存（仅内存，刷新重拉）
      services/
        api.ts                # 封装 fetch /api/*（same-origin + cookie）
        auth.ts               # login / logout / getAuthStatus()
      utils/
        i18n.ts  chartPalette.ts  glassTheme.ts  echarts.ts
    vite.config.ts            # 位于 server/web/ 根（独立工程），outDir: '../public'（即 server/public）
    package.json              # 前端依赖与脚本（dev/build/vitest 测试），与后端 server/package.json 分离
```

> **路径约定（吸收审查，已修正）**：现有 `server/package.json` 是后端（host-monitor-server），`server/src/`
> 已是后端源码。**前端工程整体下移 `server/web/`**，与后端彻底隔离。`server/web/vite.config.ts` 的工程
> root 是 `server/web/`，故 `outDir` 写 **`'../public'`**（解析为 `server/public/`，正确）。
> ⚠️ 旧版方案曾写「outDir 用 `'public'` 不是 `'../public'`」——那是假定前端在 `server/` 根的错误前提
> 推导出的结论；下移 `server/web/` 后，**此处反而应是 `'../public'`**。构建命令在 `server/web/` 目录执行。

> **架构决策（吸收审查）**：砍掉 Pinia，改用 `composables/`（基于 Vue3 `reactive()`）。
> **单例模式（吸收审查）**：每个 `useXxx.ts` 在模块顶层 `export const state = reactive({...})`，
> 模块即单例——无论被 `inject` 还是直接 `import` 调用，拿到的都是同一份状态，避免多实例不一致。
> 不依赖 `provide/inject` 跨层传递（仅在 `main.ts` 顶层 `app.use` 或组件内 `import` 即可）。
> 当前状态简单（主题、登录态、agents 列表），Pinia 过重；composables 减少依赖、降低学习成本，
> 后续若需多用户/多 tab 再升级不迟。状态归属明确：
> - **登录态**：服务端签发签名 Session Cookie（HttpOnly+Secure+SameSite=Strict），前端仅内存存
>   `isAuthed` 布尔（来自 `/api/admin/2fa/status` 鉴权响应，未登录返回 401），不持久化、不裸存 token。
>   ⚠️ 注意：`/api/me` 是 `src/compat.js` 给官方主题用的硬编码端点，**永远返回
>   `{logged_in:false}`、不读 Cookie、不 401**，绝不能作登录态守卫（会死循环）。
> - **主题/语言**：纯前端偏好，走 `localStorage`（key 如 `diting.theme` / `diting.lang`）。
> - **agents/settings 缓存**：仅内存 `reactive`，刷新即重新拉取，不持久化。

---

## 三、服务端改动（server.js，最小化）

目标：从「三文件 sendFile」改为「单入口 + history fallback」，admin 由前端路由接管。

> **实测事实（2026-08-05 读 server.js）**：现有 `app.get('*')` 通配兜底（L216）**已是精确前缀白名单**，
> 不是排除法——`/api`、`/themes` 显式 `next()`（L218），带后缀文件（JS/CSS/图片）直接 `next()` 交
> express.static 或第三方主题根映射（L227），仅无后缀才回落主题 index.html（L241）。故 SPA fallback
> 与现有主题路由**天然不冲突**，审查担心的「误吞主题」不成立。

1. **删除** `app.get('/admin.html', ipWhitelist, sendFile(admin.html))`（L204）——admin 改由前端路由接管。
   同时**加书签兼容路由（吸收二次审查）**，防旧书签/外链 404：
   ```js
   app.get('/admin.html', (req, res) => res.redirect(301, '/admin'));
   ```
2. **改造 L216 通配兜底**：把默认的「第三方主题 index.html（L241 的 `if (theme !== 'default')...`）」
   改为「**SPA 路由（/admin、/login、/node）优先；其余路径才投第三方主题**」。
   ⚠️ **关键（吸收再审查，防主题吞 SPA 路由）**：`public/themes/` 下 4 个主题（demo/glassmorphism/komari-demo/
   neobrutalism）**都有 `index.html`**。若仅按「`theme !== 'default'` 就投主题」，则用户一旦在设置启用任一
   第三方主题（或 `?theme=xxx` 预览），**所有无后缀路径（含 `/admin`、`/login`、`/node/:id`）都会被主题首页
   劫持，后台直接不可用**。故必须先判断 SPA 路由前缀，命中则无条件投 SPA，主题分支仅对非 SPA 路径生效。
   即 L241 块改为：
   ```js
   // 无后缀：SPA 路由（后台/登录/详情）优先，其余（默认是首页）才投第三方主题
   const SPA_PREFIXES = ['/admin', '/login', '/node'];
   const isSpaRoute = SPA_PREFIXES.some(p => req.path === p || req.path.startsWith(p + '/'));
   if (!isSpaRoute && theme && theme !== 'default' && /^[A-Za-z0-9_-]+$/.test(theme)) {
     const fp = path.join(THEMES_DIR, theme, 'index.html');
     if (fs.existsSync(fp)) {
       // 同原有 nonce/CSP 放宽逻辑（L246-253），略
       return res.sendFile(fp);
     }
   }
   // 默认 SPA 入口（管理员后台 / 状态页 / 详情页 统一由此承载）
   return res.sendFile(path.join(__dirname, 'public', 'index.html'));
   ```
   注意：`/admin`、`/login`、`/node/:id` **无需单独注册路由**——它们无后缀、非 `/api` 非 `/themes`，
   自动落入此兜底；因 `isSpaRoute` 优先命中，启用第三方主题时也正确返回 SPA 而非主题页。这正是 SPA history
   模式的标准做法，**且不影响第三方主题在首页（`/`）的正常展示**。
3. **保留** `app.get('/setup.html')`（L194）独立初始化（已初始化则重定向 `/admin`，
   **无过渡期歧义**，上线即切 `/admin`）。`express.static(public)` 不变（投构建产物 assets + index.html）。
4. **IP 白名单双保险**（吸收审查建议）：
   - **服务端层保留**：`ipWhitelist` 继续护 `/api/*` 写操作（现有 `app.use('/api', ipWhitelist)` 不变）。
     另在 L204 原位置新增 `app.get(/^\/admin(\/.*)?$/, ipWhitelist, ...)` 作网络层第一道闸（**正则覆盖裸
     `/admin` 与 `/admin/*`**，因 Express 4 中 `/admin/*` 不匹配裸 `/admin`；而 `/setup.html` 302 重定向目标恰是
     裸 `/admin`，不补正则则初始化完成的用户会落到无网络闸路径）。handler **显式 sendFile（吸收二次审查）**，
     语义清晰、不依赖落回 L216：
     ```js
     app.get(/^\/admin(\/.*)?$/, ipWhitelist, (req, res) => {
       res.sendFile(path.join(__dirname, 'public', 'index.html'));
     });
     ```
     放行后直接返回 SPA 入口；未授权 IP 由 `ipWhitelist` 直接 403 拦截。避免「同一路径两次兜底」维护困惑。
     （`/login` 故意不进白名单——登录页本应公开可见，否则无法登录；HTML 外壳无敏感数据，敏感数据都在
     `/api` 有白名单保护。）
   - **前端层**：`/admin/*` 路由守卫调 `GET /api/admin/2fa/status` 校验登录态（adminOrReadonly，未登录返回
     401）→ 未登录跳 `/login`，登录后回跳原子路由。⚠️ **不可用 `/api/me`**：它在 `src/compat.js` 永远返回
     `{logged_in:false}` 且不 401，用作守卫会死循环。
   - 即：**网络层 IP 白名单 + 前端登录守卫，双重保护**，与原安全模型一致且更强。
5. **零业务 API 改动**：`/api/login` `/api/logout` `/api/admin/2fa/status` `/api/overview` `/api/agents*`
   `/api/settings` `/api/agents/sparklines` `/api/agents/:id/metrics` 全部已存在，前端直接对接。
   ⚠️ `/api/me` 虽存在但属 compat 硬编码端点，前端不应依赖其登录态语义。

---

## 四、API 契约（前端 services 层直接用，零后端改动）

| 用途 | 端点 | 备注 |
|---|---|---|
| 登录 | `POST /api/login` `{token, totp}` | 返回签名 Session Cookie（same-origin，前端不裸存 token） |
| 登出 | `POST /api/logout` | credentials: same-origin |
| 登录态校验 | `GET /api/admin/2fa/status` | **路由守卫主选**：adminOrReadonly，未登录返回 401 |
| 登录态（备选） | `GET /api/settings` | adminOrReadonly，未登录 401；用于同时需设置的页 |
| 总览（后台） | `GET /api/overview` | AdminLayout 总览用（adminOrReadonly） |
| 总览（公开页） | `GET /api/public/overview` | **HomeView 用**，公开无鉴权（api.js:376） |
| 受控端列表 | `GET /api/agents` | CRUD: POST/PUT/DELETE `/api/agents[/:id]`（后台） |
| 受控端列表（公开页） | `GET /api/public/agents` | **HomeView/NodeDetailView 用**，公开无鉴权（api.js:398） |
| 续期/重置Token | `POST /api/agents/:id/renew` `/reset-token` | |
| 迷你图（后台） | `GET /api/agents/sparklines?range=6h` | |
| 迷你图（公开页） | `GET /api/public/agents/sparklines?range=6h` | **HomeView 用**，公开无鉴权（api.js:447） |
| 详情指标（后台） | `GET /api/agents/:id/metrics?range=24h` | AdminLayout 详情用（adminOrReadonly） |
| 详情指标（公开页） | `GET /api/public/agents/:id/probes` | **NodeDetailView 用**，公开无鉴权（api.js:471）；⚠️ 移植 node.js 延迟图必须调此端点，调 metrics 会因无 cookie 401 导致公开详情页坏 |
| 设置 | `GET/PUT /api/settings` | `{ui, notify}` |
| 公开页元信息 | `GET /api/public/meta` `GET /api/version` | **HomeView/NodeDetailView 用**（public.js:93/126，node.js:396） |
| TOTP 管理 | `GET /api/admin/2fa/status` `POST /api/admin/2fa/setup` `POST /api/admin/2fa/enable` `POST /api/admin/2fa/disable` | SettingsView「TOTP 设置」必用，原方案漏收 |
| 初始化分流 | `GET /api/setup/status` | LoginView 判断未初始化 → `/setup.html`，原方案漏收 |
| AI 报告 | `GET/POST /api/ai/config` `POST /api/ai/run` `GET /api/ai/status` `GET /api/ai/reports` | 后台 AI 功能，原方案漏收 |
| 计费/告警/主题市场 | `GET /api/billing` `POST /api/test-alert` `GET /api/public/themes` | Dashboard/Settings 功能，原方案漏收 |

> ⚠️ **契约表须从三页全量盘点**：后台端点对照 `admin.js`，**公开页端点须对照 `public.js` + `node.js`**（HomeView
> 源自 index、NodeDetailView 源自 node，数据源是 `/api/public/*` 而非 admin 端点）。执行前端 `services/` 时，
> 应 **`grep` 三个文件**罗列完整端点清单逐条实现，避免「零后端改动」但前端静默丢功能（尤其公开详情页错用
> `metrics` 会 401）。
> 注意：`/api/me`（compat.js 硬编码，永远 `logged_in:false`）**不在此表**，不可作登录态；`/api/public/order`
> 虽在 public.js 调用但是 `adminOnly`（api.js:518），勿当公开端点处理。

> 安全模型不变：前端只调 `/api/login` 拿 Cookie；无任何「指令通道」；TOTP 在 login 一并提交。

---

## 五、毛玻璃风格（移植已验证数值，不再打补丁）

直接复用 `komari-theme-Glassmorphism/src/styles/main.css` 实测值（已在 redo 文档固化）：
- 卡片：`blur(14px) saturate(145%)`；亮色 `rgb(241 245 249 / 0.74)`；暗色 `rgb(10 14 22 / 0.82)`
- 页头：`sticky top-0` + 未滚动透明留白、毛玻璃常驻；`max-w-[1280px] mx-auto` 固定列宽
- 页脚：两端对齐，含 QQ 图标（🐧）
- 兼容性：`-webkit-backdrop-filter` 前缀（必须，Safari/部分 Chromium 需前缀）。

**Firefox 兜底（吸收审查，补精确数值，不能只"关"）**：
FF 不支持 `backdrop-filter` 旧实现，降级为「半透明实色 + 细边框」，视觉接近毛玻璃而非全透：
```css
@supports not (backdrop-filter: blur(1px)) and (-moz-appearance: none) {
  .glass,
  .app-header, .app-footer, .card, .stat, .ov-block, .nv-card {
    background: rgba(255, 255, 255, 0.95) !important;   /* 亮色 */
    border: 1px solid rgba(15, 23, 42, 0.10);
    backdrop-filter: none; -webkit-backdrop-filter: none;
  }
  .dark .glass, .dark .app-header, .dark .app-footer,
  .dark .card, .dark .stat, .dark .ov-block, .dark .nv-card {
    background: rgba(15, 20, 30, 0.96) !important;       /* 暗色 */
    border: 1px solid rgba(255, 255, 255, 0.10);
  }
}
```
- 写入 `src/styles/main.css`（Tailwind @layer + CSS 变量 `--glass-*`），三页组件统一引用。

---

## 六、三页统一（根治不一致，架构保证）

HomeView / NodeDetailView / AdminLayout **共用 `AppHeader` + `AppFooter` + 同一套 Tailwind 毛玻璃令牌
+ 同一 `max-w-[1280px]` 容器**。从组件层面，三页外观由同一来源驱动——不可能再出现「admin 与
index 不一致」。Sidebar 仅在 AdminLayout 内出现（`position:fixed` 吸附、收起态 `width:68px`，
内容区 `margin-left` 跟随，卡片网格不偏移）。

---

## 七、迁移策略（不破坏现有服务）

1. **新增不删**：在 `server/` 下新建 `web/`（前端工程，含 `web/src/`、`web/vite.config.ts`、`web/package.json`），
   旧的 `public/admin.html` `index.html` `node.html` `*.js` `style.css` **暂不删**，构建产物覆盖同名文件，
   旧文件作回退。⚠️ 前端工程必须放 `server/web/` 子目录——`server/package.json` 与 `server/src/` 已是后端，
   不可在同一路径创建第二个 package.json / 混入前端源码（见二树修正）。
2. **构建原子性（吸收审查，已强化）**：避免「旧 HTML 引用新 assets」错乱窗口——
   - 构建前：`cp -r public public.bak-$(date +%Y%m%d-%H%M%S)`（时间戳备份，可保留多份）。
   - **`emptyOutDir` 必须设 `false`（🔴 必选，非可选）**：`server/web/vite.config.ts` 的 outDir 指向
     `../public`（即 `server/public/`），若用默认 `emptyOutDir:true`，vite 会**先清空整个
     `server/public/`**，删除方案声称「保留不动」的 `themes/`（含 glassmorphism/komari-demo/neobrutalism/demo
     共 4 个第三方主题）、`setup.html`、`setup.css/js`、`vendor/`、`flags/`、`i18n/`、`*.svg` 等，导致灰度期
     `/setup.html` 404、全部第三方主题失效。故配置 `emptyOutDir:false`，**vite 直接写 `server/public/`
     （`index.html` + `assets/`），旧文件（admin.html/node.html/style.css）因不清空而自动保留——无需 rsync
     中转**（⚠️ 上版写「rsync server/web/dist/ → public」与 outDir='../public' 自相矛盾：`dist/` 不存在，已删）。
     在**仓库根 `diting/.gitignore`** 增加 `public/assets/`、`public/index.html`（构建产物不进仓库；**不要加
     `web/dist/`**——outDir 直写 `../public`、无 dist 中间产物）。
     > ⚠️ **`.gitignore` 对已跟踪文件无效**：`public/index.html`（旧版）已在 git 索引中，仅加 `.gitignore`
     > 条目不会解除跟踪，构建产物会以「修改」形式被提交。需先 `git rm --cached public/index.html`（及旧
     > `admin.html`/`node.html`/`style.css` 若已跟踪）再提交；全新路径 `public/assets/` 不受影响。
   - 构建命令在 `server/web/` 目录执行：`cd server/web && npm ci && npm run build`。
3. **本地构建验证**：J4125 上 `node -v ≥20`（实测 v20.19.2 ✓）、`npm ci` 走 npmmirror 镜像（实测可达 ✓）。
   构建为一次性，运行时仍是纯静态文件，服务端零新增运行时依赖。
4. **灰度**：构建后无痕模式验证三页；若 SPA fallback 异常，**整目录恢复 `public.bak-*`**（构建前 `cp -r public
   public.bak-*` 的备份）——⚠️ 改造后 L216 直接 `sendFile('public/index.html')`，删该文件会 404 而非回退；且
   `/admin.html` 已 301 到 `/admin`、旧 `index.html`/`node.html` 无路由可达，故正确回退是恢复整目录快照
   （备份在 `public.bak-*`，非 `/tmp` 以免误清）。

---

## 八、保留已工作成果（不重做）

- `node.js` 已实现的 **延迟图表（日/周/月、默认1h、xy tooltip、低延迟在下、4条线）+ 剩余价值计算 +
  磁盘分区显示** 逻辑，移植进 `NodeDetailView.vue` + `ChartLatency.vue`（功能完好，仅换框架承载）。
- 安全审计整改（CSP、TOTP、Cookie 登录、IP 白名单）全部保留，前端只消费既有 API。

---

## 九、执行步骤（建议顺序，已按审查微调）

1. **脚手架**：在 `server/web/` 下新建前端工程（`package.json` + `vite.config.ts` + `tsconfig.json` + `tsconfig.node.json`）：
   - `package.json`（前端，含脚本）：`dev`/`build`/`test`；**`build` 用 `"vue-tsc -b && vite build"`**（类型错误在构建期拦截，不漏到运行时）；
     devDependency 引入：`vue` `vue-router` `tailwindcss@4` `@tailwindcss/vite` `vite` `@vitejs/plugin-vue`
     `typescript` `vue-tsc` `vitest` `echarts`（⚠️ Tailwind **v4** 用 `@tailwindcss/vite` 插件集成，**废弃** v3 的
     `tailwind.config.js` + postcss 方案）。
   - `vite.config.ts`（**物理位置 `server/web/` 根**，与 `server.js` 不同目录）：`outDir:'../public'`（即 `server/public/`）、
     `emptyOutDir:false`；`plugins: [vue(), tailwindcss()]`；`test` 配 vitest；
     **dev proxy 同时覆盖 API 与根级静态资源**（现有页面用根级相对路径引用 `logo-icon.svg`/`os-*.svg`/`flags/`/
     `i18n/`/`vendor/`/`/custom.css`，vite dev 默认 `publicDir=web/public` 不存在会 404，故代理到 `:8081`）：
     ```ts
     server: { proxy: {
       '/api':  'http://localhost:8081',
       '/flags': 'http://localhost:8081', '/i18n': 'http://localhost:8081',
       '/vendor': 'http://localhost:8081', '/custom.css': 'http://localhost:8081',
       '/os-': 'http://localhost:8081', '/logo': 'http://localhost:8081',
     }}
     ```
     （⚠️ 公开页纯 REST 轮询，**无 WebSocket 依赖**，proxy 无需 `ws:true`。）
   - `.gitignore`（**追加到仓库根 `diting/.gitignore`**，勿新建 `server/.gitignore`/`server/web/.gitignore`——git 不
     支持 `..` 父路径，子目录 gitignore 的 `public/assets/` 会被误解析为 `server/web/public/assets/` 无效）：
     加 `server/public/assets/`、`server/public/index.html`（构建产物不进仓库）。**不要加 `web/dist/`**——
     outDir 直写 `../public`、无 dist 中间产物。
   > ⚠️ **路径澄清**：前端工程在 `server/web/`，故 `vite.config.ts` 的 `outDir` 应为 **`'../public'`**（解析为
   > `server/public/`）。旧版方案写「用 `'public'` 不是 `'../public'`」是基于前端在 `server/` 根的错误前提，
   > 已作废。
2. **【提前】server.js fallback 改造**（以三.2/三.4 为准）：删 L204 `/admin.html`（改 301→`/admin` 书签兼容）；
   L216 通配兜底加 `SPA_PREFIXES` + `isSpaRoute` 优先判断（主题分支仅对非 SPA 路径生效）；新增
   `app.get(/^\/admin(\/.*)?$/, ipWhitelist, sendFile(index.html))` 正则网络层闸（覆盖裸 `/admin` 与 `/admin/*`）；
   `/setup.html` 重定向目标改 `/admin`。先验证 fallback 不与 themes/API 冲突（尤其启用第三方主题时 `/admin` 仍返 SPA），
   再写前端。
3. `web/src/main.ts` + `web/src/App.vue` + `web/src/router/index.ts`（四 route 骨架 + `/admin` 守卫，
   守卫调 `/api/admin/2fa/status` 鉴权；⚠️ 守卫须把 **401 与 403 都当未登录**——配置了 IP 白名单时该端点返 403 而非 401）。
4. `web/src/services/api.ts` + `web/src/services/auth.ts`（对接现有 API，**从三页全量盘点端点**：`admin.js`（后台）
   + `public.js`/`node.js`（公开页，HomeView/NodeDetailView 用 `/api/public/*`），含 mock 友好封装）。
5. `web/src/styles/main.css`（毛玻璃令牌 + Tailwind 入口 + FF fallback 数值）。
6. `web/src/components/`：AppHeader / AppFooter / Sidebar / NodeCard / StatCard / ChartLatency。
7. `web/src/views/HomeView.vue` + `NodeDetailView.vue`（移植 node.js 逻辑）。
8. `web/src/views/LoginView.vue` + `web/src/views/admin/*`（AdminLayout/Dashboard/Agents/Settings）。
9. `web/src/composables/useApp.ts` + `useAdmin.ts`（模块顶层 `export const state = reactive(...)` 单例；
   登录态内存 + 主题 localStorage + 数据缓存）。
10. **构建前备份**：`cp -r public public.bak-$(date +%Y%m%d-%H%M%S)`。
11. `cd server/web && npm ci && npm run build`（`emptyOutDir:false`）→ vite 直接写 `server/public/`（保留 themes/setup 等非构建文件）。
12. **【新增】Smoke test（吸收再审查，加深）**：
    ```bash
    B=http://localhost:8081
    curl -s $B/ | grep -c '<div id="app"'         # 1（SPA 首页，用 -s 非 -I，否则读不到 body）
    curl -s $B/admin | grep -c '<div id="app"'    # 1（🔴 关键：必须返回 SPA 而非主题页；启用第三方主题后此条仍须为 1）
    curl -s $B/login | grep -c '<div id="app"'    # 1
    curl -s $B/node/agt_xxx | grep -c '<div id="app"'  # 1
    curl -sI $B/admin | grep HTTP                 # 200（ipWhitelist 正则闸放行时）
    A=$(ls public/assets/ | grep -E 'index.*\.js$' | head -1)
    curl -s $B/assets/$A | head -c 100          # 200 + 非 HTML（JS 正文）
    curl -s $B/api/admin/2fa/status | head -c 50  # 未登录应返回 JSON 401，不被 SPA 吞
    curl -sI $B/setup.html | grep HTTP           # 200（验证 emptyOutDir:false 未误删）
    curl -sI $B/themes/glassmorphism/index.html | grep HTTP  # 200（第三方主题保留）
    ```
    > ⚠️ 上版用 `curl -sI ... | grep app` 是无效检查：`-I` 只取响应头，body 里的 `<div id="app">` 永远匹配不到。
    > 改用 `curl -s ... | grep -c '<div id="app"'` 验证返回的是 SPA 而非主题首页（只查状态码 200 无法区分两者）。
13. 无痕验证三页一致 + 登录/TOTP 流程 + 延迟图/剩余价值/磁盘分区。
14. **【改为稳定后删】**：确认新版本稳定 **48h** 后，再删除旧 `admin.html` `index.html` `node.html` `*.js` `style.css`（移出 public 或归档）。

---

## 十、风险与注意

- **构建链引入**：需 Node≥20（实测 v20.19.2 ✓）/ npm（npmmirror 可达 ✓），J4125 构建耗时但仅一次；运行时零新增依赖。
- **SPA fallback 与现有主题逻辑冲突（原高风险，实测已可控，但需 SPA 前缀优先）**：L216 通配本就是精确前缀白名单
  （`/api`、`/themes`、带后缀文件均 `next()`），SPA 回落仅作用于无后缀路径。改造只需把 L241 的
  默认主题 index.html 改为默认 SPA index.html。**⚠️ 关键（吸收再审查）**：`themes/` 下 4 个主题都有
  `index.html`，若仅按「`theme !== 'default'` 就投主题」会**让 `/admin`、`/login`、`/node/:id` 被主题首页劫持**
  （后台不可用）。故必须在 L241 改造里**先判 SPA 前缀（`/admin`、`/login`、`/node`）命中则投 SPA，主题分支仅
  对首页等非 SPA 路径生效**（见三.2 代码）。`public_theme='default'`（db 默认值，db.js:268）时主题不介入，
  二者互不干扰；启用第三方主题时 SPA 路由仍优先，仅首页展示主题——**互不干扰成立**。第三方主题可通过
  `?theme=<id>` 或 `public_theme` 启用，后台/登录/详情永不掉。**无需** `historyApiFallback.rewrites`（那是 dev server 概念）。
- **Login 守卫时序（吸收审查）**：AdminLayout 加 loading skeleton，等 `/api/admin/2fa/status` 鉴权返回再渲染内容
  （未登录 401 → 跳 `/login`）；服务端 `ipWhitelist` 对 `/admin`（正则 `/^\/admin(\/.*)?$/`）保留一层网络闸，双重保障。
  ⚠️ 不可等 `/api/me`（compat 硬编码永远 `logged_in:false`），否则死循环。
- **构建原子性（吸收审查）**：先时间戳备份再整体替换，避免新旧混引；`.gitignore` 排除构建产物。
- **状态归属（吸收审查）**：登录态走 Cookie（前端内存布尔）、主题/语言走 localStorage、数据仅内存。
- **🔴 禁用 `vite-plugin-legacy`（吸收再审查，防 CSP 拦截）**：全局 CSP `script-src 'self'`（无 unsafe-inline）
  下，该插件会产生 **inline polyfill** 触发 CSP 拦截使页面白屏。务必**不引入**此插件；若需兼容旧浏览器，改用
  非 polyfill 方案或在 CSP 显式放行对应 hash（不推荐，破坏 CSP 严格性）。
- **部署链路（吸收再审查，补写）**：产物上线靠 Docker 而非手动 cp。宿主 J4125 在 `server/web/` 构建出
  `server/public/` 后，经 `docker compose build/up` **重建镜像**（`Dockerfile` 为 `COPY . .` + `npm install
  --omit=dev`），新 `public/` 随 `COPY . .` 进容器；devDeps 被 `--omit=dev` 排除，运行时零新增依赖成立。
  **顺手在 `.dockerignore` 加 `web/`**（前端源码进镜像无必要，仅要构建产物 `public/`；若构建在宿主完成则 `web/`
  只是源码，忽略更干净）。
- **工作量**：约 20~30 个新文件，架构级改动；但彻底根除「风格不一致」且对齐 komari 标准、便于后续
  直接套用 komari 生态主题。

---

## 十一、测试策略（吸收审查，新增）

- **测试框架（吸收二次审查明确）**：用 **Vitest**（与 Vite 生态天然集成，无需额外适配），
  `package.json` devDependency 引入，`vite.config.ts` 内 `test` 配置即可。`vi.fn` / `vi.mock` 直接可用。
- **Smoke test（构建后必做，见步骤 12）**：curl 验证 `/`、`/admin`、`/node/:id` 均 200 且返回 SPA
  `index.html`；`public/assets/index.*.js` 可加载（200 + 非 HTML）；`/api/admin/2fa/status` 未登录返回 **JSON 401**
  （不被 SPA fallback 吞）；`/setup.html` 与 `themes/*` 仍 200（验证 `emptyOutDir:false` 未误删静态资源）。
- **services 层 mock 测试**：`services/api.ts` / `auth.ts` 用 Vitest `vi.fn` mock `fetch`，覆盖
  login 成功/失败、登录态鉴权（调 `/api/admin/2fa/status` 判断 401/200）、agents CRUD 调用契约，确保前端
  对接的端点/字段与后端一致。⚠️ `auth.ts` 函数名用 `getAuthStatus()`（**勿用 `me()`**——`/api/me` 是 compat
  硬编码端点，永远 `logged_in:false`，非登录态接口）。
- **路由守卫用例**：未登录访问 `/admin/*` → 跳 `/login`；登录后回跳原子路由；IP 白名单拒绝的 IP
  在网关层 403（服务端测）。
- **回归验证**：node.js 已实现的延迟图/剩余价值/磁盘分区在 `NodeDetailView` 移植后功能一致
  （对照原 `node.js` L15-26/L131-221/L263-334 逐项核对）。
