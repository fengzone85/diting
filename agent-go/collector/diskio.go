//go:build linux

package collector

import (
	"bufio"
	"io"
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
// 跳过 ram/loop/zram 前缀、含 dm-、md 前缀（伪设备），**并且跳过分区**。
//
// 为什么要跳过分区（真机实测缺陷，2026-10-26）：/proc/diskstats 里整盘的 io_ticks
// 与扇区计数**已经包含其下所有分区**，若同时累加 vda 与 vda1/vda2，同一份 IO 会被
// 重复计算 —— 实测某机写扇区虚增 1.83 倍，直接污染面板的磁盘读写速率与周/月流量口径。
//
// 判定分区用 sysfs 的 /sys/class/block/<dev>/partition 是否存在，**不能**按
// 「名字以数字结尾」猜：nvme0n1（整盘）也以数字结尾，那样会误杀整块 NVMe。
// sysfs 不可读时（极简容器）sysfsIsPartition 返回 false ⇒ 退化为旧行为（多算不丢数据）。
// 与 Python collector.py:176-185 对齐。
func diskIO() (readBytes, writeBytes uint64) {
	f, err := os.Open("/proc/diskstats")
	if err != nil {
		return
	}
	defer f.Close()

	readBytes, writeBytes, _ = diskstatsSum(f, sysfsIsPartition)
	return
}

// sysfsIsPartition 判断 dev 是否为分区（存在 partition 属性文件）。
func sysfsIsPartition(dev string) bool {
	_, err := os.Stat("/sys/class/block/" + dev + "/partition")
	return err == nil
}

// diskstatsSum 从 /proc/diskstats 的文本内容累加**整盘**读/写字节数。
// isPartition 注入以便单测覆盖（生产传 sysfsIsPartition）。
func diskstatsSum(r io.Reader, isPartition func(dev string) bool) (readBytes, writeBytes uint64, err error) {
	scanner := bufio.NewScanner(r)
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
		if strings.HasPrefix(dev, "dm-") || strings.HasPrefix(dev, "md") {
			continue
		}
		// 跳过分区：整盘计数已包含它们，重复累加会虚增
		if isPartition != nil && isPartition(dev) {
			continue
		}
		rSect, perr := strconv.ParseUint(fields[5], 10, 64)
		if perr != nil {
			continue
		}
		wSect, perr := strconv.ParseUint(fields[9], 10, 64)
		if perr != nil {
			continue
		}
		readBytes += rSect * 512
		writeBytes += wSect * 512
	}
	return readBytes, writeBytes, scanner.Err()
}
