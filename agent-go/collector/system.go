package collector

import (
	"os"
	"strings"
)

// osName 读 /etc/os-release 的 PRETTY_NAME，失败时回退 "Linux"。
// 与 Python collector.py:212-220 对齐。
func osName() string {
	data, err := os.ReadFile("/etc/os-release")
	if err != nil {
		return "Linux"
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "PRETTY_NAME=") {
			v := strings.TrimPrefix(line, "PRETTY_NAME=")
			v = strings.Trim(v, "\"")
			return strings.TrimSpace(v)
		}
	}
	return "Linux"
}
