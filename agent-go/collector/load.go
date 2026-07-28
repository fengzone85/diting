package collector

import (
	"os"
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
