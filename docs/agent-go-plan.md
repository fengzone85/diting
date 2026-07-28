# Go 受控端重构方案

> 最后更新：2026-07-28
> 状态：方案阶段，未开始编码

---

## 一、整体架构

```
main.go              入口 / 配置加载 / signal.NotifyContext 优雅退出
config/config.go     环境变量 + 默认值（含 HTTPS 强制校验）
collector/           cpu / mem / disk / load / network / uptime / probe / diskio
reporter/            http（headers+timeout）/ retry（退避）/ state（月累计持久化）
platform/            collector 接口 + linux 实现（MVP 仅 Linux；Windows 延后）
```

**依赖决策：**
- 不用 `gopsutil` — 直读 `/proc`，零 cgo，数值与 Python 逐字段一致
- 不用 `pro-bing` — 探测走 TCP 优先回退，ICMP 仅作可选增强
- 用 `caarlos0/env/v6` 做环境变量解析
- 用 `log/slog` + `net/http` 标准库

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

**注意：**
- 核心标量**禁止 `omitempty`**（缺 `cpu`/`mem_total` 服务端直接 400）
- `temp` 用 `*float64` 允许 `null`（唯一可空标量）
- **不发送 `ts`** — 服务端用 `Date.now()` 自生成

### 上报 Header

```
Content-Type: application/json
Authorization: Bearer <token>
X-Agent-ID: <agent_id>
User-Agent: diting-agent/<version>
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

**关键：**
- 构造时 prime 一次（阻塞 ~100ms）
- 首次上报允许为 0
- `total` 必须包含所有列，否则 CPU% 偏差

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

**关键：** 老内核无 `MemAvailable` 时需回退 `MemFree + Buffers + Cached`。

### 磁盘多盘（最难对齐）

复刻 Python `collector.py:75-154`：

1. 读 `/proc/mounts`（容器内优先 `/hostproc/mounts`）
2. `REAL_FS` 过滤：`ext2/3/4, xfs, btrfs, f2fs, reiserfs, jfs, nilfs2, vfat, ntfs, exfat, zfs`
   - **排除 tmpfs**（Python 刻意排除，内存盘不算硬盘）
   - **用 vfat 非 fat32**
3. 按 `st_dev` 去重（同盘多挂载合并）
4. 跳过 `ram/loop/zram/dm-/md` 虚拟设备
5. `/host` 前缀还原
6. 顶层 `disk_used/total` 取 `DISK_PATH` 聚合（`DISK_PATH` 不存在回退 `/`）
7. 同时返回 `[]DiskInfo`，约束：≤32 项、pct round 2 位、mount≤200 字符

### 磁盘 IO

```go
func (c *Collector) DiskIO() (readRate, writeRate float64) {
    // 读 /proc/diskstats
    // parts[5] = 读扇区数, parts[9] = 写扇区数
    // 字节 = 扇区 × 512
    // 跳过 ram/loop/zram 前缀、含 dm-、md 前缀
    // 与 _prev 算速率差值
}
```

### 网络

```go
func (c *Collector) Network() (rxRate, txRate float64, rx, tx uint64) {
    // 读 /proc/net/dev
    // 排除 lo，累加各接口
    // 与 _prev 算速率差值
}
```

### 探测（对齐 Python，参考 Pulse 并发模式）

```go
type ProbeTarget struct {
    Label string `json:"label"` // ≤24 字符
    Host  string `json:"host"`  // ≤253 字符
    Port  int    `json:"port"`  // ∈[1,65535]，默认 53
}

func (c *Collector) Probes(targets []ProbeTarget) map[string]Probe {
    // ≤8 个目标
    // 默认 TCP 回退：依次试 443/80/目标端口
    // 每个目标重试 3 次吸收抖动
    // sync.WaitGroup + goroutine 并发（参考 Pulse 模式）
    // net.DialTimeout("tcp", target, 3s) 握手时延 ×1000→ms
    // ICMP 可选：golang.org/x/net/icmp，需 setcap cap_net_raw
    // 失败静默回退 TCP
}
```

**输入校验（硬化解析）：**
```go
func parseProbeTarget(raw string) (*ProbeTarget, error) {
    // net.SplitHostPort 解析 host:port
    // port ∈ [1, 65535]
    // hostname 正则: ^[a-zA-Z0-9.\-:]+$
    // 长度 ≤ 255
    // label ≤ 24 字符
}
```

**结果结构：**
```go
type Probe struct {
    Ok bool     `json:"ok"`
    Ms *float64 `json:"ms,omitempty"`  // *float64 保留小数精度
}
```

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

**累加逻辑：**
```go
func (s *State) Accumulate(rx, tx uint64) {
    mk := time.Now().Format("2006-01")
    if mk != s.MonthKey {
        s.MonthKey = mk
        s.MonthRx = 0
        s.MonthTx = 0
    }
    // 首跑只设 LastRx/Tx，不累加（避免巨大尖峰）
    if !s.HasPrev {
        s.LastRx = rx
        s.LastTx = tx
        s.HasPrev = true
        return
    }
    if rx > s.LastRx { s.MonthRx += rx - s.LastRx }
    if tx > s.LastTx { s.MonthTx += tx - s.LastTx }
    s.LastRx = rx
    s.LastTx = tx
}
```

**原子写入：**
```go
func (s *State) Save(path string) error {
    if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
        return err
    }
    tmp := path + ".tmp"
    data, err := json.Marshal(s)
    if err != nil {
        return err
    }
    if err := os.WriteFile(tmp, data, 0o600); err != nil {
        return err
    }
    return os.Rename(tmp, path)
}
```

---

## 五、上报与退避

### HTTPS 强制

```go
func (c *Config) Validate() error {
    u, err := url.Parse(c.ServerURL)
    if err != nil {
        return fmt.Errorf("invalid server_url: %w", err)
    }
    // 仅允许 localhost/127.0.0.1/::1 使用 http
    allowed := u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1"
    if u.Scheme == "http" && !allowed {
        return fmt.Errorf("http:// only allowed for localhost/127.0.0.1/::1; use https:// for %s", u.Hostname())
    }
    // 非 http/https 直接拒
    if u.Scheme != "http" && u.Scheme != "https" {
        return fmt.Errorf("invalid scheme %q, expected http or https", u.Scheme)
    }
    return nil
}
```

### 退避策略

| 场景 | 退避 |
|------|------|
| 401/403 | 10 分钟（token 静态不可自愈） |
| 网络错误 | `2^attempt * INTERVAL`，封顶 30s，最多 3 次 |
| 成功 | 立即重置 |

**注意：** 401/403 退避后主循环还会再睡 INTERVAL（总 ~620s），属正常。

---

## 六、安全模型

| 维度 | 要求 |
|------|------|
| 镜像 | `scratch`（静态 CGO_ENABLED=0） |
| 用户 | `USER 1000`，构建期 `chown 1000 /data` |
| 能力 | `--cap-drop=ALL`（TCP 探测零 cap） |
| 网络 | **bridge 网络**，读 `/hostproc/net/dev` 拿真实流量，禁用 `--network host` |
| 挂载 | `-v /:/host:ro -v /proc:/hostproc:ro -v diting-state:/data` |
| Token | 仅 env/内存、只经 HTTPS、不落盘 |
| DEBUG | 不打印 token |
| ICMP | 默认 **TCP-only（零 cap）**；ICMP 作可选构建变体 |

---

## 七、实施计划

| 阶段 | 内容 | 产出 |
|------|------|------|
| **P0** | Linux 全字段采集 + HTTPS 上报 + 正确月累计 | 能真收数据 |
| **P1** | 多盘 `/host`、磁盘 IO、探测并发/重试、Windows（延后） | 100% 对齐 Python |
| **P2** | 退避/信号/月度重置/原子写/Mem 回退 | 生产可用 |
| **P3** | 压缩上报/断线缓存/资源限制（seccomp 收紧可选） | 大规模部署 |

---

## 八、安全模型对比（vs Pulse 等项目）

| 维度 | Pulse | 谛听（正确） |
|------|-------|-------------|
| 认证 | 共享 secret + query 传 token + 空 secret 无认证 | 每 agent 独立 token + SHA-256 + 恒定时间比较 |
| 传输 | 不强制 HTTPS，默认 http://localhost:8080 | 强制 HTTPS（非 localhost/127.0.0.1/::1 拒 http） |
| 指令通道 | 服务端下发探测目标 + 客户端监听 :9090 | 零入站、无指令通道、探测目标本地写死 |
| 指纹采集 | CPU 型号、虚拟化类型、公网 IP、位置 | 只采性能数据，禁止任何指纹 |
| 自动更新 | README 称有但代码完全没有（文档失实） | 无自更新，避免 RCE 面 |
| 依赖 | gopsutil + shell-out（df/top/sysctl） | 直读 /proc，零外部依赖 |

**结论：** Pulse 在安全模型上是"反向教材"，谛听现有设计（单向上报、per-agent token、强制 HTTPS、零入站、无指纹）是更安全的选择。

---

## 九、迁移注意

- Go 与 Python **不得共用同一 `AGENT_ID`**（否则 `last_seen`/指标互相覆盖）
- 对比时注册**两个独立 agent**并排看
- 现有 Python 版保留，随时可切回

---

## 九、验证清单

| 检查项 | 方法 |
|--------|------|
| 字段完整 | 对比 Python `collector.py` 输出 vs Go 输出 |
| 400 拒收 | 服务端日志无 `invalid payload` |
| `os/hostname` 落库非空 | touchAgent 后查 agent 行 |
| `temp` null 通路 | 无传感器不 400 |
| 流量累计 | 重启后月累计不丢 |
| 首跑无流量尖峰 | fresh state 月累计 ≈0 |
| 多盘去重 | 同盘多挂载只一条 |
| `disks` 数量≤32 / pct 精度 2 位 |
| HTTPS 强制 | `http://` 非 localhost/127.0.0.1/::1 直接退出 |
| `http://127.0.0.1` 放行 | 本地开发正常 |
| 状态原子写 | 断电后 state.json 不损坏 |
| 资源占用 | 内存 <10 MB，CPU <1% |
