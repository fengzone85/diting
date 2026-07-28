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

	// 温度（无传感器时 nil，唯一可空标量）
	Temp *float64 `json:"temp"`

	// Swap（始终发送，无 swap 时全 0）
	SwapUsed  uint64  `json:"swap_used"`
	SwapTotal uint64  `json:"swap_total"`
	SwapPct   float64 `json:"swap_pct"`

	// 网络实时速率（B/s）
	NetRxRate float64 `json:"net_rx_rate"`
	NetTxRate float64 `json:"net_tx_rate"`

	// 网络月累计（持久化，跨重启）
	NetRxMonth uint64 `json:"net_rx_month"`
	NetTxMonth uint64 `json:"net_tx_month"`

	// 网络累计字节（不上报，用于月累计计算，json:"-" 跳过序列化）
	NetRx uint64 `json:"-"`
	NetTx uint64 `json:"-"`

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
