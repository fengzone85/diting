// Package collector 直读 /proc 采集系统指标。
//
// 设计原则（与 Python collector.py 一致）：
//   - 零外部依赖（不用 gopsutil），直读 /proc/*，零 cgo、可进 scratch 镜像
//   - 有状态：CPU/网络/磁盘 IO 速率需要前次样本，Collector 内部持有 _prev
//   - 安全白名单：只采性能数据，绝不采硬件指纹、进程列表、用户文件
package collector

// Collector 是采集器接口。
type Collector interface {
	// Collect 执行一次完整采集。
	Collect() (*Metrics, error)
}

// Probe 是单个探测点的结果（对应 Python probe_one 返回值）。
// Ms 为指针允许 null（可达但 RTT 解析失败的情况）。
type Probe struct {
	Ok bool     `json:"ok"`
	Ms *float64 `json:"ms"`
	// Loss 为丢包率（0 或 100）。Go 版为纯 TCP 探测，无 ICMP 丢包统计能力，
	// 故只取二值口径：TCP 握手成功 → 0，三轮全失败 → 100。
	// 与 Python 版（ICMP 优先、可算真实丢包率）口径不同但字段一致，服务端无需改动。
	Loss *float64 `json:"loss"`
	// Type 探测类型：http；空 = tcp（缺省语义，JSON 省字段以保持老格式零变化）。
	Type string `json:"type,omitempty"`
	// Code 是 HTTP 状态码（仅 http 探测；连接失败/超时为 nil，JSON 中字段省略）。
	Code *int `json:"code,omitempty"`
	// CertDays 是 TLS 证书剩余天数（仅 https 探测且握手成功取到证书）。
	// 0 = 已过期或当天到期；nil = 非 https 或无证书。服务端按 0..3650 校验。
	CertDays *int `json:"cert_days,omitempty"`
}

// DiskInfo 是单块真实磁盘的使用情况（多盘展示用）。
type DiskInfo struct {
	Mount string  `json:"mount"`
	Used  uint64  `json:"used"`
	Total uint64  `json:"total"`
	Pct   float64 `json:"pct"`
}

// Metrics 是一次采集的完整结果，直接序列化为上报 payload。
// 字段命名、类型与 Python collector.collect() 返回值逐一对齐。
type Metrics struct {
	// 系统（服务端 touchAgent 会写入 agents.os / agents.hostname）
	Hostname string  `json:"hostname"`
	OS       string  `json:"os"`
	Uptime   float64 `json:"uptime"`

	// CPU（需要前次样本，首报可为 0）
	CPU float64 `json:"cpu"`

	// 内存（口径：used = total - MemAvailable，与 Python 一致）
	MemUsed  uint64  `json:"mem_used"`
	MemTotal uint64  `json:"mem_total"`
	MemPct   float64 `json:"mem_pct"`

	// 磁盘（顶层聚合，取 DISK_PATH）
	DiskUsed  uint64  `json:"disk_used"`
	DiskTotal uint64  `json:"disk_total"`
	DiskPct   float64 `json:"disk_pct"`

	// 负载
	Load1  float64 `json:"load1"`
	Load5  float64 `json:"load5"`
	Load15 float64 `json:"load15"`

	// CPU 核数（§9 T18）：服务端据此把 load1 换算成「每核负载」。
	// 0 = 未上报（服务端标记 cores_unknown，不会用 0/1 冒充分母）。
	Cores int `json:"cores"`

	// 温度（无传感器时 nil，唯一可空标量）
	Temp *float64 `json:"temp"`

	// 进程总数（0 = 未采集/不可用；Linux 数 /proc，Windows 用 PDH \System\Processes）。
	// 仅"数量"这一个整数——不含任何进程明细（无进程名/命令行/PID 列表），零指纹面。
	// 前端 Komari 兼容层 process.count 图消费此字段。
	ProcessCount int `json:"process_count"`

	// 实际上报间隔（秒；0 = 未设置，如首轮）。审查 C-1/E2：服务端据此（并结合
	// 相邻 ts 中位数观测）校正离线阈值与 AI 超阈值时长估算——自适应模式下实际
	// 间隔在快/慢档间变化，按 AGENT_INTERVAL 固定值估算最多偏差 3 倍。
	Interval int `json:"interval"`

	// Swap（始终发送，无 swap 时全 0）
	SwapUsed  uint64  `json:"swap_used"`
	SwapTotal uint64  `json:"swap_total"`
	SwapPct   float64 `json:"swap_pct"`

	// 网络实时速率（B/s）
	NetRxRate float64 `json:"net_rx_rate"`
	NetTxRate float64 `json:"net_tx_rate"`

	// 网络累计字节（P2 起上报；服务端 traffic_state 累加器以此为周期基线，
	// 并回写 net_rx_month/net_tx_month——Go 端不再本地累加，P4 cleanup 已删 state 包）
	NetRx uint64 `json:"net_rx"`
	NetTx uint64 `json:"net_tx"`

	// NetEpoch 是「参与计数的接口集」指纹（S1）= bootID + "/" + 排序接口名的 FNV-1a 摘要。
	// 服务端只做不透明比较：
	//   - boot 段（"/" 前）变化 → 主机重启过，计数器归零，离线期增量按 since-boot 补账；
	//   - 整串变化（接口集变了）→ 只对齐基线，不把新接口的生命周期计数计入本期。
	// 空 = 老 agent 或平台不支持（服务端退回旧的 delta 逻辑）。
	NetEpoch string `json:"net_epoch,omitempty"`

	// 流量重置日（Komari month_rotate；0=绝对累计，1–31=周期重置日；服务端 agents.month_rotate 未设置时采用）
	MonthRotate int `json:"month_rotate,omitempty"`

	// 磁盘 IO 速率（B/s，需要前次样本）
	DiskRRate float64 `json:"disk_r_rate"`
	DiskWRate float64 `json:"disk_w_rate"`

	// 网络探测（可空，omitempty）
	Probes map[string]Probe `json:"probes,omitempty"`

	// 多盘（可空，omitempty）
	Disks []DiskInfo `json:"disks,omitempty"`
}

// NetIfaceOptions 是网络接口过滤选项（S1）。
type NetIfaceOptions struct {
	// Filter：NET_IFACE_FILTER，默认 true。false = 回退旧口径（全部非 lo 接口）。
	Filter bool
	// Only：NET_IFACE_ONLY 白名单（逗号分隔的完整接口名）。非空时忽略全部内置排除规则
	// ——否则「隧道即唯一上行」的节点（WireGuard 出口 VPS）会被排除到 0。
	Only []string
}

// ProbeTarget 是解析后的探测目标（label:host[:port] 或 label:http(s)://...）。
//
// Scheme 为空表示 TCP 探测（用 Host/Port）；http/https 表示 HTTP 探测（用 URL）。
// Host/Port 对 http(s) 同样填充（端口为 URL 实际端口），便于日志与本地展示。
type ProbeTarget struct {
	Label  string
	Host   string
	Port   int
	Scheme string
	URL    string
}

// round2 四舍五入到 2 位小数（平台共用：linux disk.go 与 windows disk 使用）。
// round2 四舍五入到 2 位小数（对齐 Python round(pct, 2)）。
func round2(v float64) float64 {
	return float64(uint64(v*100+0.5)) / 100
}
