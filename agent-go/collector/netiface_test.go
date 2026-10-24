package collector

import (
	"reflect"
	"testing"
)

// TestIfaceEpoch 覆盖：排序无关 / 增删接口敏感 / bootID 参与 / 只对传入（已过滤）集合敏感。
func TestIfaceEpoch(t *testing.T) {
	base := ifaceEpoch("boot-a", []string{"eth0", "eth1"})
	if base != ifaceEpoch("boot-a", []string{"eth1", "eth0"}) {
		t.Fatal("epoch must be order independent")
	}
	if base == ifaceEpoch("boot-a", []string{"eth0"}) {
		t.Fatal("removing an interface must change the epoch")
	}
	if base == ifaceEpoch("boot-a", []string{"eth0", "eth1", "eth2"}) {
		t.Fatal("adding an interface must change the epoch")
	}
	if base == ifaceEpoch("boot-b", []string{"eth0", "eth1"}) {
		t.Fatal("boot id must participate in the epoch")
	}
	// 格式与 monitor 对齐：boot/digest16
	if got := ifaceEpoch("boot", nil); len(got) != len("boot/")+16 || got[:5] != "boot/" {
		t.Fatalf("unexpected epoch format: %q", got)
	}
}

// TestSelectIfaces 覆盖内置排除规则、回环、堆叠、sysfs 注入与白名单优先级。
func TestSelectIfaces(t *testing.T) {
	all := []string{
		"lo", "eth0", "docker0", "veth123", "br-abc", "virbr0", "bond0",
		"vmbr0", "eth0.100", "ppp0", "wg0", "tailscale0", "fwbr100", "kube-ipvs0",
	}

	got := selectIfaces(all, NetIfaceOptions{Filter: true}, nil)
	want := []string{"eth0", "ppp0"} // ppp0 保留（只有 pppoe- 前缀才排除）
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("default filter = %v, want %v", got, want)
	}

	// sysfs 注入：真实网卡但被判定为隧道（例如 he-ipv6）应排除
	got = selectIfaces([]string{"eth0", "he-ipv6"}, NetIfaceOptions{Filter: true}, func(n string) bool {
		return n == "he-ipv6"
	})
	if !reflect.DeepEqual(got, []string{"eth0"}) {
		t.Fatalf("elsewhere filter = %v, want [eth0]", got)
	}

	// 关闭过滤：保留全部非 lo 接口（旧口径）
	got = selectIfaces(all, NetIfaceOptions{Filter: false}, nil)
	if len(got) != len(all)-1 || got[0] != "eth0" {
		t.Fatalf("filter off should keep every non-lo interface, got %v", got)
	}

	// 白名单优先于一切内置规则：wg0 本来被排除，但显式点名后必须统计
	got = selectIfaces(all, NetIfaceOptions{Filter: true, Only: []string{"wg0", "eth9"}}, nil)
	if !reflect.DeepEqual(got, []string{"wg0"}) {
		t.Fatalf("only list = %v, want [wg0]", got)
	}

	// 白名单同样高于 NET_IFACE_FILTER=0
	got = selectIfaces(all, NetIfaceOptions{Filter: false, Only: []string{"eth0"}}, nil)
	if !reflect.DeepEqual(got, []string{"eth0"}) {
		t.Fatalf("only list with filter off = %v, want [eth0]", got)
	}
}

func TestParseIfaceOnly(t *testing.T) {
	if got := ParseIfaceOnly(""); got != nil {
		t.Fatalf("empty spec = %v, want nil", got)
	}
	if got := ParseIfaceOnly(" eth0 , wg0 ,, eth0 ,"); !reflect.DeepEqual(got, []string{"eth0", "wg0"}) {
		t.Fatalf("ParseIfaceOnly = %v", got)
	}
}

// TestNetTotalsLinuxShape 冒烟：真实 /proc/net/dev 下过滤结果不含 lo/docker/veth，
// 且接口名集合非空、epoch 已生成（不依赖固定网卡名，容器/真机都能跑）。
func TestNetTotalsLinuxShape(t *testing.T) {
	rx, tx, names := netTotals(NetIfaceOptions{Filter: true})
	if len(names) == 0 {
		t.Skip("no countable interface in this environment")
	}
	for _, n := range names {
		if n == "lo" || skipIfaceName(n) || stackedIfaceName(n) {
			t.Fatalf("filtered set contains excluded iface %q (%v)", n, names)
		}
	}
	// 计数允许为 0（刚启动的容器），但必须可生成合法的 epoch
	epoch := ifaceEpoch("boot", names)
	if epoch == "" || epoch[:5] != "boot/" {
		t.Fatalf("bad epoch %q (rx=%d tx=%d)", epoch, rx, tx)
	}
}
