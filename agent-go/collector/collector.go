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

	// 网络月累计（P4 前仍本地持久化并上报；服务端 P1 起优先用绝对计数器口径回写同名字段）
	NetRxMonth uint64 `json:"net_rx_month"`
	NetTxMonth uint64 `json:"net_tx_month"`

	// 网络累计字节（P2 起上报；服务端 traffic_state 累加器以此为周期基线）
	NetRx uint64 `json:"net_rx"`
	NetTx uint64 `json:"net_tx"`

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

// ProbeTarget 是解析后的探测目标（label:host:port）。
type ProbeTarget struct {
	Label string
	Host  string
	Port  int
}

// round2 四舍五入到 2 位小数（平台共用：linux disk.go 与 windows disk 使用）。
// round2 四舍五入到 2 位小数（对齐 Python round(pct, 2)）。
func round2(v float64) float64 {
	return float64(uint64(v*100+0.5)) / 100
}
