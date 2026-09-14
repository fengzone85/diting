package collector

import (
	"context"
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ParseProbeTargets 解析 PROBE_TARGETS 环境变量格式：label:host[:port],...
//
// 校验规则（对齐 Python collector.py:265-299 与服务端 validate.js）：
//   - label ≤ 24 字符（超长截断）
//   - host ≤ 253 字符
//   - port ∈ [1, 65535]，默认 53
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
		if !strings.Contains(part, ":") {
			// 只有 host，默认 port=53
			if len(part) > 253 {
				continue
			}
			out = append(out, ProbeTarget{Label: part, Host: part, Port: 53})
			continue
		}
		label := part
		host := part
		port := 53
		// 拆 label:host:port
		if idx := strings.Index(part, ":"); idx >= 0 {
			label = strings.TrimSpace(part[:idx])
			rest := part[idx+1:]
			// rest 可能是 host 或 host:port
			if pIdx := strings.LastIndex(rest, ":"); pIdx >= 0 {
				host = rest[:pIdx]
				p, err := strconv.Atoi(rest[pIdx+1:])
				if err == nil {
					port = p
				}
			} else {
				host = rest
			}
		}
		// 校验
		if host == "" || len(host) > 253 {
			continue
		}
		if port < 1 || port > 65535 {
			continue
		}
		label = strings.TrimSpace(label)
		if label == "" {
			label = host
		}
		if len(label) > 24 {
			label = label[:24]
		}
		out = append(out, ProbeTarget{Label: label, Host: host, Port: port})
		if len(out) >= 8 {
			break
		}
	}
	return out
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
			conn, err := net.DialTimeout("tcp", fmt.Sprintf("%s:%d", host, p), timeout)
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
// 不存在半新半旧的混合）。
func (r *ProbeRunner) refresh() {
	results := make(map[string]Probe, len(r.targets))
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, t := range r.targets {
		wg.Add(1)
		go func(tgt ProbeTarget) {
			defer wg.Done()
			ms, ok, loss := probeOne(tgt.Host, tgt.Port, probeTimeout, probeBudget)
			mu.Lock()
			results[tgt.Label] = Probe{Ok: ok, Ms: ms, Loss: loss}
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
