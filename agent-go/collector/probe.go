package collector

import (
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

// probeOne 对单个目标做 TCP 探测，返回 (ms, ok)。
//
// 策略（对齐 Python collector.py:302-354）：
//   - 依次尝试 443/80/目标端口（443/80 最常被放行）
//   - 重试 3 次吸收抖动
//   - 纯 TCP 握手时延，不采任何主机指纹
func probeOne(host string, port int, timeout time.Duration) (ms *float64, ok bool) {
	ports := []int{443, 80}
	if port != 443 && port != 80 {
		ports = append(ports, port)
	}
	for attempt := 0; attempt < 3; attempt++ {
		for _, p := range ports {
			start := time.Now()
			conn, err := net.DialTimeout("tcp", fmt.Sprintf("%s:%d", host, p), timeout)
			if err != nil {
				continue
			}
			elapsed := time.Since(start).Seconds() * 1000
			conn.Close()
			v := round1(elapsed)
			return &v, true
		}
	}
	return nil, false
}

// ProbeAll 并发探测所有目标（sync.WaitGroup + goroutine，参考 Pulse 模式）。
// 与 Python ThreadPoolExecutor 等价。
func ProbeAll(targets []ProbeTarget) map[string]Probe {
	if len(targets) == 0 {
		return nil
	}
	results := make(map[string]Probe, len(targets))
	var mu sync.Mutex
	var wg sync.WaitGroup

	for _, t := range targets {
		wg.Add(1)
		go func(tgt ProbeTarget) {
			defer wg.Done()
			ms, ok := probeOne(tgt.Host, tgt.Port, 2500*1000*1000) // 2.5s
			mu.Lock()
			results[tgt.Label] = Probe{Ok: ok, Ms: ms}
			mu.Unlock()
		}(t)
	}
	wg.Wait()
	return results
}

// round1 四舍五入到 1 位小数（对齐 Python round(ms, 1)）。
func round1(v float64) float64 {
	return float64(uint64(v*10+0.5)) / 10
}
