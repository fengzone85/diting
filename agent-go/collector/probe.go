package collector

import (
	"context"
	"crypto/tls"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// maxProbeTargets 与 validate.js 的「键 ≤ 8」上限一致，超出部分静默丢弃。
const maxProbeTargets = 8

// ParseProbeTargets 解析 PROBE_TARGETS 环境变量格式：
//
//	label:host[:port]                 TCP 探测（端口缺省 53）
//	label:http://host[:port]/path      HTTP 探测（端口缺省 80）
//	label:https://host[:port]/path     HTTPS 探测（端口缺省 443，附带证书剩余天数）
//	host / http(s)://...               裸目标（label 取主机名）
//
// 校验规则（对齐 Python collector.py:265-299 与服务端 validate.js）：
//   - label ≤ 24 字符（超长截断）
//   - host ≤ 253 字符
//   - port ∈ [1, 65535]
//   - 最多 8 个目标
func ParseProbeTargets(spec string) []ProbeTarget {
	if spec == "" {
		return nil
	}
	var out []ProbeTarget
	for _, part := range strings.Split(spec, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		label, rest := splitLabel(part)
		var (
			tgt ProbeTarget
			ok  bool
		)
		if hasHTTPScheme(rest) {
			tgt, ok = parseHTTPTarget(label, rest)
		} else {
			tgt, ok = parseTCPTarget(label, rest)
		}
		if !ok {
			continue
		}
		out = append(out, tgt)
		if len(out) >= maxProbeTargets {
			break
		}
	}
	return out
}

// splitLabel 把 "label:target" 拆成两段。
// 裸 URL 的冒号属于 scheme，不能按首个冒号切，否则 label 会变成 "https"。
func splitLabel(part string) (label, rest string) {
	if hasHTTPScheme(part) {
		// 裸 URL 无 label：交回空 label，由 normalizeProbeLabel 用主机名兜底。
		return "", part
	}
	if idx := strings.Index(part, ":"); idx >= 0 {
		return strings.TrimSpace(part[:idx]), part[idx+1:]
	}
	return part, part
}

func hasHTTPScheme(s string) bool {
	l := strings.ToLower(s)
	return strings.HasPrefix(l, "http://") || strings.HasPrefix(l, "https://")
}

// parseTCPTarget 解析 TCP 目标。除 host:port 外兼容裸 IPv6：
// 旧实现用 LastIndex 取端口，会把 "2606:4700::1111" 的 "1111" 当成端口；
// 这里只在「单冒号」时按 host:port 拆，多冒号一律当裸主机（端口 53）。
func parseTCPTarget(label, rest string) (ProbeTarget, bool) {
	host := rest
	port := 53
	if h, p, err := net.SplitHostPort(rest); err == nil {
		host = h
		if n, e := strconv.Atoi(p); e == nil {
			port = n
		}
	} else if strings.Count(rest, ":") == 1 {
		idx := strings.LastIndex(rest, ":")
		host = rest[:idx]
		if n, e := strconv.Atoi(rest[idx+1:]); e == nil {
			port = n
		} else {
			host = rest // 冒号后不是端口，整体当主机名
		}
	}
	host = strings.Trim(strings.TrimSpace(host), "[]")
	if host == "" || len(host) > 253 {
		return ProbeTarget{}, false
	}
	if port < 1 || port > 65535 {
		return ProbeTarget{}, false
	}
	return ProbeTarget{Label: normalizeProbeLabel(label, host), Host: host, Port: port}, true
}

// parseHTTPTarget 解析 HTTP(S) 目标，端口缺省 80/443。
func parseHTTPTarget(label, rest string) (ProbeTarget, bool) {
	u, err := url.Parse(strings.TrimSpace(rest))
	if err != nil || u.Host == "" {
		return ProbeTarget{}, false
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return ProbeTarget{}, false
	}
	host := u.Hostname()
	if host == "" || len(host) > 253 {
		return ProbeTarget{}, false
	}
	port := 80
	if scheme == "https" {
		port = 443
	}
	if p := u.Port(); p != "" {
		n, e := strconv.Atoi(p)
		if e != nil || n < 1 || n > 65535 {
			return ProbeTarget{}, false
		}
		port = n
	}
	u.Scheme = scheme
	return ProbeTarget{
		Label:  normalizeProbeLabel(label, host),
		Host:   host,
		Port:   port,
		Scheme: scheme,
		URL:    u.String(),
	}, true
}

// normalizeProbeLabel 空 label 回退主机名，超长截断到 24 字符（与服务端一致）。
func normalizeProbeLabel(label, host string) string {
	label = strings.TrimSpace(label)
	if label == "" {
		label = host
	}
	if len(label) > 24 {
		label = label[:24]
	}
	return label
}

// probeOne 对单个目标做 TCP 探测，返回 (ms, ok, loss)。
//
// 策略（对齐 Python collector.py:302-354，端口序按 Go 纯 TCP 特性调整）：
//   - 端口序：目标端口优先，再 443/80。DNS 目标的 TCP:53 几乎必通且 RTT 最有
//     代表性——若 443/80 排前面且被 DROP（各吃满 timeout），预算内 53 会永远
//     轮不到（实测 CU/GG 误报离线的根因），故目标端口必须排最前。
//   - 重试 3 次吸收抖动
//   - budget 总预算：累计耗时达到预算立即放弃，防不可达目标无限重试；
//     默认 8s = 3轮×3端口×2.5s 全覆盖 + 防呆余量（探测已后台化，预算
//     不再影响上报节奏，仅封顶单目标耗时）
//   - 纯 TCP 握手时延，不采任何主机指纹
//
// loss 口径：纯 TCP 无 ICMP 丢包统计，故只给二值 ——
// 握手成功 → 0，预算内全部失败 → 100。不伪造中间值（如 33/66），
// 因为「三轮重试中有几次失败」不代表链路丢包率。
func probeOne(host string, port int, timeout time.Duration, budget time.Duration) (ms *float64, ok bool, loss *float64) {
	zero, hundred := 0.0, 100.0
	ports := []int{port}
	if port != 443 && port != 80 {
		ports = append(ports, 443, 80)
	}
	start := time.Now()
	for attempt := 0; attempt < 3; attempt++ {
		for _, p := range ports {
			if time.Since(start) >= budget {
				return nil, false, &hundred
			}
			dialStart := time.Now()
			conn, err := net.DialTimeout("tcp", net.JoinHostPort(host, strconv.Itoa(p)), timeout)
			if err != nil {
				continue
			}
			elapsed := time.Since(dialStart).Seconds() * 1000
			conn.Close()
			v := round1(elapsed)
			return &v, true, &zero
		}
	}
	return nil, false, &hundred
}

// httpProbeTimeout HTTP 探测单目标超时（对齐 F4 方案：5s）。
const httpProbeTimeout = 5 * time.Second

// httpProbeClient 包级复用的 HTTP 探测客户端（避免每轮每目标新建 Transport）。
//
// 三个刻意选择：
//  1. InsecureSkipVerify：探测只回答「能否拿到 HTTP 响应」与「证书还剩几天」。
//     自签/私有 CA 的内网站点若因信任链失败被判 down，可用率会长期 0%；
//     证书过期由 cert_days 独立告警，不依赖握手失败。只读探测，不传输任何数据。
//  2. 不跟随重定向：3xx 本身即「服务可达」；跟随会把状态码与证书换成跳转后目标的，
//     导致证书倒计时指向错误的域名。
//  3. 不走 ProxyFromEnvironment：Agent 环境里的代理变量不应改变探测口径。
var httpProbeClient = &http.Client{
	Timeout: httpProbeTimeout,
	Transport: &http.Transport{
		Proxy:             nil,
		DisableKeepAlives: true,
		TLSClientConfig:   &tls.Config{InsecureSkipVerify: true}, //nolint:gosec // 只读探测，理由见上
	},
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		return http.ErrUseLastResponse
	},
}

// probeHTTP 对单个 HTTP(S) 目标做一次 GET 探测。
//
// 与 TCP 探测的口径差异：不做 3 次重试——HTTP 是一次完整请求（含 TLS 握手与响应头），
// 重试会成倍拉长单目标耗时（3×5s）；握手抖动已由 60s 一轮的后台节奏吸收。
// 成功判定与 nezha/CF 一致：2xx/3xx 为 ok，4xx/5xx/超时/连接失败为 not-ok。
func probeHTTP(t ProbeTarget) Probe {
	p := Probe{Type: "http"}
	start := time.Now()
	resp, err := httpProbeClient.Get(t.URL)
	if err != nil {
		hundred := 100.0
		p.Loss = &hundred
		return p
	}
	defer resp.Body.Close()
	// 只读 4 KiB 后丢弃：探测不消费响应体内容，但要读一点以覆盖 TLS/首包路径。
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))

	elapsed := float64(time.Since(start).Microseconds()) / 1000
	ms := round1(elapsed)
	p.Ms = &ms
	code := resp.StatusCode
	p.Code = &code
	p.Ok = code >= 200 && code < 400
	loss := 100.0
	if p.Ok {
		loss = 0
	}
	p.Loss = &loss
	if resp.TLS != nil && len(resp.TLS.PeerCertificates) > 0 {
		days := certDaysLeft(time.Now(), resp.TLS.PeerCertificates[0].NotAfter)
		p.CertDays = &days
	}
	return p
}

// certDaysLeft 把证书到期时间换算为剩余天数（向上取整）。
// 已过期统一记 0：与服务端 0..3650 的校验范围一致，且「过期」与「当天到期」
// 对告警处理没有区别（都该立即续签），无需单独编码。
func certDaysLeft(now, notAfter time.Time) int {
	days := int(math.Ceil(notAfter.Sub(now).Hours() / 24))
	if days < 0 {
		return 0
	}
	if days > 3650 {
		return 3650
	}
	return days
}

// DefaultProbeInterval 探测缓存刷新周期（与 Linux Python 版 collector.py 的
// _probes_cache 60s 间隔对齐）。
const DefaultProbeInterval = 60 * time.Second

// probeTimeout / probeBudget 单次拨号超时与单目标总预算。
// 预算 8s = 3轮×3端口×2.5s 全覆盖 + 余量：探测在后台独立节奏跑，预算只是
// 防呆封顶（旧同步实现里 22.5s 会直接拖慢上报，现已无此问题）。
const (
	probeTimeout = 2500 * time.Millisecond
	probeBudget  = 8 * time.Second
)

// ProbeRunner 后台探测缓存：以独立节奏并发探测所有目标，上报方取最近一轮快照。
//
// 对齐 Linux Python 版 _probes_cache 设计（探测独立 60s 间隔，不阻塞上报主循环）：
// 不可达目标（如对 TCP 443/80/53 全拒的运营商 DNS）只影响自身结果为 loss=100，
// 绝不拖慢上报节奏。零依赖，goroutine + sync.RWMutex 实现。
type ProbeRunner struct {
	targets  []ProbeTarget
	interval time.Duration

	mu   sync.RWMutex
	snap map[string]Probe
}

// NewProbeRunner 创建探测器。targets 为空时 Start 为 no-op，Snapshot 恒 nil。
func NewProbeRunner(targets []ProbeTarget) *ProbeRunner {
	return &ProbeRunner{targets: targets, interval: DefaultProbeInterval}
}

// Start 启动后台探测：立即并发跑首轮（预算内最多 ~5s），随后每 interval 刷新。
// ctx 取消即退出。调用方不需等待——上报侧用 Snapshot() 拿最近结果即可。
func (r *ProbeRunner) Start(ctx context.Context) {
	if len(r.targets) == 0 {
		return
	}
	go func() {
		r.refresh()
		ticker := time.NewTicker(r.interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				r.refresh()
			}
		}
	}()
}

// refresh 并发探测一轮，整体写回快照（读方要么看到上一轮完整结果，要么 nil，
// 不存在半新半旧的混合）。TCP 与 HTTP 目标共用同一轮并发，单目标失败只影响自身。
func (r *ProbeRunner) refresh() {
	results := make(map[string]Probe, len(r.targets))
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, t := range r.targets {
		wg.Add(1)
		go func(tgt ProbeTarget) {
			defer wg.Done()
			var p Probe
			if tgt.Scheme != "" {
				p = probeHTTP(tgt)
			} else {
				// TCP 不带 type：与老版本上报完全一致，服务端按 tcp 缺省处理。
				ms, ok, loss := probeOne(tgt.Host, tgt.Port, probeTimeout, probeBudget)
				p = Probe{Ok: ok, Ms: ms, Loss: loss}
			}
			mu.Lock()
			results[tgt.Label] = p
			mu.Unlock()
		}(t)
	}
	wg.Wait()
	r.mu.Lock()
	r.snap = results
	r.mu.Unlock()
}

// Snapshot 返回最近一轮探测结果的拷贝；首轮完成前返回 nil（上报不带 probes 字段）。
func (r *ProbeRunner) Snapshot() map[string]Probe {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if len(r.snap) == 0 {
		return nil
	}
	out := make(map[string]Probe, len(r.snap))
	for k, v := range r.snap {
		out[k] = v
	}
	return out
}

// round1 四舍五入到 1 位小数（对齐 Python round(ms, 1)）。
func round1(v float64) float64 {
	return float64(uint64(v*10+0.5)) / 10
}
