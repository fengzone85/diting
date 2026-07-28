package collector

import (
	"os"
	"strconv"
	"strings"
	"time"
)

// linuxCollector 是 Linux 平台的采集器实现。
// 内部持有前次样本（CPU/网络/磁盘 IO），用于算差值。
type linuxCollector struct {
	diskPath     string
	prevCPU      cpuSample
	prevNet      *netSample
	prevNetTime  time.Time
	prevDiskIO   *diskIOSample
	prevDiskIOTime time.Time
}

// netSample 是某时刻的网络累计字节。
type netSample struct {
	rx, tx uint64
}

// diskIOSample 是某时刻的磁盘 IO 累计字节。
type diskIOSample struct {
	read, write uint64
}

// NewCollector 创建并初始化采集器。
// 构造时 prime 一次 CPU 样本（阻塞 ~100ms），与 Python Collector.__init__ 一致。
func NewCollector(diskPath string) Collector {
	c := &linuxCollector{diskPath: diskPath}
	// Prime CPU sample
	c.prevCPU, _ = readCPUSample()
	if c.prevCPU.total > 0 {
		time.Sleep(100 * time.Millisecond)
	}
	return c
}

// Collect 执行一次完整采集，返回 Metrics。
// 字段顺序与 Python collector.collect() 返回值对齐，便于并行对比。
func (c *linuxCollector) Collect() (*Metrics, error) {
	now := time.Now()

	// CPU
	curCPU, err := readCPUSample()
	if err != nil {
		return nil, err
	}
	cpu := cpuPercent(c.prevCPU, curCPU)
	c.prevCPU = curCPU

	// 内存 + Swap
	memData := readMeminfo()
	memUsed, memTotal, memPct := memInfo(memData)
	swapUsed, swapTotal, swapPct := swapInfo(memData)

	// 磁盘（顶层聚合）
	diskPath := c.diskPath
	if diskPath == "" || fileNotExist(diskPath) {
		diskPath = "/"
	}
	diskUsed, diskTotal, diskPct := diskUsage(diskPath)

	// 多盘
	disks := diskList(c.diskPath)

	// 负载
	l1, l5, l15 := loadAvg()

	// 运行时间
	uptime := uptimeSec()

	// 温度
	temp := readTemp()

	// 网络
	rx, tx := netTotals()
	var rxRate, txRate float64
	if c.prevNet != nil && !c.prevNetTime.IsZero() {
		dt := now.Sub(c.prevNetTime).Seconds()
		if dt > 0 {
			if rx > c.prevNet.rx {
				rxRate = float64(rx-c.prevNet.rx) / dt
			}
			if tx > c.prevNet.tx {
				txRate = float64(tx-c.prevNet.tx) / dt
			}
		}
	}
	c.prevNet = &netSample{rx, tx}
	c.prevNetTime = now

	// 磁盘 IO
	dr, dw := diskIO()
	var diskRRate, diskWRate float64
	if c.prevDiskIO != nil && !c.prevDiskIOTime.IsZero() {
		dt := now.Sub(c.prevDiskIOTime).Seconds()
		if dt > 0 {
			diskRRate = float64(dr-c.prevDiskIO.read) / dt
			diskWRate = float64(dw-c.prevDiskIO.write) / dt
		}
	}
	c.prevDiskIO = &diskIOSample{dr, dw}
	c.prevDiskIOTime = now

	// hostname（os.Getenv 不可靠，用系统调用）
	hostname, _ := os.Hostname()

	return &Metrics{
		Hostname: hostname,
		OS:       osName(),
		Uptime:   uptime,
		CPU:      round2(cpu),
		MemUsed:  uint64(memUsed),
		MemTotal: uint64(memTotal),
		MemPct:   round2(memPct),
		DiskUsed: diskUsed,
		DiskTotal: diskTotal,
		DiskPct:  round2(diskPct),
		Load1:    l1,
		Load5:    l5,
		Load15:   l15,
		Temp:     temp,
		SwapUsed:  uint64(swapUsed),
		SwapTotal: uint64(swapTotal),
		SwapPct:   round2(swapPct),
		NetRxRate: rxRate,
		NetTxRate: txRate,
		NetRx:     rx,
		NetTx:     tx,
		DiskRRate: diskRRate,
		DiskWRate: diskWRate,
		Disks:     disks,
	}, nil
}

// fileNotExist 检查路径是否存在。
func fileNotExist(path string) bool {
	_, err := os.Stat(path)
	return err != nil
}

// readTemp 读 /sys/class/thermal 最高温度（°C），无传感器返回 nil。
// 与 Python collector.py:244-262 对齐。
func readTemp() *float64 {
	entries, err := os.ReadDir("/sys/class/thermal")
	if err != nil {
		return nil
	}
	var maxTemp float64
	var found bool
	for _, e := range entries {
		if !strings.HasPrefix(e.Name(), "thermal_zone") {
			continue
		}
		data, err := os.ReadFile("/sys/class/thermal/" + e.Name() + "/temp")
		if err != nil {
			continue
		}
		v, err := strconv.ParseFloat(strings.TrimSpace(string(data)), 64)
		if err != nil {
			continue
		}
		t := v / 1000.0 // 毫度 → 度
		if !found || t > maxTemp {
			maxTemp = t
			found = true
		}
	}
	if !found {
		return nil
	}
	return &maxTemp
}
