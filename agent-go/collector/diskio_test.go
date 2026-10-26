//go:build linux

package collector

import (
	"strings"
	"testing"
)

// /proc/diskstats 的一行（14 字段）：
//
//	major minor dev reads reads_merged sectors_read ms_reading writes writes_merged sectors_written ...
//	[5] = 读扇区数，[9] = 写扇区数，字节 = 扇区 × 512
const fakeDiskstats = `   8       0 sda 100 0 1000 0 50 0 500 0 0 0 0
   8       1 sda1 60 0 600 0 30 0 300 0 0 0 0
   8       2 sda2 40 0 400 0 20 0 200 0 0 0 0
 259       0 nvme0n1 200 0 2000 0 100 0 1000 0 0 0 0
 259       1 nvme0n1p1 200 0 2000 0 100 0 1000 0 0 0 0
   7       0 loop0 999 0 9999 0 999 0 9999 0 0 0 0
   1       0 ram0 999 0 9999 0 999 0 9999 0 0 0 0
 253       0 dm-0 999 0 9999 0 999 0 9999 0 0 0 0
 253       1 md0 999 0 9999 0 999 0 9999 0 0 0 0
   8      16 sdb 10 0 100 0 5 0 50 0 0 0 0
`

// 回归：只统计整盘，**不得**把分区再累加一遍。
// 真机实测缺陷：整盘的扇区计数已包含其所有分区，同时累加导致写扇区虚增 1.83 倍。
func TestDiskstatsSumSkipsPartitions(t *testing.T) {
	partitions := map[string]bool{
		"sda1": true, "sda2": true, "nvme0n1p1": true,
	}
	isPart := func(dev string) bool { return partitions[dev] }

	gotR, gotW, err := diskstatsSum(strings.NewReader(fakeDiskstats), isPart)
	if err != nil {
		t.Fatalf("diskstatsSum 报错: %v", err)
	}
	// 只应剩下 sda(1000/500) + nvme0n1(2000/1000) + sdb(100/50)
	wantR := uint64((1000 + 2000 + 100) * 512)
	wantW := uint64((500 + 1000 + 50) * 512)
	if gotR != wantR {
		t.Fatalf("读字节数不对：got %d, want %d（分区被重复计入？）", gotR, wantR)
	}
	if gotW != wantW {
		t.Fatalf("写字节数不对：got %d, want %d（分区被重复计入？）", gotW, wantW)
	}
}

// 名字以数字结尾的**整盘**不能被误杀（nvme0n1 是整盘，nvme0n1p1 才是分区）。
func TestDiskstatsSumKeepsNvmeWholeDisk(t *testing.T) {
	onlyP1 := func(dev string) bool { return dev == "nvme0n1p1" }
	gotR, _, _ := diskstatsSum(strings.NewReader(fakeDiskstats), onlyP1)
	// 期望含 nvme0n1 的 2000 扇区（若按「名字以数字结尾」判断就会把它误删）
	if gotR < 2000*512 {
		t.Fatalf("整块 NVMe 被误判为分区：读字节数 %d < %d", gotR, 2000*512)
	}
}

// sysfs 不可读时（极简容器）isPartition 为 nil ⇒ 退化为旧行为：全部累加，不丢数据。
func TestDiskstatsSumDegradesWhenNoPartitionProbe(t *testing.T) {
	gotR, gotW, err := diskstatsSum(strings.NewReader(fakeDiskstats), nil)
	if err != nil {
		t.Fatalf("diskstatsSum 报错: %v", err)
	}
	wantR := uint64((1000 + 600 + 400 + 2000 + 2000 + 100) * 512)
	wantW := uint64((500 + 300 + 200 + 1000 + 1000 + 50) * 512)
	if gotR != wantR || gotW != wantW {
		t.Fatalf("降级行为不对：got r=%d w=%d, want r=%d w=%d", gotR, gotW, wantR, wantW)
	}
}

// 字段不足 / 非数字的行必须被跳过，而不是污染合计或让解析报错。
func TestDiskstatsSumSkipsMalformedLines(t *testing.T) {
	in := "garbage line\n" +
		"   8       0 sda 100 0 1000 0 50 0 500 0 0 0 0\n" +
		"   8       1 sda1 short\n" +
		"   8       2 sda2 x 0 notanumber 0 0 0 500 0 0 0 0\n"
	gotR, gotW, _ := diskstatsSum(strings.NewReader(in), func(d string) bool { return d == "sda1" })
	if gotR != 1000*512 || gotW != 500*512 {
		t.Fatalf("脏行处理不对：got r=%d w=%d，期望仅 sda 的 r=%d w=%d", gotR, gotW, 1000*512, 500*512)
	}
}
