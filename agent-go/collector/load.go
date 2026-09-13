package collector

import (
	"os"
	"runtime"
	"strconv"
	"strings"
)

// loadAvg 读 /proc/loadavg，返回 (load1, load5, load15)。
// 格式："0.52 0.58 0.59 2/123 45678"
// 与 Python collector.py:190-194 对齐。
func loadAvg() (l1, l5, l15 float64) {
	data, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return
	}
	fields := strings.Fields(string(data))
	if len(fields) < 3 {
		return
	}
	l1, _ = strconv.ParseFloat(fields[0], 64)
	l5, _ = strconv.ParseFloat(fields[1], 64)
	l15, _ = strconv.ParseFloat(fields[2], 64)
	return
}

// cpuCores 返回逻辑核数（§9 T18），与 Python collector.py 的 cpu_cores() 口径对齐。
// 优先读 /proc/cpuinfo 的 processor 行数：loadAvg 读的是宿主 /proc/loadavg（宿主口径），
// 分母必须同源；runtime.NumCPU() 在容器里会受 CPU 亲和性/cgroup 影响，仅作回退。
// 都拿不到时返回 0 —— 服务端把 0 视为「未上报」，标记 cores_unknown，不用 0/1 冒充分母。
func cpuCores() int {
	if data, err := os.ReadFile("/proc/cpuinfo"); err == nil {
		n := 0
		for _, line := range strings.Split(string(data), "\n") {
			if strings.HasPrefix(line, "processor") {
				n++
			}
		}
		if n > 0 {
			return n
		}
	}
	if n := runtime.NumCPU(); n > 0 {
		return n
	}
	return 0
}
