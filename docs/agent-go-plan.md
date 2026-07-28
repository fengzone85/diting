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
| `os` | string | ✅ | 系统发行版 |
| `hostname` | string | ✅ | 主机名 |
| `temp` | *float64 | ❌ | 温度（可 null） |
| `swap_used` | *uint64 | ❌ | Swap 已用 |
| `swap_total` | *uint64 | ❌ | Swap 总量 |
| `swap_pct` | *float64 | ❌ | Swap 百分比 |
| `disk_r_rate` | *float64 | ❌ | 磁盘读速率 |
| `disk_w_rate` | *float64 | ❌ | 磁盘写速率 |
| `probes` | map | ❌ | 探测结果 |
| `disks` | []DiskInfo | ❌ | 多盘详情 |

**注意：**
- 核心标量**禁止 `omitempty`**（缺 `cpu`/`mem_total` 服务端直接 400）
- `temp` 用 `*float64` 允许 `null`
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
    // 读 /proc/stat 第一行
    // 解析 user+nice+system+idle+iowait+irq+softirq = total
    // idle = idle + iowait
    // 与 prev 算差值: 1 - dIdle/dTotal
}
```

- 构造时 prime 一次（阻塞 ~100ms）
- 首次上报允许为 0

### 内存

```go
func (c *Collector) Mem() (used, total, pct float64) {
    // 读 /proc/meminfo
    // total = MemTotal
    // available = MemAvailable
    // used = total - available
    // pct = used / total * 100
}
```

### 磁盘多盘（最难对齐）

复刻 Python `collector.py:75-154`：
1. 读 `/proc/mounts`（容器内优先 `/hostproc/mounts`）
2. `REAL_FS` 过滤：只保留 `ext4/xfs/btrfs/zfs/tmpfs/ntfs/fat32/apfs`
3. 按 `st_dev` 去重（同盘多挂载合并）
4. 跳过 `ram/loop/zram/dm-/md` 虚拟设备
5. `/host` 前缀还原
6. 顶层 `disk_used/total` 取 `DISK_PATH` 聚合
7. 同时返回 `[]DiskInfo`

### 磁盘 IO

```go
func (c *Collector) DiskIO() (readRate, writeRate float64) {
    // 读 /proc/diskstats
    // 累加真实盘扇区 ×512
    // 跳过 ram/loop/zram/dm-/md
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

### 探测（对齐 Python）

```go
func (c *Collector) Probe(targets map[string]string) map[string]Probe {
    // 默认 TCP 回退：依次试 443/80/目标端口
    // create_connection 成功即可达，返回 RTT
    // ICMP 可选：golang.org/x/net/icmp，需 setcap cap_net_raw
    // 失败静默回退 TCP
}
```

**结果结构：**
```go
type Probe struct {
    Ok bool `json:"ok"`
    Ms *int `json:"ms,omitempty"`
}
```

---

## 四、状态持久化

```go
type State struct {
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
    if rx > s.LastRx { s.MonthRx += rx - s.LastRx }
    if tx > s.LastTx { s.MonthTx += tx - s.LastTx }
    s.LastRx = rx
    s.LastTx = tx
}
```

**原子写入：**
```go
func (s *State) Save(path string) error {
    tmp := path + ".tmp"
    data, _ := json.Marshal(s)
    os.WriteFile(tmp, data, 0o644)
    return os.Rename(tmp, path)
}
```

---

## 五、上报与退避

### HTTPS 强制

```go
func (c *Config) Validate() error {
    u, _ := url.Parse(c.ServerURL)
    if u.Scheme == "http" && u.Hostname() != "localhost" {
        return fmt.Errorf("http:// only allowed for localhost")
    }
    return nil
}
```

### 退避策略

| 场景 | 退避 |
|------|------|
| 401/403 | 10 分钟（token 静态不可自愈） |
| 网络错误 | 指数退避 1s→2s→4s→8s→16s→30s（封顶） |
| 成功 | 立即重置 |

---

## 六、自适应上报间隔

```go
type AdaptiveReporter struct {
    mu           sync.RWMutex
    viewerCount  int
    fastInterval time.Duration // 有观看者 10s
    slowInterval time.Duration // 无观看者 60s
}

func (a *AdaptiveReporter) Interval() time.Duration {
    if a.viewerCount > 0 { return a.fastInterval }
    return a.slowInterval
}
```

---

## 七、安全模型

| 维度 | 要求 |
|------|------|
| 镜像 | `scratch`（静态 CGO_ENABLED=0） |
| 用户 | `USER 1000` |
| 能力 | `--cap-drop=ALL`（TCP 探测零 cap） |
| 挂载 | `-v /:/host:ro -v /proc:/hostproc:ro -v diting-state:/data` |
| Token | 仅 env/内存、只经 HTTPS、不落盘 |
| DEBUG | 不打印 token |

---

## 八、实施计划

| 阶段 | 内容 | 产出 |
|------|------|------|
| **P0** | Linux 全字段采集 + HTTPS 上报 + 正确月累计 | 能真收数据 |
| **P1** | 多盘 `/host`、磁盘 IO、探测、Windows（延后） | 100% 对齐 Python |
| **P2** | 退避/信号/月度重置/原子写 | 生产可用 |
| **P3** | 压缩上报/断线缓存/资源限制 | 大规模部署 |

---

## 九、迁移注意

- Go 与 Python **不得共用同一 `AGENT_ID`**（否则 `last_seen`/指标互相覆盖）
- 对比时注册**两个独立 agent**并排看
- 现有 Python 版保留，随时可切回

---

## 十、验证清单

| 检查项 | 方法 |
|--------|------|
| 字段完整 | 对比 Python collector.py 输出 vs Go 输出 |
| 400 拒收 | 服务端日志无 `invalid payload` |
| 流量累计 | 重启后月累计不丢 |
| HTTPS 强制 | `http://` 非 localhost 直接退出 |
| 状态原子写 | 断电后 state.json 不损坏 |
| 资源占用 | 内存 <10 MB，CPU <1% |
