package collector

import (
	"bufio"
	"os"
	"strconv"
	"strings"
)

// netTotals 读 /proc/net/dev，累加非 lo 接口的接收/发送字节。
// 格式（跳过前两行表头）：
//
//	eth0: 12345 0 0 0 0 0 0 0 67890 0 0 0 0 0 0 0
//
// col1 = 接收字节，col9 = 发送字节
// 与 Python collector.py:197-209 对齐。
func netTotals() (rx, tx uint64) {
	f, err := os.Open("/proc/net/dev")
	if err != nil {
		return
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	scanner.Scan() // 跳过 "Inter-|   Receive"
	scanner.Scan() // 跳过 " face |bytes"

	for scanner.Scan() {
		line := scanner.Text()
		idx := strings.Index(line, ":")
		if idx < 0 {
			continue
		}
		name := strings.TrimSpace(line[:idx])
		if name == "lo" {
			continue
		}
		fields := strings.Fields(line[idx+1:])
		if len(fields) < 9 {
			continue
		}
		r, err := strconv.ParseUint(fields[0], 10, 64)
		if err != nil {
			continue
		}
		t, err := strconv.ParseUint(fields[8], 10, 64)
		if err != nil {
			continue
		}
		rx += r
		tx += t
	}
	return
}
