package collector

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// TestParseProbeTargets 覆盖解析规则：TCP（label:host:port / 默认 53）、
// HTTP（label:http(s)://... / 默认 80、443）、裸目标、IPv6、截断与上限。
func TestParseProbeTargets(t *testing.T) {
	tcp := func(label, host string, port int) ProbeTarget {
		return ProbeTarget{Label: label, Host: host, Port: port}
	}
	cases := []struct {
		name string
		in   string
		want []ProbeTarget
	}{
		{"空串", "", nil},
		{"默认端口", "GG:8.8.8.8", []ProbeTarget{tcp("GG", "8.8.8.8", 53)}},
		{"完整三段", "CM:211.136.192.6:443", []ProbeTarget{tcp("CM", "211.136.192.6", 443)}},
		{"多目标", "CM:211.136.192.6,CT:101.226.4.6,CU:202.106.0.20,GG:8.8.8.8",
			[]ProbeTarget{tcp("CM", "211.136.192.6", 53), tcp("CT", "101.226.4.6", 53), tcp("CU", "202.106.0.20", 53), tcp("GG", "8.8.8.8", 53)}},
		{"label超长截断到24", string(make([]byte, 0)) + repeat('x', 30) + ":8.8.8.8", []ProbeTarget{tcp(repeat('x', 24), "8.8.8.8", 53)}},
		{"非法端口丢弃", "CM:211.136.192.6:99999", nil},
		{"空host丢弃", "CM:", nil},
		{"裸主机", "8.8.8.8", []ProbeTarget{tcp("8.8.8.8", "8.8.8.8", 53)}},
		{"IPv6带端口", "V6:[2606:4700:4700::1111]:443",
			[]ProbeTarget{tcp("V6", "2606:4700:4700::1111", 443)}},
		{"裸IPv6不被误拆端口", "V6:2606:4700:4700::1111",
			[]ProbeTarget{tcp("V6", "2606:4700:4700::1111", 53)}},
		{"HTTP目标", "WEB:https://example.com/health",
			[]ProbeTarget{{Label: "WEB", Host: "example.com", Port: 443, Scheme: "https", URL: "https://example.com/health"}}},
		{"HTTP默认端口", "WEB:http://example.com",
			[]ProbeTarget{{Label: "WEB", Host: "example.com", Port: 80, Scheme: "http", URL: "http://example.com"}}},
		{"HTTP显式端口", "WEB:https://example.com:8443/x",
			[]ProbeTarget{{Label: "WEB", Host: "example.com", Port: 8443, Scheme: "https", URL: "https://example.com:8443/x"}}},
		{"大写scheme归一", "WEB:HTTPS://example.com",
			[]ProbeTarget{{Label: "WEB", Host: "example.com", Port: 443, Scheme: "https", URL: "https://example.com"}}},
		{"裸URL label取主机名", "https://example.com/p",
			[]ProbeTarget{{Label: "example.com", Host: "example.com", Port: 443, Scheme: "https", URL: "https://example.com/p"}}},
		{"非法URL丢弃", "WEB:https://", nil},
		{"超过8个截断", "a:1.1.1.1,b:1.1.1.2,c:1.1.1.3,d:1.1.1.4,e:1.1.1.5,f:1.1.1.6,g:1.1.1.7,h:1.1.1.8,i:1.1.1.9",
			[]ProbeTarget{tcp("a", "1.1.1.1", 53), tcp("b", "1.1.1.2", 53), tcp("c", "1.1.1.3", 53), tcp("d", "1.1.1.4", 53),
				tcp("e", "1.1.1.5", 53), tcp("f", "1.1.1.6", 53), tcp("g", "1.1.1.7", 53), tcp("h", "1.1.1.8", 53)}},
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
	if ok == nil || !*ok || ms == nil || loss == nil || *loss != 0 {
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
	if ok == nil || !*ok || ms == nil || loss == nil || *loss != 0 {
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
	if ok == nil || *ok || ms != nil || loss == nil || *loss != 100 {
		t.Fatalf("probeOne ok=%v ms=%v loss=%v, want ok=false loss=100", ok, ms, loss)
	}
	if elapsed > time.Second {
		t.Fatalf("probeOne took %v, want within budget ~%v (legacy would be 1.2s)", elapsed, budget)
	}
}

// TestProbeHTTP 验证 HTTP 探测成功口径：2xx → ok、记录状态码与耗时、loss=0。
func TestProbeHTTP(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	tgt, ok := parseHTTPTarget("WEB", srv.URL)
	if !ok {
		t.Fatalf("parseHTTPTarget(%q) failed", srv.URL)
	}
	p := probeHTTP(tgt)
	if p.Ok == nil || !*p.Ok || p.Type != "http" || p.Code == nil || *p.Code != 200 {
		t.Fatalf("probeHTTP = %+v, want ok/http/200", p)
	}
	if p.Ms == nil || *p.Ms < 0 || p.Loss == nil || *p.Loss != 0 {
		t.Fatalf("probeHTTP ms/loss = %v/%v, want >=0/0", p.Ms, p.Loss)
	}
	if p.CertDays != nil {
		t.Fatalf("http target must not report cert_days, got %d", *p.CertDays)
	}
}

// TestProbeHTTPStatusFail 4xx/5xx 视为不可用：ok=false、loss=100，但状态码与耗时仍保留。
func TestProbeHTTPStatusFail(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	tgt, ok := parseHTTPTarget("WEB", srv.URL)
	if !ok {
		t.Fatalf("parseHTTPTarget(%q) failed", srv.URL)
	}
	p := probeHTTP(tgt)
	if p.Ok == nil || *p.Ok || p.Code == nil || *p.Code != 500 {
		t.Fatalf("probeHTTP = %+v, want not-ok/500", p)
	}
	if p.Loss == nil || *p.Loss != 100 || p.Ms == nil {
		t.Fatalf("probeHTTP ms/loss = %v/%v, want kept/100", p.Ms, p.Loss)
	}
}

// TestProbeHTTPSCertDays 验证 https 探测附带证书剩余天数（自签证书也应能取到）。
func TestProbeHTTPSCertDays(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	tgt, ok := parseHTTPTarget("TLS", srv.URL)
	if !ok {
		t.Fatalf("parseHTTPTarget(%q) failed", srv.URL)
	}
	p := probeHTTP(tgt)
	if p.Ok == nil || !*p.Ok || p.Type != "http" {
		t.Fatalf("probeHTTP = %+v, want ok", p)
	}
	if p.CertDays == nil || *p.CertDays <= 0 || *p.CertDays > 3650 {
		t.Fatalf("cert_days = %v, want 1..3650", p.CertDays)
	}
}

// TestCertDaysLeft 边界：向上取整、过期归零、上限 3650。
func TestCertDaysLeft(t *testing.T) {
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		name     string
		notAfter time.Time
		want     int
	}{
		{"整30天", now.Add(30 * 24 * time.Hour), 30},
		{"不足1天向上取整", now.Add(2 * time.Hour), 1},
		{"已过期归零", now.Add(-48 * time.Hour), 0},
		{"超长上限", now.AddDate(20, 0, 0), 3650},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := certDaysLeft(now, c.notAfter); got != c.want {
				t.Fatalf("certDaysLeft() = %d, want %d", got, c.want)
			}
		})
	}
}

// TestProbeRunnerHTTP 验证 HTTP 目标同样进入后台快照（与 TCP 共用一轮并发）。
func TestProbeRunnerHTTP(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	tgt, ok := parseHTTPTarget("WEB", srv.URL)
	if !ok {
		t.Fatalf("parseHTTPTarget(%q) failed", srv.URL)
	}

	r := NewProbeRunner([]ProbeTarget{tgt})
	r.interval = time.Hour
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r.Start(ctx)

	deadline := time.Now().Add(5 * time.Second)
	for {
		snap := r.Snapshot()
		if snap != nil {
			v, exists := snap["WEB"]
			if !exists || v.Ok == nil || !*v.Ok || v.Type != "http" || v.Code == nil || *v.Code != 200 {
				t.Fatalf("WEB probe = %+v, want ok/http/200", v)
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("Snapshot still nil after 5s")
		}
		time.Sleep(20 * time.Millisecond)
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
			if v, ok := snap["UP"]; !ok || v.Ok == nil || !*v.Ok || v.Ms == nil {
				t.Fatalf("UP probe = %+v, want ok", v)
			}
			// 拷贝语义：改动返回值不影响内部快照
			snap["UP"] = Probe{}
			if o := r.Snapshot()["UP"].Ok; o == nil || !*o {
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

// TestProbeMarshalTriState 三态序列化：无采样必须是 {"ok":null,"ms":null,"loss":null}，
// 三个字段都要在（Ok 不能加 omitempty，否则 null 会被整个省略）。
func TestProbeMarshalTriState(t *testing.T) {
	b, err := json.Marshal(Probe{})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	got := string(b)
	for _, want := range []string{`"ok":null`, `"ms":null`, `"loss":null`} {
		if !strings.Contains(got, want) {
			t.Fatalf("marshal Probe{} = %s, want %s", got, want)
		}
	}
}

// TestProbeOneResolveTimeoutNoSample 解析超时 → 无采样（ok/ms/loss 全 nil），
// 与「解析报错 → 不可达」严格区分。
func TestProbeOneResolveTimeoutNoSample(t *testing.T) {
	old := probeResolveTimeout
	probeResolveTimeout = time.Nanosecond
	defer func() { probeResolveTimeout = old }()
	ms, ok, loss := probeOne("diting-resolve-timeout.invalid", 53, 100*time.Millisecond, 500*time.Millisecond)
	if ms != nil || ok != nil || loss != nil {
		t.Fatalf("resolve timeout = (%v,%v,%v), want (nil,nil,nil)", ms, ok, loss)
	}
}
