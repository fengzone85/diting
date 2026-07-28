package collector

import (
	"os"
	"strconv"
	"strings"
)

// uptimeSec 读 /proc/uptime，返回运行秒数。
// 格式："12345.67 67890.12"（第一个值是运行时间，第二个是空闲时间）
// 与 Python collector.py:223-227 对齐。
func uptimeSec() float64 {
	data, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return 0
	}
	fields := strings.Fields(string(data))
	if len(fields) == 0 {
		return 0
	}
	v, _ := strconv.ParseFloat(fields[0], 64)
	return v
}
