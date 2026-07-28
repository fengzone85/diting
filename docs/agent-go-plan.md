# Go 受控端重构方案

> 最后更新：2026-07-29
> 状态：**已编码并本机实测通过**（Linux 全字段采集、与 Python 版口径一致、自适应上报生效）

---

## 一、整体架构

```
main.go              入口 / 配置加载 / signal.NotifyContext 优雅退出 / 主循环（time.After 动态间隔）
adaptive.go          纯本地自适应上报间隔决策（不解析服务端响应）
config/config.go     环境变量 + 默认值（含 HTTPS 强制校验、自适应开关）
collector/           cpu / mem / disk / diskio / load / network / uptime / system / probe（标准库直读 /proc）
reporter/            http（headers+timeout+可选 gzip）/ 退避（可被 ctx 取消）/ 单向上报（不缓存重发）
state/               月累计持久化（首跑守卫 + 跨月重置 + 原子写）
```

**依赖决策（已落地，与原方案有调整）：**

- **零外部依赖**：`go.mod` 仅 `module` + `go 1.22`，无任何 `require`。原方案设想的 `caarlos0/env/v6`、`gopsutil`、`pro-bing` 全部**未采用**——配置用标准库 `os.Getenv` 自写解析，采集直读 `/proc`，探测走 `net.DialTimeout` TCP 优先回退，进一步缩小攻击面、加速交叉编译。
- 不用 `gopsutil` — 直读 `/proc`，零 cgo，数值与 Python 逐字段一致。
- 不用 `pro-bing` — 探测走 TCP 优先回退，ICMP 仅作可选增强（未实现，TCP-only 零 cap）。
- 用 `log`（标准库）+ `net/http` 标准库。

**构建**：`CGO_ENABLED=0`（静态二进制，实测 ~5.2MB）；`Makefile` 用 `-X main.version` 注入版本号（注意 `main.version` 须为 `var` 非 `const`，否则 ldflags 注入无效）。

---

## 二、服务端契约（必须对齐）

### 上报字段完整列表

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cpu` | float64 | ✅ | 使用率百分比 |
| `mem_used` | uint64 | ✅ | 已用字节 |
| `mem_total` | uint64 | ✅ | 总字节 |
| `mem_pct` | float64 | ✅ | 百分比 |
| `disk_used` | uint64 | ✅ | 已用字节 |
| `disk_total` | uint64 | ✅ | 总字节 |
| `disk_pct` | float64 | ✅ | 百分比 |
| `load1` | float64 | ✅ | 1 分钟负载 |
| `load5` | float64 | ✅ | 5 分钟负载 |
| `load15` | float64 | ✅ | 15 分钟负载 |
| `net_rx_rate` | float64 | ✅ | 接收速率 B/s |
| `net_tx_rate` | float64 | ✅ | 发送速率 B/s |
| `net_rx_month` | uint64 | ✅ | 月累计接收 |
| `net_tx_month` | uint64 | ✅ | 月累计发送 |
| `uptime` | float64 | ✅ | 运行秒数 |
| `os` | string | ✅ | 系统发行版（touchAgent 写入） |
| `hostname` | string | ✅ | 主机名（touchAgent 写入） |
| `swap_used` | uint64 | ✅ | Swap 已用 |
| `swap_total` | uint64 | ✅ | Swap 总量 |
| `swap_pct` | float64 | ✅ | Swap 百分比 |
| `disk_r_rate` | float64 | ✅ | 磁盘读速率 |
| `disk_w_rate` | float64 | ✅ | 磁盘写速率 |
| `temp` | *float64 | ❌ | 温度（无传感器时 null） |
| `probes` | map | ❌ | 探测结果 |
| `disks` | []DiskInfo | ❌ | 多盘详情 |

**注意（已对齐）：**

- 核心标量**禁止 `omitempty`**（缺 `cpu`/`mem_total` 服务端直接 400）。
- `temp` 用 `*float64` 允许 `null`（唯一可空标量）。
- `probes.Ms` 用 `*float64` 且**不带 `omitempty`** —— 不可达时发 `"ms":null`（与 Python wire format 对齐，服务端 `validate.js` 接受 `undefined`/`null` 不 400）。
- **不发送 `ts`** — 服务端用 `Date.now()` 自生成。

### 上报 Header

```
Content-Type: application/json
Authorization: Bearer <token>
X-Agent-ID: <agent_id>
User-Agent: diting-agent-go/<version>
```

---

## 三、采集实现

### CPU（需要前次样本）

```go
type cpuSample struct{ total, idle uint64 }

func (c *Collector) CPU() (float64, error) {
    // 读 /proc/stat 第一行: cpu user nice system idle iowait irq softirq steal guest guest_nice
    // total = sum(全部数值列)  ← 必须包含 steal/guest/guest_nice
    // idle = col4(idle) + col5(iowait)
    // 与 prev 算差值: 1 - dIdle/dTotal
}
```

**关键：** 构造时 prime 一次；首次上报允许为 0；`total` 必须包含所有列，否则 CPU% 偏差。

### 内存

```go
func (c *Collector) Mem() (used, total, pct float64) {
    // 读 /proc/meminfo
    // total = MemTotal
    // available = MemAvailable（不存在时回退 free+buffers+cached）
    // used = total - available
    // pct = used / total * 100
}
```

### 磁盘（单盘 + 多盘，最难对齐，已与 Python 一致）

复刻 Python `collector.py:75-154`：

1. 读 `/proc/mounts`（容器内优先 `/hostproc/mounts`，回退 `/proc/mounts`）
2. `REAL_FS` 过滤：`ext2/3/4, xfs, btrfs, f2fs, reiserfs, jfs, nilfs2, vfat, ntfs, exfat, zfs`
   - **排除 tmpfs**（内存盘不算硬盘）
   - **用 vfat 非 fat32**
3. 按 `st_dev` 去重（同盘多挂载合并）
4. 跳过 `ram/loop/zram/dm-/md` 虚拟设备
5. `/host` 前缀还原
6. 顶层 `disk_used/total` 取 `DISK_PATH` 聚合（`DISK_PATH` 不存在回退 `/`）
7. 同时返回 `[]DiskInfo`，约束：≤32 项、pct round 2 位、**mount≤200 字符**（Go 侧主动截断，与服务端 `validate.js:110` 对齐）
8. **块大小用 `st.Frsize`**（POSIX 规定的 `f_blocks/f_bfree` 计数单位），对齐 Python `f_frsize` —— 避免某些网络 FS 下 `Bsize≠Frsize` 导致数值偏差

### 磁盘 IO

```go
func (c *Collector) DiskIO() (readRate, writeRate float64) {
    // 读 /proc/diskstats
    // parts[5] = 读扇区数, parts[9] = 写扇区数
    // 字节 = 扇区 × 512
    // 跳过 ram/loop/zram 前缀、dm- 前缀(用 HasPrefix 精确匹配)、md 前缀
    // 与 _prev 算速率差值
}
```

### 网络

```go
func (c *Collector) Network() (rxRate, txRate float64, rx, tx uint64) {
    // 读 /proc/net/dev
    // 排除 lo，累加各接口（fields[0] 收 / fields[8] 发）
    // 与 _prev 算速率差值
}
```

### 探测（对齐 Python，并发模式）

```go
type ProbeTarget struct {
    Label string `json:"label"` // ≤24 字符
    Host  string `json:"host"`  // ≤253 字符
    Port  int    `json:"port"`  // ∈[1,65535]，默认 53
}

func (c *Collector) Probes(targets []ProbeTarget) map[string]Probe {
    // ≤8 个目标
    // 默认 TCP 回退：依次试 目标端口/443/80
    // 每个目标重试 3 次吸收抖动
    // sync.WaitGroup + goroutine 并发
    // net.DialTimeout("tcp", target, 2.5s) 握手时延 ×1000→ms
    // 失败静默回退 TCP
}
```

**输入校验（硬化解析）：** `parseProbeTarget` 校验 port∈[1,65535]、host 正则 `^[a-zA-Z0-9.\-:]+$`、长度 ≤253、label ≤24 字符。

**结果结构：**

```go
type Probe struct {
    Ok bool     `json:"ok"`
    Ms *float64 `json:"ms"`   // *float64 保留小数精度；不可达时 null（不带 omitempty，与 Python 对齐）
}
```

**PROBE_TARGETS 语义（已修正）：** 用 `os.LookupEnv` 区分"未设"与"空" —— 未设用默认三家运营商 DNS+8.8.8.8；**显式设空 `PROBE_TARGETS=""` 可关闭探测**（避免 getEnvDefault 把空当未设而回退默认导致无法关）。

---

## 四、状态持久化

```go
type State struct {
    HasPrev  bool   `json:"has_prev"`  // 首跑守卫，避免流量尖峰
    LastRx   uint64 `json:"last_rx"`   // 上次累计 rx（算差值用）
    LastTx   uint64 `json:"last_tx"`
    MonthKey string `json:"month_key"` // "2026-07"，变更即重置
    MonthRx  uint64 `json:"month_rx"`
    MonthTx  uint64 `json:"month_tx"`
}
```

**累加逻辑：** 跨月重置；首跑只设 `LastRx/Tx` 不累加（避免巨大尖峰）；`rx>LastRx` 才累加差值。

**原子写入：** `MkdirAll(0o700)` + `WriteFile(.tmp, 0o600)` + `Rename`；断电后 state.json 不损坏。

---

## 五、上报与退避

### HTTPS 强制

```go
func (c *Config) Validate() error {
    u, err := url.Parse(c.ServerURL)
    // 仅允许 localhost/127.0.0.1/::1 使用 http
    // 非 http/https scheme 直接拒
}
```

### 退避策略

| 场景 | 退避 | 可取消 |
|------|------|--------|
| 401/403 | 10 分钟（token 静态不可自愈） | ✅ ctx 取消即退出 |
| 网络错误 | `2^attempt * INTERVAL`，封顶 30s，最多 3 次 | ✅ ctx 取消即退出 |
| 成功 | 立即重置 | — |

**关键修复（2026-07-29）：** 所有退避改用 `select { case <-time.After(backoff): case <-ctx.Done(): return ctx.Err() }`，使 SIGTERM 能及时退出，不再因 10 分钟 authBackoff 卡死被 `docker stop` 超时 SIGKILL。

### gzip 上报（默认关，保留开关）

- `GZIP=1` 开启请求体 gzip 压缩并带 `Content-Encoding: gzip`。
- **服务端 Express 默认 `express.json()` 不解压 gzip 请求体**，开启前必须先给服务端配置请求体解压中间件，否则上报被 400 拒收。
- 默认（关）明文 JSON，与 Python 版一致，服务端正常解析。

---

## 六、自适应上报间隔（纯本地，不破安全边界）

> 设计决定：拒绝"服务端回传 viewers 让 agent 切档"的方案（那会开下行数据通道，违背 diting「agent 不解析响应」核心安全模型）。改为 **agent 本地对比相邻两轮指标变化率自行决策**，完全不碰服务端响应。

### 决策逻辑（`adaptive.go`）

```go
func adaptiveInterval(prev, cur *Metrics, fast, slow time.Duration, streak *int) time.Duration {
    if cur == nil { return fast }          // 采集失败 → 快档重试
    if prev == nil { *streak = 3; return fast } // 首报 → 快档建基线
    if *streak > 0 { *streak--; return fast }   // 防抖：快档未满 3 轮继续快档
    // 触发快档的显著变化：
    if absf(cur.CPU-prev.CPU) > 15      { *streak = 3; return fast } // CPU 变化 >15 个百分点
    if dMem/cur.MemTotal > 0.15         { *streak = 3; return fast } // 内存相对变化 >15%
    if cur.NetRxRate > 100KB && changeRatio(prev,cur) > 1.0 { *streak = 3; return fast }
    if cur.NetTxRate > 100KB && changeRatio(prev,cur) > 1.0 { *streak = 3; return fast }
    if cur.Load1-prev.Load1 > 1.0       { *streak = 3; return fast } // 负载突增 >1.0
    return slow
}
```

- **默认档位**：快档 `FAST_INTERVAL=10s`，慢档 `SLOW_INTERVAL=60s`；`ADAPTIVE=0/false` 关闭改固定 `INTERVAL`（默认 20s，最小 5s）。
- **防抖**：进入快档后至少保持 3 轮，避免边界抖动反复切换。
- **首报强制 3 轮快档**：快速建基线。

### changeRatio 边界修正（2026-07-29 审查修复）

```go
func changeRatio(prev, cur float64) float64 {
    if prev <= 0 { return 2.0 } // prev=0 且 cur 大时，必须 >1.0 才能触发快档
    return math.Abs(cur-prev) / prev
}
```

原实现返回 `1.0`，导致 `prev=0`（从无流量）且 `cur` 大时 `1.0>1.0=false` **漏触发**快档；改为 `2.0` 修复。配合 `cur>100KB/s` 前置条件，仅"当前有大流量且之前无"才触发，不会误触。

### 配套服务端配置（必须）

- 慢档 `60s` 会撞服务端默认 `OFFLINE_THRESHOLD_SEC=60`，需将服务端 `.env` 改为 `OFFLINE_THRESHOLD_SEC=120`（或 >慢档）。该改动**不破 agent 边界**（agent 仍纯单向）。
- 主循环用 `time.After(next)` 每轮新建定时器（消除 `Ticker.Reset` 在 runOnce 耗时>间隔时的 channel 积压导致间隔失真）。

### 实测（2026-07-29，本机 J4125）

- 快档期 `decided=10s wait=10s`，连续 3 轮防抖 ✓
- 平稳后 `decided=1m0s wait=1m0s` 切慢档 ✓
- 变化（CPU/网络/负载）拉升时切回快档 ✓
- 不解析服务端响应，纯单向上报 ✓

> 注：测试环境"移动"DNS 不可达，`probeOne` 重试 3×端口×2.5s 耗满 ~22.5s，使单轮 runOnce 偏长；生产探测目标可达时 <2.5s，间隔正常。后续可优化探测超时/重试数。

---

## 七、安全模型

| 维度 | 要求 |
|------|------|
| 镜像 | `scratch`（静态 CGO_ENABLED=0） |
| 用户 | `USER 1000`，构建期 `chown 1000 /data` |
| 能力 | `--cap-drop=ALL`（TCP 探测零 cap） |
| 网络 | bridge 网络，读 `/hostproc/net/dev` 拿真实流量（TCP 探测无需 host） |
| 挂载 | `-v /:/host:ro -v /proc:/hostproc:ro -v diting-state:/data` |
| Token | 仅 env/内存、只经 HTTPS、不落盘 |
| DEBUG | 不打印 token |
| ICMP | 默认 TCP-only（零 cap）；ICMP 作可选构建变体 |
| **响应体** | **从不解析/不执行（单向上报）；自适应也纯本地，不破此边界** |
| **入站端口** | **零** |
| **指令通道** | **无** |

---

## 八、代码审查与修复记录（2026-07-29）

### 第一轮审查（10 项，全部修复并实测验证）

| # | 级别 | 问题 | 修复 |
|---|------|------|------|
| 1 | 阻断 | gzip 默认开 → 服务端 `express.json()` 不解压 → 全量 400 | 默认关，新增 `GZIP=1` 开关（`reporter.go`+`config.go`+`main.go`） |
| 2 | 阻断 | 磁盘用 `st.Bsize` 非 `st.Frsize`，网络 FS 下与 Python 偏差 | `disk.go` 两处改 `st.Frsize` |
| 3 | 阻断 | `const version` 导致 ldflags `-X` 注入无效 | `main.go` 改 `var version` |
| 4 | 高优 | 退避 `time.Sleep` 阻塞 → SIGTERM 无响应被 SIGKILL | `Report` 收 `ctx`，退避改 `select{After/Done}` |
| 5 | 高优 | pending 缓存重发 → 旧 payload 被 `Date.now()` 当当前时刻入库错位 | 移除 pending 缓存，每轮独立上报 |
| 6 | 低优 | `probes.Ms` 带 `omitempty` 与 Python wire 略异 | 去 `omitempty`，发 `null` |
| 7 | 低优 | `strings.Contains(dev,"dm-")` 误伤含 `dm-` 设备名 | 改 `HasPrefix(dev,"dm-")` |
| 8 | 低优 | `2500*1000*1000` 可读性差 | 改 `2500*time.Millisecond` |
| 9 | 低优 | 多盘 mount 未截断，与服务端 slice(0,200) 不一致 | Go 侧主动 `[:200]` |
| 10 | 低优 | 三处版本号不一致 | 统一 `1.0.0`；`main.version` 单一来源透传 `User-Agent` |

### 第二轮审查（自适应专项）

| # | 级别 | 问题 | 处理 |
|---|------|------|------|
| #1 | 误报 | 审查称"mem 15% 对小内存过灵敏" | **不成立**：15% 是相对总内存比例，小内存 cache 波动绝对值更小反而更难触发，保守阈值正确，不改 |
| #2 | 可接受 | `time.After` timer 在 ctx 取消后存活到 backoff 到期 | 无实际影响（diting ctx 取消=进程退出，timer 随进程消失），不改 |
| #3 | 真 bug | `changeRatio` `prev<=0` 返回 1.0 致"从无流量到大流量"漏触发快档 | **已修**：返回 `2.0`，`go vet`+`go build` 通过 |

### 本机实测结论

- `go vet` / `go build` 全绿（go1.22.5）。
- Go agent（独立 `AGENT_ID=agt_3bc5b25d3062`）直连本机 `node server.js:8081`，全字段入库，无 400。
- **与 Python 版（`agt_5f4f4bfd979b`）并行口径一致**：`mem_total`/`disk_total`/`swap_*` 完全相同，`mem_used`/`uptime`/`temp`/`cpu` 因采样时刻不同略有差异但量级一致。
- 自适应快→慢切换、防抖、差值速率（`net_rx_rate`/`disk_w_rate`）、月累计累加、`state.json` 原子持久化、首跑无尖峰全部验证生效。

---

## 九、安全模型对比（vs Pulse / Nezha 等）

| 维度 | 指令通道型探针（Nezha/Komari/Pulse） | 谛听（正确） |
|------|-------|-------------|
| 认证 | 共享 secret + query 传 token + 空 secret 无认证（Pulse） | 每 agent 独立 token + SHA-256 + 恒定时间比较 |
| 传输 | 不强制 HTTPS（Pulse） | 强制 HTTPS（非 localhost/127.0.0.1/::1 拒 http） |
| 指令通道 | 服务端下发命令/探测目标 + 监听入站端口 | 零入站、无指令通道、探测目标本地写死 |
| 响应解析 | agent 执行服务端返回（Nezha `CommandTask`→`sh -c`） | **从不解析/不执行响应**（含自适应也纯本地） |
| 指纹采集 | CPU 型号、虚拟化、公网 IP、位置 | 只采性能数据，禁止任何指纹 |
| 依赖 | gopsutil + shell-out | 直读 /proc，零外部依赖 |

**结论：** Nezha 系"高 root agent + 指令通道 + 弱保护"已爆 0day（2026 年 NEZHA-AGENT-001 无需认证即 root RCE、CVE-2026-46716 跨租户 RCE）；谛听靠"不解析响应 + 零入站 + 无指令通道"从架构切断"0day→root RCE"链路，自适应上报仍守此边界。

---

## 十、迁移注意

- Go 与 Python **不得共用同一 `AGENT_ID`**（否则 `last_seen`/指标互相覆盖）。
- 对比时注册**两个独立 agent**并排看。
- 现有 Python 版保留，随时可切回。

---

## 十一、验证清单

| 检查项 | 方法 | 状态 |
|--------|------|------|
| 字段完整 | 对比 Python 输出 vs Go 输出 | ✅ 一致 |
| 400 拒收 | 服务端无 `invalid payload` | ✅ 默认明文 JSON 通过 |
| `os/hostname` 落库非空 | touchAgent 后查 agent 行 | ✅ |
| `temp` null 通路 | 无传感器不 400 | ✅ |
| 流量累计 | 重启后月累计不丢 | ✅ |
| 首跑无流量尖峰 | fresh state 月累计 ≈0 | ✅ |
| 多盘去重 | 同盘多挂载只一条 | ✅ J4125 识别 / /data /boot/efi |
| `disks` 数量≤32 / pct 精度 | — | ✅ |
| HTTPS 强制 | `http://` 非 localhost 退出 | ✅ |
| 状态原子写 | 断电后不损坏 | ✅ `.tmp`+rename |
| 资源占用 | 内存 <10 MB，CPU <1% | ✅ |
| 自适应快/慢切换 | 变化→快档、平稳→慢档 | ✅ 实测 |
| 不解析响应 | 纯单向上报 | ✅ |

---

## 十二、实施计划（回顾）

| 阶段 | 内容 | 状态 |
|------|------|------|
| **P0** | Linux 全字段采集 + HTTPS 上报 + 正确月累计 | ✅ 完成 |
| **P1** | 多盘 `/host`、磁盘 IO、探测并发/重试 | ✅ 完成 |
| **P2** | 退避/信号/月度重置/原子写/Mem 回退 | ✅ 完成 |
| **P3** | 自适应上报（纯本地）、gzip 开关、审计修复 | ✅ 完成 |

**待办（未做）：** `agent-go/Dockerfile`（scratch + USER 1000 + `--cap-drop=ALL`）与交叉编译 CI，把镜像化与最低权限运行收口。
