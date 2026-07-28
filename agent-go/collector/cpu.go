package collector

import (
	"bufio"
	"os"
	"strconv"
	"strings"
)

// cpuSample 是某时刻 /proc/stat 的累计值（jiffies）。
type cpuSample struct {
	total uint64
	idle  uint64
}

// readCPUSample 读 /proc/stat 第一行，返回 (total, idle)。
//
// /proc/stat 第一行格式（注意：所有数值列都要计入 total）：
//
//	cpu  user nice system idle iowait irq softirq steal guest guest_nice
//
// total = 全部数值列之和（含 steal/guest/guest_nice）
// idle  = col4(idle) + col5(iowait)
//
// 漏算 steal/guest 会导致 CPU 使用率偏差，已修正（对齐 collector.py:23-29）。
func readCPUSample() (cpuSample, error) {
	f, err := os.Open("/proc/stat")
	if err != nil {
		return cpuSample{}, err
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	if !scanner.Scan() {
		return cpuSample{}, scanner.Err()
	}
	line := scanner.Text()
	// 跳过 "cpu" 前缀
	parts := strings.Fields(line[3:]) // "cpu" 长度 3
	if len(parts) < 4 {
		return cpuSample{}, nil
	}

	var total uint64
	nums := make([]uint64, len(parts))
	for i, p := range parts {
		v, err := strconv.ParseUint(p, 10, 64)
		if err != nil {
			return cpuSample{}, err
		}
		nums[i] = v
		total += v
	}
	// idle = col4(index 3) + col5(index 4, iowait)
	idle := nums[3]
	if len(nums) > 4 {
		idle += nums[4]
	}
	return cpuSample{total: total, idle: idle}, nil
}

// cpuPercent 算两次采样的 CPU 使用率。
// prev 为零值时返回 0（首报），与 Python cpu_percent(None) 一致。
func cpuPercent(prev, cur cpuSample) float64 {
	if prev.total == 0 {
		return 0
	}
	dTotal := cur.total - prev.total
	dIdle := cur.idle - prev.idle
	if dTotal <= 0 {
		return 0
	}
	pct := (1 - float64(dIdle)/float64(dTotal)) * 100
	if pct < 0 {
		return 0
	}
	if pct > 100 {
		return 100
	}
	return pct
}
