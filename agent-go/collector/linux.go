//go:build linux

package collector

import (
	"os"
	"strconv"
	"strings"
	"time"
)

// rateFromCounter 由「累计计数器」的两次采样算速率（单位/秒）。
//
// 只有**严格递增**才计算：计数器回退（设备重建 / 热插拔 / 虚拟机磁盘重置 /
// /proc 重挂载）时 uint64 相减会下溢成 ~1.8e19，服务端虽把值钳到 1e15，
// 图表仍会出现「1000 TB/s」这类尖刺。相等（无增量）与 dt<=0 一律记 0。
func rateFromCounter(cur, prev uint64, dtSeconds float64) float64 {
	if dtSeconds <= 0 || cur < prev {
		return 0
	}
	return float64(cur-prev) / dtSeconds
}

// linuxCollector 是 Linux 平台的采集器实现。
// 内部持有前次样本（CPU/网络/磁盘 IO），用于算差值。
type linuxCollector struct {
	diskPath     string
	netOpts      NetIfaceOptions
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
func NewCollector(diskPath string, netOpts NetIfaceOptions) Collector {
	c := &linuxCollector{diskPath: diskPath, netOpts: netOpts}
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

	// 进程数（仅计数：/proc 下纯数字目录数）
	procCount := processCount()

	// 网络（S1：过滤后再累加；同时记录参与计数的接口集指纹）
	rx, tx, netIfaces := netTotals(c.netOpts)
	var rxRate, txRate float64
	if c.prevNet != nil && !c.prevNetTime.IsZero() {
		dt := now.Sub(c.prevNetTime).Seconds()
		rxRate = rateFromCounter(rx, c.prevNet.rx, dt)
		txRate = rateFromCounter(tx, c.prevNet.tx, dt)
	}
	c.prevNet = &netSample{rx, tx}
	c.prevNetTime = now

	// 磁盘 IO
	//
	// 与网络分支用同一个 rateFromCounter：此前这里是裸相减，而磁盘计数器比网络更容易
	// 回退（设备重建 / 热插拔 / 虚拟机磁盘重置），uint64 下溢会算出 ~1.8e19，
	// 服务端虽把值钳到 1e15，图表上仍会出现「1000 TB/s」级尖刺。
	dr, dw := diskIO()
	var diskRRate, diskWRate float64
	if c.prevDiskIO != nil && !c.prevDiskIOTime.IsZero() {
		dt := now.Sub(c.prevDiskIOTime).Seconds()
		diskRRate = rateFromCounter(dr, c.prevDiskIO.read, dt)
		diskWRate = rateFromCounter(dw, c.prevDiskIO.write, dt)
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
		Cores:    cpuCores(),
		Temp:     temp,
		ProcessCount: procCount,
		SwapUsed:  uint64(swapUsed),
		SwapTotal: uint64(swapTotal),
		SwapPct:   round2(swapPct),
		NetRxRate: rxRate,
		NetTxRate: txRate,
		NetRx:     rx,
		NetTx:     tx,
		NetEpoch:  ifaceEpoch(bootID(), netIfaces),
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

// processCount 统计 /proc 下纯数字目录数（当前进程总数）。
// 仅计数，无任何进程明细读取（不读 stat/comm/cmdline 等任何进程信息），
// 零指纹面。失败返回 0（= 未采集语义）。
func processCount() int {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return 0
	}
	n := 0
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		name := e.Name()
		digits := len(name) > 0
		for i := 0; i < len(name); i++ {
			if name[i] < '0' || name[i] > '9' {
				digits = false
				break
			}
		}
		if digits {
			n++
		}
	}
	return n
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
