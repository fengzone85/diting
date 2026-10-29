# 方案：Komari 模板兼容字段填充（2026-10-26）

> **状态**：决策已拍板（D1–D4，见 §2.4），待评审后实施。**尚未改动任何代码。**
> **目标**：让 Komari 社区皮肤/模板在本项目上**开箱即用**，用户不必改主题源码。
> **约束**：受控端**零自动采集**个体级指纹（红线只在受控端这一侧不可动）。
> **关联分支**：`docs/komari-compat-plan`（本文档）、`feat/compat-field-mapping`（PR1，待开发）。

---

## 0. 结论摘要

"填充 Komari 模板数值"这个需求里，**只有 3 个字段真正碰到指纹红线**；其余是
**数据已在库里但兼容层没映射**、**一处错误映射**、**一张过时的能力声明**、**三张注定空的图表卡片**。

因此拆两批：

| | 范围 | 红线成本 | 收益 |
|---|---|---|---|
| **PR1** | 兼容层 / 标准 API 字段映射 + 能力声明 + 卡片清理 | **零** | 模板的核数/进程数/温度/价格/到期全部有值；不用改主题 |
| **PR2** | 硬件档案（CPU 厂商+代际 / 架构 / 虚拟化） | 需修订口径 | 补齐硬件卡最后三格空白 |

---

## 1. 现状核查（代码事实）

### 1.1 三个数据出口层

| 层 | 文件 | 路由 | 消费方 |
|---|---|---|---|
| Komari 兼容层 | `server/src/compat.js` | `/api/nodes`、`/api/node/:uuid`、WS `/api/clients` | Komari 社区皮肤直连 |
| Komari JSON-RPC | `server/src/compat-rpc.js` | `POST /api/rpc2` | 官方 Glassmorphism 等 |
| 标准 API | `server/src/v1.js` | `/api/v1/*` | adapter / 自研皮肤 |
| 原生公开接口 | `server/src/api.js` | `/api/public/agents` | 本项目原生前端首页/详情页 |

`compat-rpc.js:268,281` 的节点方法全部复用 `compat.toNode` → **compat 的 `toNode` 是兼容侧唯一收口点**，改一处覆盖全部出口。
`api.js` 的 `api` router 挂在 `/api`（`server.js:327`）。

### 1.2 A 类：数据已在库里，兼容层没映（零成本、零红线）

| Komari 字段 | 现状（`compat.js`） | 库里的真实来源 | 备注 |
|---|---|---|---|
| `cpu_cores` | `0`（:88） | `agents.cores` | S1/T18 已采（`db.js:481` `setAgentCores`）；`getAgent` 是 `SELECT *`（`db.js:380`）→ 读得到 |
| `process`（实时） | `0`（:139） | `metrics.process_count` | Linux 数 `/proc`、Windows 走 PDH，两平台都采（`collector/linux.go:135`、`collector/windows.go:254`） |
| `temp`（扁平实时态） | `0`（:176） | `metrics.temp` | 已有值 |
| `price` | `-1`（:98） | `agents.price` | 业务字段 → 须受 `public_show_business` 控制 |
| `billing_cycle` | `30`（:99） | `agents.billing_cycle` | 业务字段；**0 = 白嫖，不能被 `|| 30` 吞掉** |
| `currency` | `'$'`（:103） | `agents.currency` | 业务字段；diting 默认是 `¥`（`db.js:374`） |

`collector.go:78` 的注释已写着「前端 Komari 兼容层 process.count 图消费此字段」，
但兼容层把 `process` 写死 0 —— **agent 采了、DB 存了、模板拿不到**。

### 1.3 B 类：现在是错的，必须修

```91:91:diting/server/src/compat.js
    kernel_version: a.hostname || '',
```

```52:52:diting/server/src/v1.js
    kernel: a.hostname || null,          // 如实填 hostname（diting 无独立内核版本）
```

**拿主机名冒充内核版本**：主题上会把 `n5100` 显示成「内核版本」。
必须改为 `''`/`null`：内核版本是红线字段，且模糊化它更糟（"5.15" 比 "5.15.0-1160" 指向的 CVE 集合更宽）。
`v1.js` 的注释「如实填 hostname」也需一并改口径。

> 影响面核查：全仓 `kernel` 只出现在这两处 + 原生前端 `kernel_version`（`NodeDetailView.vue:590-591`，读 `/api/public/agents`，该接口本就不返回此字段 → 恒显示「—」）。**无消费方依赖 v1 的 `kernel = hostname`。**

### 1.4 C 类：能力声明（CAPABILITY）过时 + 三张空卡片

```22:34:diting/server/src/v1.js
const CAPABILITY = {
  gpu: false,
  connections: false,
  // 2026-10-12 起 agent 真实采集进程总数（聚合计数，无个体明细）→ 能力置 true
  process: true,
  virtualization: false,
  arch: false,
  cpu_cores: false,
  cpu_name: false,
  temperature: true,
  disks: true,
  probes: true
};
```

- `cpu_cores: false` 与事实矛盾（`agents.cores` 真实存在且已写库）。
  CAPABILITY 的设计意图就是「adapter/模板据此隐藏 diting 不采集的字段」（`v1.js:21`），
  声明成 false → 主题/adapter **主动隐藏**核数字段 → 用户必须改主题才能显示。**这是"要改很多地方"的机制性原因。**
- `/api/public` 的 `chartDashboardTemplate.cards` 硬编码 13 张（`compat.js:251-257`），
  其中 `gpu` / `gpuMemory` / `connections` **永远无 series**
  （`compat-metrics.js:36-40` 刻意只断映射不删定义；`:174-180` 全 0 字段不生成 series）→ 主题渲染三张空图表。
  `process` / `temperature` 已有真值映射（`compat-metrics.js:46,54`），可保留。

### 1.5 D 类：三个需要新决策的空字段

`compat.js:85-87`：`cpu_name: ''` / `virtualization: ''` / `arch: ''`。
原生前端同样读空：`NodeDetailView.vue:531` 读 `agent.cpu_name` 恒为「未知」；
`hwDynamic`（:157-174）里 `arch`/`virtualization` 恒为「—」，`gpu_name`/`cpu_physical_cores` 永不渲染；
`kernel_version`（:590-591）恒为「—」。
`node.cpuCores` 这个 i18n key 存在但**全仓未被使用**（原生前端根本没显示核数）。

---

## 2. 设计决策

### 2.1 红线口径修订（只改服务端侧，受控端侧不动）

| | 内容 | 本方案 |
|---|---|---|
| **R1（不可动）** | 受控端不得自动采集个体级指纹 | **不动**：agent 零新增采集面，零新外传路径，零入站/零指令通道不变 |
| **R2（本次修订）** | 服务端 DB 尽量不含可匹配漏洞的指纹 | 从「**不采集**」改为「**不自动采集**；硬件标识仅允许管理员手工录入粗粒度标签」 |

依据：本项目自身的自我限定 —— `README.md:538`「不采集能直接匹配漏洞或降低二次扩散成本的字段」、
`README.md:566`「新增采集字段需要重新做安全评审」。`hostname` / `os` 已被认定为「轻量标识」，
本方案与之同级。

### 2.2 硬件档案粒度：厂商 + 代际

- **CPU**：厂商 + 代际级标签，如「Intel 第 11 代」「AMD Zen 3」「Apple M2」。
- **不做**：精确型号、芯片天梯/排行、GPU 型号、内核版本、连接数。
- **依据**：代际粒度恰好**切断「同分组 = 同漏洞面」这条等式** —— Intel 第 11 代横跨
  Skylake / Coffee Lake / Ice Lake / Rocket Lake / Alder Lake 多个微架构，
  攻击者拿到该桶仍无法确定用哪套 exploit（对照 `README.md:533` 描述的精确型号危害）。
  保留展示价值，削掉攻击可执行性。

### 2.3 公开可见性：只能选 A

`/api/nodes`（`compat.js:267`）是**免登录公开接口**（仅受 `public_enabled` 开关），
CAPABILITY 本身也是公开的。因此：

- **选项 A（本次选定）**：硬件档案进公开层 → Komari 模板在公开页正常显示。
  语义与 Komari 一致（那边是用户自愿公开节点配置），粗粒度标签的公开危害远小于精确型号。
- **选项 B**：只进 admin API → 公开页模板拿不到这几格，且 CAPABILITY 必须保持 `false`
  → **与"用户拿到模板不用改"的目标互斥，填了也白填**。

### 2.4 已定决策（2026-10-26 拍板）

| 编号 | 决策 | 落法 |
|---|---|---|
| **D1** | 字段拆分 | `agents` 表**四列**：`cpu_vendor` / `cpu_tag` / `arch` / `virtualization`，各自受控枚举；Komari 单字符串 `cpu_name` 由 `composeCpuName(vendor, tag)` 合成 |
| **D2** | 公开可见性 | **A（公开）**。硬件档案进公开层（`/api/nodes`、`/api/v1/nodes`、`/api/public/agents`），CAPABILITY 随之为 true。代价：访客可见；收益：公开页 Komari 模板开箱即用 |
| **D3** | `virtualization` | **收**（物理机/KVM/VMware/Hyper-V/LXC/Docker/其他，与 `os` 同级的粗粒度环境描述） |
| **D4** | 候选清单 | 服务端内置常见值 + 「其他/未知」，**不做联网补全**；单一事实源 `server/src/hardware-profile.js`，前端下拉经 API 取，不前后端各存一份 |

---

## 3. PR1：兼容层与标准 API 字段映射修正（**零红线成本**）

分支：`feat/compat-field-mapping`

### 3.1 逐项改动（before → after）

**`server/src/compat.js`**

| # | 位置 | before | after | 理由 |
|---|---|---|---|---|
| 1.1 | `toNode` :88 | `cpu_cores: 0` | `cpu_cores: Number(a.cores) \|\| 0` | 真实采集值，模板显示核数 |
| 1.2 | `toNode` :91 | `kernel_version: a.hostname \|\| ''` | `kernel_version: ''` | **修错误映射**：不拿 hostname 冒充内核版本 |
| 1.3 | `toNode` :98 | `price: -1` | `price: show ? priceOf(a) : -1` | 业务字段 + 口径换算（见下） |
| 1.4 | `toNode` :99 | `billing_cycle: 30` | `billing_cycle: show ? billingCycleOf(a) : 30` | 0 = 白嫖须原样保留 |
| 1.5 | `toNode` :103 | `currency: '$'` | `currency: show ? (a.currency \|\| '¥') : '$'` | 用真实币种 |
| 1.6 | `toRealtime` :139 | `process: 0` | `process: Number(m.process_count) \|\| 0` | 真实采集值 |
| 1.7 | `getNodesLatestStatus` :176 | `temp: 0` | `temp: Number(m.temp) \|\| 0` | 真实采集值 |
| 1.8 | `getNodesLatestStatus` :177 | `process: 0` | `process: Number(m.process_count) \|\| 0` | 同 1.6 |
| 1.9 | `/api/public` :251-257 | cards 含 `gpu`/`gpuMemory`/`connections` | 去掉这三张 | 无数据源（红线不采）→ 保留必然渲染空图，用户必须改主题才能去掉 |

**口径换算规则（diting ↔ Komari，1.3/1.4 依赖）**

```
price:   diting 0（未设置） → Komari -1（主题显示「—」）
         diting <0（白嫖） → Komari 0（主题显示 ¥0）
         diting >0          → 原值
         业务字段关闭        → -1
cycle:   null/空/非数 → 30；0（白嫖/一次性）原样保留；业务字段关闭 → 30
```

依据 `src/billing.js:36-38`（diting：`price === 0` = 不显示；`price < 0` = 白嫖）与
`db.js:731` / `api.js:1413-1414`（`billing_cycle = 0` 须显式保留）的既有口径。

**`server/src/v1.js`**

| # | 位置 | before | after | 理由 |
|---|---|---|---|---|
| 1.10 | `CAPABILITY` :29 | `cpu_cores: false` | `cpu_cores: true` | `agents.cores` 真实存在且已写库 |
| 1.11 | `toNode` :52 | `kernel: a.hostname \|\| null` | `kernel: null`，并新增 `hostname: a.hostname \|\| null` | 修错误映射；主机名另立字段，暴露面不变（原本就经 kernel 泄露） |
| 1.12 | `toNode` :48-70 | 无核数字段 | 新增 `cpu_cores: Number(a.cores) \|\| null` | 标准 API 语义补齐 |
| 1.13 | `toNode` :48-70 | 无 | 新增 `arch: null` / `cpu_name: null` / `virtualization: null` | 先占位保形状，PR2 再接 |

**`server/src/api.js`（原生公开接口）**

| # | 位置 | 改动 | 理由 |
|---|---|---|---|
| 1.14 | `/api/public/agents` base :717-750 | 新增 `cores: Number(a.cores) \|\| 0` | 原生前端目前拿不到核数（`node.cpuCores` 这个 i18n key 全仓未被使用） |

**`server/web/src`（原生前端）**

| # | 位置 | 改动 |
|---|---|---|
| 1.15 | `NodeDetailView.vue` 硬件卡 | 显示 `cores`（复用已存在但未使用的 `t('node.cpuCores')`） |
| 1.16 | `types.ts` :12/:37/:45 | `cores` 已声明；`cpu_name`/`kernel_version` 保持可选，PR2 再接 |

### 3.2 对外接口契约（PR1 后）

| 出口 | 变化字段 | 值 |
|---|---|---|
| `/api/nodes`（compat） | `cpu_cores` | `Number(a.cores) \|\| 0`（0 = 未上报） |
| | `kernel_version` | `''`（**由 hostname 改为空**） |
| | `process`（实时/扁平） | 真实进程数 |
| | `temp`（扁平） | 真实温度 |
| | `price`/`billing_cycle`/`currency` | 真实值，受 `public_show_business` 控制 |
| `/api/nodes` | `chartDashboardTemplate.cards` | 去掉 gpu/gpuMemory/connections |
| `/api/v1/nodes` | `cpu_cores` / `hostname` | 新增；`kernel` 改为 `null` |
| `/api/v1/nodes/:uuid/capability` | `cpu_cores` | `false → true` |
| `/api/public/agents` | `cores` | 新增 |

### 3.3 测试（新增 `server/test/compat-fields.test.js`）

用 `DB_PATH=':memory:'` 隔离库（与 `compat-metrics.test.js` 同法）：

1. `cpu_cores` 映射：造 `setAgentCores(id, 4)` → `toNode().cpu_cores === 4`；未上报时为 0
2. `kernel_version` 恒为 `''`（**回归锁死：绝不能再等于 hostname**）
3. `toRealtime().process` / `getNodesLatestStatus().temp` / `.process` 为真实值
4. 价格换算：0 → -1；-1 → 0；100 → 100；`public_show_business=false` → -1
5. 周期保留：0（白嫖）不被换成 30
6. `CAPABILITY.cpu_cores === true`
7. `v1.toNode().kernel === null` 且 `hostname` 有值
8. `chartDashboardTemplate.cards` 不含 `gpu`/`gpuMemory`/`connections`，含 `process`/`temperature`

### 3.4 兼容影响

- 老主题不消费新字段 → 无影响；新增字段不破坏现有渲染。
- `kernel_version` 由 hostname 改为空：老主题该格从「显示主机名」变成「未知」——**这是修正**（原本是错的）。
- 移除三张卡片：老主题若硬编码渲染 GPU/连接数卡，现状就是 0 值空图，**不会变更差**。
- **暴露面变化（弱指纹）**：`cpu_cores` 由 admin 可见变为公开可见（`/api/nodes`、`/api/public/agents`）。核数属粗粒度配置信息，Komari 主题本就要显示。

---

## 4. PR2：硬件档案（**碰红线**）

分支：`feat/admin-hardware-profile`（依赖 PR1 先落地）

### 4.1 数据模型与迁移

`agents` 表新增 4 列（静态属性，**不进 metrics 表** —— 避免给两千万行表加列）：

```sql
cpu_vendor      TEXT DEFAULT '',
cpu_tag         TEXT DEFAULT '',
arch            TEXT DEFAULT '',
virtualization  TEXT DEFAULT ''
```

迁移写在 `db.js` 既有幂等迁移段（照 `db.js:372-375` 的 `PRAGMA table_info(agents)` + `ALTER TABLE` 写法），
不写进 `CREATE TABLE`（老库不会重新建表）。

### 4.2 受控候选清单（D4：服务端内置，不联网补全）

```
cpu_vendor : Intel | AMD | Apple | 其他            （空 = 未知）

cpu_tag（按 vendor 联动，粒度到「代」，不含型号）
  Intel : 第3代 第4代 第5代 第6代 第11代 第12代 第13代 第14代 第15代
  AMD   : Zen 2 Zen 3 Zen 4 Zen 5
  Apple : M1 M2 M3 M4
  其他  : （无）

arch            : x86_64 | x86 | arm64 | riscv64 | loongarch64 | 其他
virtualization  : 物理机 | KVM | VMware | Hyper-V | LXC | Docker | 其他
```

> 「其他」= 不精确到具体厂商/微架构 → 不指向具体漏洞配方。

### 4.3 标签合成规则

```
composeCpuName(vendor, tag):
  vendor 空            → ''            （主题显示「未知」）
  vendor 非空、tag 空  → vendor        （如 "Intel"）
  两者都有             → `${vendor} ${tag}`  （如 "Intel 第11代" / "AMD Zen 3" / "Apple M2"）
```

### 4.4 服务端模块契约（新建 `server/src/hardware-profile.js`）

```js
module.exports = {
  CPU_VENDORS,          // string[]
  CPU_TAGS_BY_VENDOR,   // { [vendor]: string[] }
  ARCHS,                // string[]
  VIRTUALIZATIONS,      // string[]
  composeCpuName,       // (vendor, tag) => string
  normalizeProfile,     // (input) => { ok: true, value } | { ok: false, error }
};
```

`normalizeProfile` 校验规则：vendor ∈ `CPU_VENDORS ∪ {''}`；tag ∈ `CPU_TAGS_BY_VENDOR[vendor]`（vendor 为空时 tag 必须为空）；
arch ∈ `ARCHS ∪ {''}`；virtualization ∈ `VIRTUALIZATIONS ∪ {''}`；每字段长度上限 32。

### 4.5 admin 录入链路

| 环节 | 落点 |
|---|---|
| 保存 | `PUT /api/agents/:id`（`api.js:1342-1381`）的 updates 白名单加 4 字段，全部过 `normalizeProfile`；非法 → 400 |
| 候选下拉 | 新增 `GET /api/hardware-options`（`adminOnly`），返回 §4.2 的候选 + §4.3 的说明，供前端下拉渲染（前后端不各存一份候选） |
| 前端 | `web/src/views/admin/AgentDetailView.vue` + `web/src/components/admin/AgentBillingCard.vue` 新增「硬件档案」区块：厂商下拉 → 联动代际下拉 → 架构下拉 → 虚拟化下拉；提示语「手工录入，可能与实际不符」；**允许留空、不逼填** |
| i18n | `zh-CN.ts` / `en-US.ts` 补：区块标题、四个字段名、留空提示、"手工录入可能与实际不符"提示 |

### 4.6 各出口映射（D2=A → 全部公开）

| 出口 | 字段 | 值 |
|---|---|---|
| `/api/nodes`（compat `toNode`） | `cpu_name` | `composeCpuName(a.cpu_vendor, a.cpu_tag)` |
| | `arch` / `virtualization` | `a.arch` / `a.virtualization` |
| | `cpu_cores` | PR1 已做 |
| `/api/v1/nodes`（v1 `toNode`） | `cpu_name` / `arch` / `virtualization` / `cpu_cores` | 同上（`cpu_cores` 用 `null` 兜底语义） |
| `CAPABILITY` | `cpu_name` / `arch` / `virtualization` / `cpu_cores` | 全部 `true` |
| `/api/public/agents`（原生前端） | `cpu_name` / `arch` / `virtualization` | 同上（另加 PR1 的 `cores`） |

### 4.7 原生前端改造（硬件卡不再空）

| # | 位置 | 改动 |
|---|---|---|
| 2.1 | `NodeDetailView.vue:526-537` | 「CPU 型号」块改显示 `agent.cpu_name`（有值显示标签，无值显示「未知」） |
| 2.2 | `NodeDetailView.vue:532-536` | **删除芯片天梯评分条**（恒 0% 灰条 + 「未知」；不做排行） |
| 2.3 | `NodeDetailView.vue:539-547` | `hwDynamic`：`arch` / `virtualization` 改读档案值，**有值才渲染**，无值不占位 |
| 2.4 | `NodeDetailView.vue:539-547` | `hwDynamic` 移除 `gpu_name` / `cpu_physical_cores` 分支（GPU 是红线，永不采；物理核心不可知） |
| 2.5 | `NodeDetailView.vue:590-591` | 系统卡移除「内核版本」条（红线，永不采） |
| 2.6 | `types.ts` | 补 `cpu_name` / `arch` / `virtualization` 字段类型（`cpu_name?` 已存在） |

### 4.8 测试

1. `PUT /api/agents/:id` 接受合法档案；非法枚举 / 越界长度 → 400
2. 留空合法（全部字段可空）
3. 兼容层 `toNode().cpu_name` 合成正确（"Intel 第11代" / "Intel" / ""）
4. `CAPABILITY` 四个字段为 true
5. `GET /api/hardware-options` 返回候选
6. 备份/恢复往返后档案字段不丢

---

## 5. 文档修订清单（PR2 必须同步，**改动量不小于代码**）

| 文件:行 | 现状 | 改为 |
|---|---|---|
| `README.md:528` | 对照表「✅ 不采内核版本、CPU 型号、GPU」 | 「✅ 不自动采集；硬件标识仅管理员手工录入粗粒度标签」 |
| `README.md:536` | 「不因单点可否被直接利用而开口子」 | 保留纪律本身，补充：受控端侧绝不开口；服务端侧的口子仅限「人工录入 + 粗粒度」 |
| `README.md:538` | 补充说明（`hostname`/`os` 属轻量标识） | 追加：硬件档案同属「人工录入的轻量标识」，非系统采集 |
| `README.md:544` | 场景①「基础状态含非指纹指标，无指纹」 | 「无自动采集的个体级指纹（人工录入的粗粒度标签除外）」 |
| `README.md:564` | 三个诚实的说明①采集集合 | 追加硬件档案一条 |
| `README.md:566` | 「新增采集字段需要重新做安全评审」 | 保留；补「人工录入字段的评审标准：粒度、是否公开、是否可被自动采集」 |
| `README.md:581` | 对照表「聚类风险 ❌ 无（不采内核/CPU型号…）」 | 「❌ 无自动采集的聚类指纹（人工录入的代际级标签不指向具体微架构）」 |
| `docs/security.md:32` | 「内核版本 / CPU 型号 / GPU 型号（可匹配漏洞的指纹）」 | 区分「自动采集」与「人工录入的粗粒度标签」 |
| `docs/security.md:45-47` | 聚类风险论述 | 补：代际级标签不满足「同型号=同漏洞面」，故不构成聚类指纹 |
| `server/public/themes/README.md` | 字段可用性说明 | 新增「字段可用性」小节：哪些有值、哪些恒空、为什么（供拿到 Komari 模板的用户对照） |

---

## 6. 验收清单

**PR1（2026-10-29 已实施并验证）**
- [x] `/api/nodes` 的 `cpu_cores` 等于 `agents.cores`（未上报为 0）
- [x] `/api/nodes` 的 `kernel_version` 为 `''`（不再是 hostname）
- [x] `/api/recent/:uuid`、WS 快照的 `process` 为真实值（非 0）
- [x] 扁平实时态 `temp` 为真实值
- [x] `public_show_business=false` 时 `price` 为 -1、`billing_cycle` 为 30
- [x] `billing_cycle=0`（白嫖）未被换成 30
- [x] `/api/public` 的 `chartDashboardTemplate.cards` 不含 `gpu`/`gpuMemory`/`connections`
- [x] `/api/v1/nodes/:uuid/capability` 的 `cpu_cores` 为 `true`
- [x] 原生前端节点页显示「核心数」
- [ ] 挂一个 Komari 社区皮肤：节点卡片显示核数/进程数/温度/价格，**不需改主题源码**
  → 2026-10-29 **部分达成**（komari-theme-Glassmorphism v3.4.4 真实产物）：卡片价格/周期/CPU/内存/磁盘/流量正常，详情页硬件卡显示「(4 vCPU)」，内核版本不再显示主机名；**图表区仍空**，见下「联调遗留」。

> 验证记录（2026-10-29）：
> - 自动化：`server/test/compat-fields.test.js`（9 项）新增，全量 `npm test` 622/622 通过；前端 `vue-tsc -b && vite build` 通过。
> - 真实数据：以生产库副本在 8091 起隔离实例，三台节点实测 —— `/api/nodes` `cpu_cores=4`、`kernel_version=''`、`j4125 price 0→-1`、`billing_cycle=-1` 原样保留、`currency` 取真实值（n5100 `$`）；`/api/v1/nodes` `kernel=null`、`hostname` 独立有值、`process` 真实（298/120/282）；`capability.cpu_cores=true`；`cards` 已去除三张空图；`/api/public/agents` `cores=4`；`/api/recent` `process` 真实。
> - 浏览器可视化（2026-10-29 补做，playwright 1.64 + chromium）：原生详情页 `/node/:id` 硬件卡显示「核心数 4」，内核版本显示「—」；CPU 型号/天梯条仍为空（PR2 范围）。
> - **真实社区皮肤联调（2026-10-29）**：安装 komari-theme-Glassmorphism v3.4.4 正式产物到运行时主题目录（`<DB 同级>/themes/Glassmorphism`），未改主题源码（仅部署时把 dist/index.html 的绝对 `/assets/` 前缀重写为 `/themes/<short>/assets/`，属部署适配）。
>   联调中发现并修复 4 处服务端缺陷：
>   1. **Komari 格式主题默认不放宽 CSP** → 内联脚本被拦、Iconify/汇率请求被阻（`komari-theme.json` 不含 `diting.*` 字段）；
>   2. **`/themes/<short>/` 带尾斜杠 404**（被 `/themes/<id>/(.*)` 路由吃掉后越界误判）；
>   3. **`public:queryMetrics` 返回 `{start,end,series}` 信封**，而 Komari 返回 `[]publicMetricSeries` 裸数组；
>   4. **`common:getRecords(type=load)` 返回 `{records}` 信封**，Komari 返回 `[]flatRecord`（扁平字段 cpu/ram/…）；顺带修正 `RECORD_FIELD_MAP` 里 swap 误指内存列。
> - **联调遗留（2026-10-29 进展）**：负载图 6 张（CPU/负载、内存与 Swap、磁盘、实时网络、网络连接、进程）**已全部渲染**。
>   关键结论：`public:queryMetrics` 必须保持 `{ start, end, series }` 信封 —— 主题 LoadChart 直接读 `o.series`；
>   先前按 Komari Go 侧结构改成 `[]publicMetricSeries` 裸数组，实测反而让六张负载图全空（已回退）。
>   即「以真实主题行为为准」，不能只看后端 Go 结构。
> - **仍未解决**：延迟图（PingChart）恒「暂无延迟数据」。已确认 `public:getPingMetricStats` 的 stats（4 task，total>0）
>   与 `queryMetrics(ping.latency_ms)` 的 series（3 task，各 30–60 点）两侧 task 集合可对齐，
>   但主题内部 `Ye()/Ce()/Pe()` 归一化链（位于 v3-services 与其它 chunk，压缩后同名函数跨 chunk 重名干扰静态分析）
>   仍返回空 —— 建议直接对照 Glassmorphism 源码仓库的 PingChart 实现继续，而不是继续猜压缩产物。

**PR2**
- [ ] admin 可录入厂商+代际+架构+虚拟化；留空合法
- [ ] 非法枚举被拒（400）
- [ ] `/api/nodes` 的 `cpu_name` 为「Intel 第11代」形态，**不含精确型号**
- [ ] 原生前端详情页：显示档案标签、无天梯条、无恒空「—」条目、无内核版本条
- [ ] 备份/恢复往返后档案字段不丢
- [ ] §5 清单逐条核对完成

---

## 7. 风险登记与回滚

| 风险 | 影响 | 缓解 | 回滚 |
|---|---|---|---|
| 公开层新增指纹面（粗粒度标签 + 核数） | 访客可见 | 粒度限定厂商+代际；D2 已拍板公开；文档写明 | PR1/PR2 各自独立提交，可单独回退 |
| 录入值与实际漂移 | 面板显示过期信息 | 编辑页提示「手工录入，可能与实际不符」；不做自动校验 | 清空字段即可 |
| 备份文件含该列 | 备份外流即泄露标签 | 无法避免（DB 全量导出），文档承认 | — |
| 兼容层字段语义漂移 | 主题渲染错值 | 沿用「宁可缺图，不可错值」（`compat-metrics.js:36-40`）；`kernel_version` 宁可空 | 逐条独立提交 |
| 能力声明与实际不符 | 模板隐藏已有字段 / 显示空字段 | PR1.10 + PR2 同步改 CAPABILITY，并加断言测试 | — |
| 老主题依赖被移除的卡片 | 极老主题渲染异常 | 三张卡原本就是空图，移除只减少空图 | 单条 revert |

---

## 8. 明确不做

- 不动 agent 采集面（不读 `model name`、不读 `/proc/cpuinfo` 的型号行）
- 不采精确 CPU 型号、GPU 型号、内核版本、连接数、进程明细
- 不做芯片天梯 / 排行 / 评分
- 不改 Komari 主题源码（目标是**让模板不改就能用**）
- 不把硬件档案喂进 AI prompt（现状本就不喂，`ai/prompt.js` 只取聚合统计 + 计费）
- 不主动升服务端版本 / 打 tag（等明确发版指示）

---

## 9. 分支、提交与合并

| 分支 | 内容 | 合并方式 |
|---|---|---|
| `docs/komari-compat-plan` | 本方案文档（评审用） | 评审通过后随 PR1 一起进 master |
| `feat/compat-field-mapping` | PR1 全部改动 | **单次 squash 合并** |
| `feat/admin-hardware-profile` | PR2 全部改动（依赖 PR1） | **单次 squash 合并** |

规则：master 不直接提交；一轮工作合入 master 时全部改动 squash 成**一个提交**。
