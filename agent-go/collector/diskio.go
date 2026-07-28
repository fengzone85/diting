package collector

import (
	"bufio"
	"os"
	"strconv"
	"strings"
)

// diskIO 读 /proc/diskstats，累加真实磁盘的读/写字节数。
//
// /proc/diskstats 字段（空格分隔）：
//
//	0  1  2    3  4  5       6 7 8 9       10 11 12
//	major minor dev reads s_read writes s_written ...
//
// parts[5] = 读扇区数，parts[9] = 写扇区数
// 字节 = 扇区 × 512
//
// 跳过 ram/loop/zram 前缀、含 dm-、md 前缀（伪设备）。
// 与 Python collector.py:176-185 对齐。
func diskIO() (readBytes, writeBytes uint64) {
	f, err := os.Open("/proc/diskstats")
	if err != nil {
		return
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 11 {
			continue
		}
		dev := fields[2]
		// 跳过伪设备
		if strings.HasPrefix(dev, "ram") || strings.HasPrefix(dev, "loop") || strings.HasPrefix(dev, "zram") {
			continue
		}
		if strings.Contains(dev, "dm-") || strings.HasPrefix(dev, "md") {
			continue
		}
		rSect, err := strconv.ParseUint(fields[5], 10, 64)
		if err != nil {
			continue
		}
		wSect, err := strconv.ParseUint(fields[9], 10, 64)
		if err != nil {
			continue
		}
		readBytes += rSect * 512
		writeBytes += wSect * 512
	}
	return
}
