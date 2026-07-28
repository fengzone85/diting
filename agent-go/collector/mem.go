package collector

import (
	"bufio"
	"os"
	"strconv"
	"strings"
)

// readMeminfo 解析 /proc/meminfo，返回 key->bytes 的 map。
// /proc/meminfo 的值单位是 kB，乘 1024 得字节。
func readMeminfo() map[string]uint64 {
	out := map[string]uint64{}
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return out
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		idx := strings.Index(line, ":")
		if idx < 0 {
			continue
		}
		key := strings.TrimSpace(line[:idx])
		rest := strings.TrimSpace(line[idx+1:])
		fields := strings.Fields(rest)
		if len(fields) == 0 {
			continue
		}
		v, err := strconv.ParseUint(fields[0], 10, 64)
		if err != nil {
			continue
		}
		// 单位 kB → bytes
		out[key] = v * 1024
	}
	return out
}

// memInfo 返回 (used, total, pct)。
// 口径：used = total - MemAvailable。
// 老内核无 MemAvailable 时回退 MemFree + Buffers + Cached（对齐 collector.py:47）。
func memInfo(info map[string]uint64) (used, total, pct float64) {
	total = float64(info["MemTotal"])
	var avail uint64
	if a, ok := info["MemAvailable"]; ok {
		avail = a
	} else {
		avail = info["MemFree"] + info["Buffers"] + info["Cached"]
	}
	used = float64(total) - float64(avail)
	if used < 0 {
		used = 0
	}
	if total > 0 {
		pct = used / total * 100
	}
	return
}

// swapInfo 返回 (used, total, pct)。无 swap 时全 0。
func swapInfo(info map[string]uint64) (used, total, pct float64) {
	total = float64(info["SwapTotal"])
	free := float64(info["SwapFree"])
	used = total - free
	if used < 0 {
		used = 0
	}
	if total > 0 {
		pct = used / total * 100
	}
	return
}
