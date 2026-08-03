# diting 适配 Komari 系列皮肤 — 方案设计文档

---

## 一、方案选型：A/B/C 三方案对比

### 方案 A：直接改动 diting 项目

在 diting 的 server.js 和 src/ 中直接添加 Komari 协议兼容代码。

| 维度 | 评估 |
|---|---|
| 实现难度 | 低（已完成） |
| 部署复杂度 | 单进程 |
| WebSocket | 直连，零延迟 |
| 数据访问 | 直读 SQLite |
| 安全边界 | 监控+主题混排，攻击面叠加 |
| 故障影响 | 主题 bug 可能影响监控 |
| 代码维护 | diting 仓库膨胀 |
| 升级风险 | diting 升级可能破坏适配 |
| 结论 | ❌ 不推荐（用户已否定：改动太大、安全下降、需跟随 Komari 升级） |

### 方案 B：独立 adapter 透传代理

新建独立服务，对 Komari 主题透明代理到 diting 现有 API。

| 维度 | 评估 |
|---|---|
| 实现难度 | 中 |
| 部署复杂度 | 二进程 |
| WebSocket | 代理转发，有跳 |
| 数据访问 | 调 diting REST API |
| 安全边界 | 隔离 |
| 故障影响 | 主题崩了监控照常 |
| 结论 | ⚠️ 可用但不解决核心问题（字段缺失仍需处理） |

### 方案 C：标准 API + 翻译层 + 模板改写（✅ 推荐）

三层分工：

| 层 | 职责 | 改动 |
|---|---|---|
| diting | 设计标准 API（参考 Komari 设计，保持 diting 语义） | ~50 行 |
| adapter | 独立仓库，协议翻译（Komari ↔ diting） | 新建项目 ~300 行 |
| 模板 | 缺字段图表删除或显示 `--` | 改 Glassmorphism 源码 |

| 维度 | 评估 |
|---|---|
| diting 攻击面 | 零增长 |
| Komari 升级 | 只改 adapter 配置 |
| 字段缺失 | adapter 标记 capability，模板隐藏 |
| 结论 | ✅ 推荐 |

### 方案对比总结

| 维度 | A | B | C |
|---|---|---|---|
| diting 代码改动 | +200 行 | 0 | +50 行 |
| diting 绑定 Komari | 强 | 无 | 弱 |
| 安全影响 | 攻击面叠加 | 无 | 零增长 |
| Komari 升级适配 | 改 diting | 改 adapter | 改 adapter 配置 |
| 用户决策 | ❌ 已否决 | ⚠️ 备选 | ✅ 最终选择 |

---

## 二、C 方案架构

```
┌─────────────────┐     ┌──────────────────────┐     ┌─────────────────┐
│  Komari 社区模板  │────▶│  theme-adapter        │────▶│  diting          │
│  (不做任何修改)   │     │  (独立仓库)            │     │  (标准 API)       │
│                  │◀────│                       │◀────│                  │
└─────────────────┘     └──────────────────────┘     └─────────────────┘
        ▲                        ▲                         ▲
        │                        │                         │
   期望 Komari 格式         翻译/补全/删减              标准 REST/WS
   (RPC2、嵌套结构)         ↓ 转换                      (diting 风格)
                             参数名映射
                             缺失字段处理
```

---

## 三、diting 侧：标准 API 设计

### 设计原则

| 原则 | 说明 |
|---|---|
| RESTful 资源 | /nodes、/nodes/{id}、/metrics |
| 统一响应信封 | { code, data, message } |
| 字段语义清晰 | ram.used / ram.total |
| 支持时间范围查询 | ?hours=24&max_points=100 |
| 明确"无数据"语义 | null = 不支持，0 = 值为 0 |

### 新增 API 端点

```
GET /api/v1/nodes                节点列表
GET /api/v1/nodes/{uuid}         单节点详情
GET /api/v1/nodes/{uuid}/metrics 时序指标
GET /api/v1/nodes/{uuid}/records 历史记录
GET /api/v1/nodes/{uuid}/capability 能力声明
GET /api/v1/sites                站点公开信息
WS  /api/v1/stream               实时推送
```

### 响应格式

```json
{
  "code": 0,
  "message": "",
  "data": [{
    "uuid": "agt_xxx",
    "name": "test-agent",
    "os": "Debian GNU/Linux 13",
    "kernel": "J4125",
    "gpu": { "model": "None", "count": 0, "detailed_info": [] },
    "ram": { "total": 8161542144, "used": 5347319808 },
    "connections": { "tcp": null, "udp": null },
    "process": null,
    "temperature": 45,
    "online": true,
    "ping": { "task_1": { "latest": 23, "avg": 25, "loss": 0 } }
  }]
}
```

### diting 侧改动

| 文件 | 改动 |
|---|---|
| server/src/compat.js | 新增 /api/v1/* 标准接口 |
| server/src/db.js | 新增 getNodeMetricsRange()、getNodeRecords() |
| server/server.js | 挂载 /api/v1 路由 |
| toNode() | 返回 kernel 字段（如实填 hostname） |
| toRealtime() | 返回 connections: null、process: null |

---

## 四、adapter 侧：字段翻译表

### 节点基础信息

| Komari 字段 | diting 来源 | 缺失时处理 |
|---|---|---|
| uuid | a.id | 必填 |
| name | a.name | 必填 |
| cpu_name | 无 | 模板隐藏 |
| virtualization | 无 | 删除 |
| arch | 无 | 删除 |
| cpu_cores | 无 | 删除或 `--` |
| os | a.os | 有值 |
| gpu_name | 无 | 模板隐藏 GPU 卡片 |
| region | a.country | flagEmoji |
| mem_total | m.mem_total | 有值 |
| swap_total | m.swap_total | 有值 |
| disk_total | m.disk_total | 有值 |
| expired_at | a.expire_at | 有值 |
| created_at | a.created_at | 必填 |
| updated_at | a.last_seen | 必填 |

### 实时状态

| Komari 字段 | diting 来源 | 缺失时处理 |
|---|---|---|
| cpu.usage | m.cpu | 有值 |
| ram.used/total | m.mem_used/total | 有值 |
| swap.used/total | m.swap_used/total | 有值 |
| load.load1/5/15 | m.load1/5/15 | 有值 |
| disk.used/total | m.disk_used/total | 有值 |
| network.up/down | m.net_tx_rate/net_rx_rate | 有值 |
| network.totalUp/Down | m.net_tx_month/net_rx_month | 有值 |
| connections.tcp/udp | 无 | **null** → 模板删除 |
| gpu.count | 无 | **0** → 模板删除 |
| gpu.detailed_info | 无 | **[]** → 模板删除 |
| uptime | m.uptime | 有值 |
| process | 无 | **null** → 模板删除 |
| temperature | m.temp | null 时 `--` |
| ping | probes JSON | 翻译格式 |

### Ping 记录

| Komari 字段 | diting 来源 |
|---|---|
| client | agent_id |
| task_id | probe label |
| time | ts → ISO |
| value | probes[label].ms |

---

## 五、Glassmorphism 模板改动清单

### 需删除的图表卡片

| 组件 | 原因 |
|---|---|
| GPU 相关图表 | 无 GPU 数据 |
| connections 图表 | 无连接数 |
| process 图表 | 无进程数 |

### 需显示 `--` 的字段

| 位置 | 字段 | 条件 |
|---|---|---|
| 节点卡片 | CPU 型号 | cpu_name === "" |
| 节点详情 | 温度 | temp === null |
| 节点详情 | 连接数 | connections === null |
| 节点详情 | 进程数 | process === null |

### 需修改的预设配置

| 文件 | 改动 |
|---|---|
| config.yaml | 删除 GPU/connections/process 预设 |
| METRIC_DEFINITIONS | 标记不支持 |
| chartDashboardPreset | 移除不支持的卡片 |

---

## 六、adapter 项目结构

```
komari-theme-adapter/
├── config/
│   ├── field-map.yaml             # 字段映射表
│   ├── missing-strategy.yaml      # 缺失策略
│   └── capability.yaml            # diting 能力声明
├── src/
│   ├── server.js                  # Express 入口
│   ├── translator/
│   │   ├── node.js                # 节点翻译
│   │   ├── realtime.js            # 实时翻译
│   │   ├── records.js             # 历史翻译
│   │   ├── metrics.js             # 指标翻译
│   │   └── ping.js                # 探针翻译
│   ├── proxy/
│   │   ├── rest.js                # REST 代理到 diting
│   │   └── ws.js                  # WebSocket 代理
│   └── static/                    # 主题静态资源
└── themes/
    ├── glassmorphism/
    └── official/
```

---

## 七、安全约束

| 约束 | 位置 |
|---|---|
| 严格 CSP | diting 所有页面 |
| 放宽 CSP | 仅 adapter 社区主题页 |
| RPC 只读 | adapter 方法表 |
| public_enabled 门控 | adapter 透传 |
| 时序查询上限 | hours≤720, maxCount≤5000 |
| IP 白名单豁免 | /me /nodes /recent /version /rpc2 |
| WS 限流共用 | adapter 若自建 WS |

---

## 八、落地步骤

| 步骤 | 内容 | 工作量 |
|---|---|---|
| 1 | diting 侧 /api/v1/* 标准接口 | 1 天 |
| 2 | adapter 仓库 + 翻译层 | 2 天 |
| 3 | Glassmorphism 模板改动 | 1 天 |
| 4 | 联调验证 | 0.5 天 |
| 总计 | | 4.5 天 |

---

## 九、已实现的 A 方案代码（参考基础）

| 文件 | 功能 | 状态 |
|---|---|---|
| server/src/compat.js | REST 兼容层 | ✅ |
| server/src/compat-rpc.js | JSON-RPC 网关（20 方法） | ✅ |
| server/src/compat-metrics.js | Metric API（12 指标） | ✅ |
| server/server.js | CSP + SPA fallback + WS | ✅ |

---

## 十、决策记录

| 轮次 | 决策 | 理由 |
|---|---|---|
| 1 | 放弃 A 方案 | diting 改动太大、安全下降 |
| 2 | 选择 C 方案 | 隔离清晰、独立演进 |
| 3 | 字段缺失处理 | adapter capability + 模板删除/`--` |
| 4 | GPU/连接数/进程 | diting 不采集，模板删除 |

---

*文档生成时间：2026-08-03*
