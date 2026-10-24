package collector

import (
	"fmt"
	"hash/fnv"
	"sort"
	"strings"
)

// 接口名排除表（前缀匹配），与 monitor 的实现对齐
// （dev-refs/monitor-probe-agent/src/collect.rs:33-58 的 SKIP_IFACES 全集）。
//
// 为什么需要：/proc/net/dev 会把 docker0、veth*、br-* 等虚拟接口一起列出来，
// 新建一个已运行数周的网桥时，它的「生命周期累计字节」会被当成本期新增流量。
var skipIfacePrefixes = []string{
	"lo", "docker", "veth", "br-", "virbr", "tap", "tun", "wg", "tailscale",
	"cni", "flannel", "podman", "fwbr", "fwpr", "fwln", "ifb", "gretap",
	"erspan", "kube", "cali", "nerdctl", "lxc", "cilium", "zt",
}

// 堆叠接口名规则：bond/br/vlan/vmbr/pppoe- 前缀，或名字含 '.'（VLAN 子接口）。
// 内核在物理口与这些口上各记一次，都算等于双计。
var stackedIfacePrefixes = []string{"bond", "br", "vlan", "vmbr", "pppoe-"}

func skipIfaceName(name string) bool {
	for _, p := range skipIfacePrefixes {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	return false
}

func stackedIfaceName(name string) bool {
	if strings.Contains(name, ".") {
		return true
	}
	for _, p := range stackedIfacePrefixes {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	return false
}

// ParseIfaceOnly 解析 NET_IFACE_ONLY：逗号分隔的完整接口名，去空白/去重、保序。
func ParseIfaceOnly(spec string) []string {
	if strings.TrimSpace(spec) == "" {
		return nil
	}
	seen := make(map[string]bool)
	var out []string
	for _, part := range strings.Split(spec, ",") {
		name := strings.TrimSpace(part)
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		out = append(out, name)
	}
	return out
}

func ifaceInList(list []string, name string) bool {
	for _, n := range list {
		if n == name {
			return true
		}
	}
	return false
}

// selectIfaces 选出真正参与计数的接口。
//
// 优先级（S1 方案）：NET_IFACE_ONLY 白名单 > 内置排除规则；Filter=false 时原样返回
// （回退旧口径）。elsewhere 由平台侧注入 sysfs 探测（bridge/bond/隧道/网桥端口），
// 纯函数本身只做名字规则，便于单测。
func selectIfaces(names []string, opts NetIfaceOptions, elsewhere func(string) bool) []string {
	out := make([]string, 0, len(names))
	for _, name := range names {
		// 回环永远不计（与旧实现一致：旧 netTotals 无条件跳过 lo）
		if name == "lo" {
			continue
		}
		if len(opts.Only) > 0 {
			if ifaceInList(opts.Only, name) {
				out = append(out, name)
			}
			continue
		}
		if !opts.Filter {
			out = append(out, name)
			continue
		}
		if skipIfaceName(name) || stackedIfaceName(name) {
			continue
		}
		if elsewhere != nil && elsewhere(name) {
			continue
		}
		out = append(out, name)
	}
	return out
}

// ifaceEpoch 生成接口集指纹：bootID + "/" + 排序后接口名（换行分隔）的 FNV-1a 64 摘要。
//
// 格式与 monitor 完全一致（bootID/digest16），服务端按 "/" 取 boot 段。
// names 必须是**过滤后**真正参与计数的集合：否则新建一个本就被排除掉的网桥
// 也会改变摘要，白丢一个上报间隔。
func ifaceEpoch(bootID string, names []string) string {
	sorted := append([]string(nil), names...)
	sort.Strings(sorted)
	h := fnv.New64a()
	_, _ = h.Write([]byte(strings.Join(sorted, "\n")))
	return fmt.Sprintf("%s/%016x", bootID, h.Sum64())
}
