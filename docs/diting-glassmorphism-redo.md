# diting 默认模板 Glassmorphism 毛玻璃化 — 重做方案（8月3日~8月4日指令固化）

> 背景：8月3日~8月4日对 diting 自带的 index / admin / node 三套页面做了 Glassmorphism
> 毛玻璃风格改造，但因中途回滚（记录 `[99] 08-04 11:00 直接回滚到了昨天`），
> 改动全部丢失。本文档从 CodeBuddy 会话 `24a1bf5f` 中逐条还原当时的全部
> CSS/模板风格修改指令，作为重新实施的唯一依据。
>
> 会话记录位置：
> `~/.local/share/CodeBuddyExtension/Data/da8cb325-7625-4cea-a7bb-71bb507fbf4c/VSCode/.../history/658f1f1a.../24a1bf5f713740beaac89c5ce78bd03a/`

---

## 一、核心目标

把 diting 自带的 **三套页面**（状态页 `index.html` / 后台 `admin.html` / 受控端详情页 `node.html`）
全部改成 **Glassmorphism 毛玻璃风格**，且三页**布局、页头、页脚完全统一**。

参考对象：**komari-theme-Glassmorphism** 社区主题（JSON-RPC 2.0 协议风格，含内联脚本、
nonce 放宽 CSP、固定列宽、毛玻璃卡片、页头留白、页脚社交图标）。

---

## 二、逐条指令还原（按时间）

### 8月3日 — 详情页 + 毛玻璃化主战

| # | 时间 | 指令要点（原文提炼） |
|---|------|----------------------|
| 27 | 07:32 | 还差**受控端详情页（node 页）**，参考 komari 设计 |
| 33 | 09:13 | 详情页保留，diting 本身也参考 komari 文件/参数命名标准（含 ping 延迟分析图表） |
| 37 | 10:01 | 磁盘分区数据没显示；**参考 komari 的「剩余价值计算」** |
| 38 | 11:54 | 延迟分析曲线要有 **日 / 周 / 月** 切换 |
| 39 | 12:00 | 延迟曲线**只保留移动/联通/电信/谷歌DNS** 四条，否则太杂乱浏览器卡；仔细参考 komari |
| 40 | 12:16 | 曲线可选展示，默认一小时曲线，有横轴数轴 |
| 41 | 12:28 | **完全参考 Glassmorphism 设计**：尺寸 + 鼠标移上显示 xy 交叉点 + 视觉 |
| 42 | 12:37 | 曲线展现方式要跟 Glassmorphism 一致，相差太大 |
| 51 | 13:21 | 延迟图表换回与 Glassmorphism 一致，xy 轴数字标准一致 |
| 52 | 13:39 | **波形图 Y 轴搞反了**：低延迟应在下方，高延迟在上方（之前 30ms 延迟却显示在 2000ms 位置） |
| **53** | **13:59** | **像 Glassmorphism 一样：固定列宽；取消页头大横条卡片；所有卡片做毛玻璃透明效果** |
| 58 | 14:34 | 页头不要卡片，直接留白（之前错取消的是四个统计卡片，不是页头横条） |
| 59 | 14:38 | 还原改错的四个统计卡片；页脚用 **QQ 图标**（之前错用邮箱图标） |
| **60** | **14:44** | **固定列宽是 index+admin+node 整页（含页头页脚）；页面中所有卡片都改毛玻璃，不保留任何非透明卡片，包括受控端卡片标题** |
| 63 | 15:02 | index 改好了，但 node 和 admin 依然大横屏 |
| 64 | 15:10 | **三页统一页头页脚**；固定列宽要并排放下四张受控端卡片 |
| 66 | 15:28 | 后台 css：在 index 一致基础上**多一个吸附左侧可收起展开的菜单**；菜单展开/收起**不影响后台布局，卡片不偏移** |
| 69/70 | 15:45/52 | 页头页脚仍有问题，全面排查 admin 页面 css 重复和冲突 |

### 8月4日 — 回滚后重新排查

| # | 时间 | 指令要点（原文提炼） |
|---|------|----------------------|
| 87 | 09:41 | 白色主题下**列表式卡片标题残留没毛玻璃化**；后台风格/效果/尺寸仍与前台不一致 |
| **90** | **09:45** | **立即全量审查 admin 页面所有代码和 css**，查后台尺寸风格与前台不一致原因；查不到就**重写 admin 页面** |
| 93 | 10:08 | 依然不一致，且**导致前台毛玻璃效果丢失、页头页脚卡片又出现** |
| 99 | 11:00 | 回滚到了昨天（工作丢失） |
| 100 | 11:01 | 从昨天记录调出所有修改参数和要求重做 |

---

## 三、归纳出的「CSS 风格修改硬性要求」（实施时必须全部满足）

1. **毛玻璃化**：index / admin / node 三页**所有卡片**（含受控端卡片标题、列表卡片标题）
   一律 `backdrop-filter: blur()` 半透明，**不保留任何非透明卡片**。
2. **取消页头大横条卡片**：页头直接留白，不要卡片包裹（注意：不是取消下方四个统计卡片）。
3. **统一页头页脚**：三页页头页脚完全一致（含页脚 **QQ 图标**，非邮箱图标）。
4. **固定列宽**：整页固定列宽，能并排容纳 **4 张受控端卡片**。
5. **后台专属**：admin 在 index 基础上加**左侧吸附、可收起展开的小圆角菜单**
   （居中、按长度自适应），菜单开合**不影响卡片布局/位置**。
6. **延迟图表（node 详情页）**：与 Glassmorphism 一致 ——
   日/周/月切换、默认 1 小时曲线、xy 交叉点 tooltip、低延迟在下高延迟在上、
   只保留移动/联通/电信/谷歌DNS 四条线。
7. **详情页功能**：参考 komari 做 ping 延迟分析图 + **剩余价值计算** + **磁盘分区显示**。

---

## 四、实施注意事项（踩坑回顾，避免重蹈覆辙）

- **不要回滚**：之前因反复改动导致整体回滚到改动前，所有工作丢失。本次应小步提交、
  每改一页即验证（无痕模式清缓存），避免整页推翻。
- **三页共用同一套 CSS**：index / admin / node 应抽离公共毛玻璃样式，避免各写各的
  导致页头页脚/列宽不一致（指令 63/64/65/69/70/87/93 反复出现不一致即源于此）。
- **admin 菜单不能影响卡片布局**：菜单用 `position: fixed` 吸附左侧，主内容区
  `margin-left` 固定或随菜单状态切换，卡片网格不受影响。
- **缓存问题**：毛玻璃/布局不生效时先无痕模式验证（指令 54/55/56/57 均因缓存误判）。
- **图标类型**：页脚社交图标明确要 QQ（指令 59），之前误用邮箱图标。

---

## 五、实施步骤（可执行计划，对应「修复路径」）

> 原则：**先统一架构与版本，再毛玻璃化，最后小步验证**。每一步都对应硬性要求第 1~7 条，
> 且严格遵守「四、实施注意事项」（不整页回滚、三页共用 CSS、菜单 fixed 吸附、无痕验证）。

### 参考项目实现要点（来自 sanrokamlan-prog/komari-theme-Glassmorphism v3.3.3，已 clone 到 /tmp 研读）

> 该主题用 Tailwind v4 + Vue，源码在 `src/styles/main.css` 与 `src/components/{Header,Footer,NodeCard}.vue`。
> 下面把可直接复用到我们纯 CSS 方案的关键数值/结构抽出，避免凭空编参数。

**1. 毛玻璃卡片（核心，对应要求 1 / Step 3）**
```css
/* 亮色：半透明 + 模糊 + 饱和增强 + 轻阴影 */
background-color: rgb(241 245 249 / 0.74);
border: 1px solid rgb(226 232 240 / 0.68);
backdrop-filter: blur(14px) saturate(145%);
-webkit-backdrop-filter: blur(14px) saturate(145%);
box-shadow: 0 8px 28px rgb(15 23 42 / 0.18);
/* hover 增强 */
background-color: rgb(248 250 252 / 0.8);
box-shadow: 0 12px 38px rgb(15 23 42 / 0.2);
/* 暗色 */
background-color: rgb(10 14 22 / 0.82);
border: 1px solid rgb(255 255 255 / 0.18);
box-shadow: 0 8px 30px rgb(0 0 0 / 0.48);
```
- 它用 `--glass-light-card` 等 CSS 变量做可托管预设；我们可直接写死上述 RGBA（更稳）。
- **Firefox 降级**（必加）：`@supports (-moz-appearance:none){ .card{ backdrop-filter:none; background-color: 更不透明 } }`，
  否则密集节点列表在 FF 下卡顿（原主题明确注释）。
- **legacy-webkit 降级**：旧 iOS 关 `backdrop-filter` 用实色 `--card`。

**2. 页头（对应要求 2 / Step 2）**
- 结构：`sticky top-0 z-10`，内层 `max-w-[1280px] mx-auto px-4 flex-between h-14`。
- 行为：**未滚动 `bg-transparent`（即留白、无横条卡片）**，滚动后加 `backdrop-blur-lg` 毛玻璃横条
  （指令 53/58「页头不要卡片、直接留白」= 默认透明留白，符合）。
- 我们纯 CSS 可简化为：页头默认透明留白，加 `backdrop-filter:blur(14px)` 毛玻璃底色常驻（不必做滚动监听也行）。

**3. 页脚（对应要求 3 / Step 2）**
- 原主题 Footer **只有两个 GitHub 文字链接，无社交图标**。「页脚用 QQ 图标」是**本项目的自定义需求**
  （指令 59），需我们自己加一个 QQ 图标（推荐内联 SVG 或 emoji 🐧/官方 QQ svg），三页统一。
- 结构：`footer { max-w-[1280px] mx-auto p-4 }` + 两端对齐 flex。

**4. 固定列宽（对应要求 4 / Step 2）**
- 全局容器 `max-w-[1280px] mx-auto`（约 1280px 固定列宽居中）。
- 首页卡片网格：`grid auto-fill minmax(300px,1fr)`（compact 默认）→ 宽屏自然并排 4 张。
- 我们 `.app-shell` 用 `max-width:1280px; margin:0 auto;`；`.cards` 改 `repeat(auto-fill,minmax(300px,1fr))`
  即可并排 4 张（原 `minmax(330px,1fr)` 也接近，可调到 300 更稳）。

**5. 兼容性清单（Step 3 必须一并实现）**
- `-webkit-backdrop-filter` 前缀（iOS/Safari）。
- `@supports (-moz-appearance:none)` 关 FF 的 backdrop-filter 并加不透明兜底。
- 暗色/亮色两套 RGBA 都给。

---

### Step 0 — 备份与基线（不动手前的兜底）
- 复制当前 `server/public/` 为 `server/public.bak-$(date +%Y%m%d)/`，确保任何一步出错都能
  单独还原该文件，而不是整页回滚。
- 用 `git status` 确认未混入无关文件（仅 `style.css` / 三个 html 在跟踪范围）。

### Step 1 — 统一 CSS 版本号（消除缓存分裂）【对应注意事项-缓存】
- 把 `index.html` / `node.html` 的 `style.css?v=27` 与 `admin.html` 的 `style.css?v=49`
  **统一为同一值**（如 `?v=50`），三页保持一致。
- 目的：根因 1 —— 版本号割裂会让不同页面加载到不同历史版本的 style.css，导致「前台毛玻璃、
  后台大横屏」这类部分回退（指令 65/93）。这是最该先修的一致性根因。

### Step 2 — 抽公共层：统一页头/页脚/卡片基类（DOM + CSS）【对应要求 2/3/4，根因 2/3】
- 在 `style.css` 新增公共类：
  - `.app-header`：三页页头统一基类（去 `.pv-topbar` / `.topbar` / `.nv-topbar` 各自写死的
    padding/border/background，改为引用 `.app-header`），**页头直接留白、无卡片横条**（要求 2）。
  - `.app-footer`：三页页脚统一基类；**admin.html 当前缺 `<footer>` DOM，需补一个 `.app-footer`
    结构**（根因 3：admin 无页脚元素，纯 CSS 救不回来），页脚本含 QQ 图标（要求 3、指令 59）。
  - `.app-shell` / `.app-main`：固定列宽容器（要求 4，能并排 4 张受控端卡片）。
- 三页 HTML 改造：
  - `index.html`：`.pv-topbar`→`.app-header`，`.pv-footer`→`.app-footer`，外层包 `.app-shell`。
  - `node.html`：`.nv-topbar`→`.app-header`，`.nv-footer`→`.app-footer`。
  - `admin.html`：`.topbar`→`.app-header`，**新增 `.app-footer`**；`.content` 外层包 `.app-shell`。
- 目的：根因 2 —— 三页页头/页脚/卡片各自独立 class 无公共层，每次改风格要改三处、漏改即不一致
  （指令 63/64/69/70）。

### Step 3 — 毛玻璃化（glass token + 应用到所有卡片）【对应要求 1，根因 4】
> 数值直接采用参考项目实测（`src/styles/main.css` L297-330），不重新发明。

- 在 `:root` 设计令牌新增（或直接写死到规则里）：
  ```css
  --glass-light-card: rgb(241 245 249 / 0.74);
  --glass-light-border: rgb(226 232 240 / 0.68);
  --glass-light-shadow: 0 8px 28px rgb(15 23 42 / 0.18);
  --glass-dark-card: rgb(10 14 22 / 0.82);
  --glass-dark-border: rgb(255 255 255 / 0.18);
  --glass-dark-shadow: 0 8px 30px rgb(0 0 0 / 0.48);
  --glass-blur: blur(14px) saturate(145%);
  ```
- 定义 `.glass` 基类（含 `-webkit-` 前缀，iOS/Safari 必需）：
  ```css
  .glass {
    background: var(--glass-light-card);
    border: 1px solid var(--glass-light-border);
    backdrop-filter: var(--glass-blur);
    -webkit-backdrop-filter: var(--glass-blur);
    box-shadow: var(--glass-light-shadow);
  }
  .dark .glass { background: var(--glass-dark-card); border-color: var(--glass-dark-border); box-shadow: var(--glass-dark-shadow); }
  .glass:hover { background: rgb(248 250 252 / 0.8); box-shadow: 0 12px 38px rgb(15 23 42 / 0.2); }
  ```
- **Firefox 降级**（参考 L444-494，密集列表必加）：
  ```css
  @supports (-moz-appearance: none) {
    .glass { backdrop-filter: none; -webkit-backdrop-filter: none; background: rgb(241 245 249 / 0.92); }
    .dark .glass { background: rgb(10 14 22 / 0.92); }
  }
  ```
- 将 `.glass` 应用到**全部业务卡片**（要求 1，零非透明卡片）：
  `.card` / `.stat` / `.ov-block` / `.nv-card` / `.ctable` / `.pane-section` / `.card .top`（卡片标题栏）
  / 列表式卡片标题（指令 87：白色主题下列表卡片标题也毛玻璃化）。
  - 方式：给这些类直接加 `.glass` 同等声明（或把它们 `background` 改为 `var(--glass-light-card)` 等），
    不要保留任何 `background: var(--card)` 实色。
- 页头页脚：页头用 `.glass` 或保持透明留白（要求 2，参考项目默认透明、滚动才毛玻璃，我们可常驻毛玻璃）；
  页脚卡片需毛玻璃。
- 目的：根因 4 —— 当前 `backdrop-filter` 仅弹窗遮罩有用，业务卡片一个没改。

### Step 4 — admin 左侧菜单 fixed 吸附（DOM + CSS）【对应要求 5】
- 把 `.sidebar` 从 flex 子项改为 `position: fixed; left:0; top:0; bottom:0;`，收起态 `width:68px`、
  展开态按内容长度自适应（小圆角）。
- `.content` / `.app-main` 用 `margin-left` 固定值随菜单状态切换（展开/收起两档），
  **卡片网格不重排、不偏移**（指令 66）。
- 菜单居中、按长度自适应（要求 5）。

### Step 5 — node 详情页功能核对（已完成，仅排查细节）【对应要求 6/7】
> **已核实：`node.js` 中这两项功能实际已实现**，无需重做。本步改为"核对细节 + 修小出入"。

- **延迟图表（要求 6）—— 已实现**（证据 `server/public/node.js`）：
  - 日/周/月切换：`.nv-range-bar` 含 **时/日/周/月** 四按钮（L359-363），且 `currentProbeRange='1h'`
    默认一小时曲线（L383）。
  - xy 交叉点 tooltip + 低延迟在下高延迟在上：L131-221（注释 L133/153/221 明确）。
  - 多余加分项：原始/平均/P95 聚合切换（L365-368）。
  - **小出入**：指令要求"仅移动/联通/电信/谷歌DNS"四条线，代码探针标签为
    `联通/电信/移动/公共(GG)`（L229/236）。需确认 `agent.probes`（PROBE_TARGETS 写死的公共 DNS）
    是否即"谷歌DNS"——若是纯命名差异则不改，若实际探测目标不是 Google DNS 则需调整标签/目标。
- **剩余价值计算（要求 7）—— 已实现**：L15-26 `Komari 式剩余价值计算：剩余天数 + 状态着色`。
- **磁盘分区显示（要求 7）—— 已实现**：L263-264 `disks` 遍历渲染 `nv-disk-row`；本月流量/配额 L331-334。

- 本步动作：仅在无痕验证时确认上述功能在前台（毛玻璃化后）视觉正常；如"公共/GG"命名需对齐
  指令文案，在 `node.js` L229/236 改映射即可，属微调非重做。

### Step 6 — 小步验证（每改一步即核对，避免整页回滚）【对应注意事项】
- 每完成 Step 1~5 中任一步，立即用**无痕模式**（清缓存）打开三页核对，确认无 CSS 冲突/重复/丢失
  （指令 54/55/56/57 均因缓存误判）。
- 对照「六、验证清单」逐条打勾；任一条不满足即回到对应 Step 定点修，绝不整页回滚。

### 执行顺序建议
```
Step 0 (备份) → Step 1 (版本号) → Step 2 (公共层) → Step 3 (毛玻璃) → Step 4 (admin菜单)
             → Step 5 (node功能) → Step 6 (循环验证)
```
每步独立可验证、可单独还原，从根因上消除「风格不一致 + 回滚丢失」。

---

## 六、验证清单（交付前逐条核对）

- [ ] index / admin / node 三页所有卡片均为毛玻璃半透明（含卡片标题）
- [ ] 三页页头均为留白、无大横条卡片
- [ ] 三页页头页脚完全一致，页脚为 QQ 图标
- [ ] 整页固定列宽，能并排 4 张受控端卡片
- [ ] admin 左侧菜单吸附、可收起、不影响卡片布局
- [x] node 延迟图表：日/周/月(时/日/周/月)、默认1小时、xy tooltip、低延迟在下、4条线 —— **已实现**（`node.js` L359-383/131-221）；仅"公共/GG"标签是否等同"谷歌DNS"待确认（L229/236）
- [x] node 详情页含剩余价值计算 + 磁盘分区显示 —— **已实现**（`node.js` L15-26 剩余天数 / L263-334 磁盘分区+本月流量配额）
- [ ] 白色主题下列表卡片标题也毛玻璃化
- [ ] 无痕模式验证三页无 CSS 冲突/重复/丢失
