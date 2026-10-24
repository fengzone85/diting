//go:build linux

package collector

import (
	"bufio"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// sysNetDir 是网卡 sysfs 根目录（测试/异常环境可读不到，此时只靠名字规则）。
const sysNetDir = "/sys/class/net"

// 隧道类型的 /sys/class/net/<name>/type 取值（monitor 实测集合）：
// none(tun/wg/tailscale)、ipip、ip6tnl、sit、gre、ip6gre。
var tunnelIfaceTypes = map[string]bool{
	"65534": true, "768": true, "769": true, "776": true, "778": true, "823": true,
}

// readNetDev 解析 /proc/net/dev，返回「接口名 → 累计收发字节」（含 lo，由调用方过滤）。
// 格式（跳过前两行表头）：
//
//	eth0: 12345 0 0 0 0 0 0 0 67890 0 0 0 0 0 0 0
//
// col1 = 接收字节，col9 = 发送字节。
func readNetDev() (map[string]netSample, []string) {
	f, err := os.Open("/proc/net/dev")
	if err != nil {
		return nil, nil
	}
	defer f.Close()

	out := make(map[string]netSample)
	var order []string
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
		if name == "" {
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
		if _, seen := out[name]; !seen {
			order = append(order, name)
		}
		out[name] = netSample{rx: r, tx: t}
	}
	return out, order
}

// countedElsewhere 判断该接口的字节是否已经在另一个接口上被内核记过：
//   - DEVTYPE=bridge/bond，或存在 lower_* 链接（VLAN/macvlan/DSA 口）；
//   - 无硬件（没有 device 链接）且是网桥端口（brport）或隧道类型 / vxlan / geneve。
//
// 与 monitor counted_elsewhere 同口径；读不到 sysfs 时返回 false（名字规则仍然生效）。
func countedElsewhere(name string) bool {
	dev := filepath.Join(sysNetDir, name)
	uevent, _ := os.ReadFile(filepath.Join(dev, "uevent"))
	lines := strings.Split(string(uevent), "\n")
	hasUevent := func(want ...string) bool {
		for _, l := range lines {
			for _, w := range want {
				if l == w {
					return true
				}
			}
		}
		return false
	}

	// 先判堆叠：DSA 口既有 device 又是某网桥的 lower。
	if hasUevent("DEVTYPE=bridge", "DEVTYPE=bond") {
		return true
	}
	if entries, err := os.ReadDir(dev); err == nil {
		for _, e := range entries {
			if strings.HasPrefix(e.Name(), "lower_") {
				return true
			}
		}
	}
	// 有硬件（PCI/USB 设备）的接口是真实网卡：LTE 模块的 raw-IP 与 WireGuard 同为
	// type none，只有 device 链接能区分。
	if _, err := os.Stat(filepath.Join(dev, "device")); err == nil {
		return false
	}
	if _, err := os.Stat(filepath.Join(dev, "brport")); err == nil {
		return true
	}
	if typ, err := os.ReadFile(filepath.Join(dev, "type")); err == nil {
		if tunnelIfaceTypes[strings.TrimSpace(string(typ))] {
			return true
		}
	}
	return hasUevent("DEVTYPE=vxlan", "DEVTYPE=geneve")
}

// netTotals 汇总参与计数的接口字节，并返回被计入的接口名集合（供 ifaceEpoch）。
func netTotals(opts NetIfaceOptions) (rx, tx uint64, names []string) {
	dev, order := readNetDev()
	if len(order) == 0 {
		return 0, 0, nil
	}
	names = selectIfaces(order, opts, countedElsewhere)
	for _, name := range names {
		s := dev[name]
		rx += s.rx
		tx += s.tx
	}
	return rx, tx, names
}
