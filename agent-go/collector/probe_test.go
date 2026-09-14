package collector

import (
	"context"
	"net"
	"testing"
	"time"
)

// TestParseProbeTargets 覆盖解析规则：label:host:port / 默认 53 / 截断 / 上限。
func TestParseProbeTargets(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want []ProbeTarget
	}{
		{"空串", "", nil},
		{"默认端口", "GG:8.8.8.8", []ProbeTarget{{"GG", "8.8.8.8", 53}}},
		{"完整三段", "CM:211.136.192.6:443", []ProbeTarget{{"CM", "211.136.192.6", 443}}},
		{"多目标", "CM:211.136.192.6,CT:101.226.4.6,CU:202.106.0.20,GG:8.8.8.8",
			[]ProbeTarget{{"CM", "211.136.192.6", 53}, {"CT", "101.226.4.6", 53}, {"CU", "202.106.0.20", 53}, {"GG", "8.8.8.8", 53}}},
		{"label超长截断到24", string(make([]byte, 0)) + repeat('x', 30) + ":8.8.8.8", []ProbeTarget{{repeat('x', 24), "8.8.8.8", 53}}},
		{"非法端口丢弃", "CM:211.136.192.6:99999", nil},
		{"空host丢弃", "CM:", nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := ParseProbeTargets(c.in)
			if len(got) != len(c.want) {
				t.Fatalf("ParseProbeTargets(%q) = %d targets, want %d", c.in, len(got), len(c.want))
			}
			for i := range got {
				if got[i] != c.want[i] {
					t.Fatalf("target[%d] = %+v, want %+v", i, got[i], c.want[i])
				}
			}
		})
	}
}

func repeat(ch byte, n int) string {
	b := make([]byte, n)
	for i := range b {
		b[i] = ch
	}
	return string(b)
}

// TestProbeOneSuccess 本地起监听，验证可达目标返回成功（目标端口优先，首轮即中）。
func TestProbeOneSuccess(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Skipf("cannot listen on loopback: %v", err)
	}
	defer ln.Close()
	port := ln.Addr().(*net.TCPAddr).Port

	ms, ok, loss := probeOne("127.0.0.1", port, time.Second, 5*time.Second)
	if !ok || ms == nil || loss == nil || *loss != 0 {
		t.Fatalf("probeOne ok=%v ms=%v loss=%v, want ok=true loss=0", ok, ms, loss)
	}
	if *ms < 0 || *ms > 1000 {
		t.Fatalf("rtt %v ms out of sane range", *ms)
	}
}

// TestProbeOneTargetPortFirst 回归：目标端口必须排在 443/80 之前——
// 否则对 443/80 全 DROP 的 DNS 目标（真实运营商网络行为），预算内
// 443/80 各吃满 timeout，TCP:53 几乎必通却永远轮不到（CU/GG 误报离线根因）。
func TestProbeOneTargetPortFirst(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Skipf("cannot listen on loopback: %v", err)
	}
	defer ln.Close()
	port := ln.Addr().(*net.TCPAddr).Port

	// 预算恰好只够 1 次拨号：若目标端口在首位则立即成功；
	// 若回归（443 在首位），首次 dial 100ms 超时耗尽预算 → 失败。
	ms, ok, loss := probeOne("127.0.0.1", port, 100*time.Millisecond, 120*time.Millisecond)
	if !ok || ms == nil || loss == nil || *loss != 0 {
		t.Fatalf("target port must be tried first: ok=%v ms=%v loss=%v", ok, ms, loss)
	}
}

// TestProbeOneBudget 不可达目标应在预算内放弃（旧实现 3轮×3端口×timeout 满额 22.5s）。
//
// 用 RFC5737 TEST-NET-1（192.0.2.1）作黑洞：正常环境无路由应答，拨号吃满 timeout。
// 环境差异（如立即返回 no route）会让预算分支测不到，但断言仍成立——故断言放宽为
// ok=false 且总耗时 < 1s（预算 300ms + 余量；旧实现 6 次×200ms = 1.2s 会超）。
func TestProbeOneBudget(t *testing.T) {
	const timeout = 200 * time.Millisecond
	const budget = 300 * time.Millisecond
	t0 := time.Now()
	ms, ok, loss := probeOne("192.0.2.1", 53, timeout, budget)
	elapsed := time.Since(t0)
	if ok || ms != nil || loss == nil || *loss != 100 {
		t.Fatalf("probeOne ok=%v ms=%v loss=%v, want ok=false loss=100", ok, ms, loss)
	}
	if elapsed > time.Second {
		t.Fatalf("probeOne took %v, want within budget ~%v (legacy would be 1.2s)", elapsed, budget)
	}
}

// TestProbeRunnerSnapshot 验证后台缓存：启动后快照就绪、拷贝与内部隔离。
func TestProbeRunnerSnapshot(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Skipf("cannot listen on loopback: %v", err)
	}
	defer ln.Close()
	port := ln.Addr().(*net.TCPAddr).Port

	targets := []ProbeTarget{
		{Label: "UP", Host: "127.0.0.1", Port: port},
		// 不放 DOWN 目标：模拟"必失败"的本地地址依赖具体环境（127.0.0.1:1
		// 在有进程监听 port 1 的机器上会成功）；失败路径由 TestProbeOneBudget
		// 与 TestProbeOneTargetPortFirst 在单元级覆盖，此处只验快照就绪与拷贝语义。
	}
	r := NewProbeRunner(targets)
	r.interval = 50 * time.Millisecond // 测试用短周期
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r.Start(ctx)

	// 等首轮就绪（UP 目标端口优先即中）
	deadline := time.Now().Add(5 * time.Second)
	for {
		snap := r.Snapshot()
		if snap != nil {
			if v, ok := snap["UP"]; !ok || !v.Ok || v.Ms == nil {
				t.Fatalf("UP probe = %+v, want ok", v)
			}
			// 拷贝语义：改动返回值不影响内部快照
			snap["UP"] = Probe{}
			if r.Snapshot()["UP"].Ok != true {
				t.Fatal("Snapshot must return a copy")
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("Snapshot still nil after 5s")
		}
		time.Sleep(20 * time.Millisecond)
	}
}
