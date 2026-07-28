// adaptive.go 实现纯本地的上报间隔自适应。
//
// 设计原则：完全不解析服务端响应，守 diting 纯单向安全模型（无下行通道）。
// 通过对比相邻两轮采集指标的变化率，本地决策下轮间隔：
//   - 关键指标显著变化 → 快档（实时捕捉异常）
//   - 平稳 → 慢档（省流量）
//   - 首报/采集失败 → 快档（快速建基线 / 快速恢复）
//   - 防抖：进入快档后至少保持 3 轮，避免边界抖动反复切换
//
// 注意：慢档间隔必须小于服务端 OFFLINE_THRESHOLD_SEC（建议慢档 60s 配阈值 120s），
// 否则平稳期会因 last_seen 间隔过大被误判离线。
package main

import (
	"math"
	"time"

	"github.com/fengzone85/diting/agent-go/collector"
)

// adaptiveInterval 根据指标变化率决定下轮上报间隔。
// fastStreak 为防抖计数（指针，跨轮保持）：>0 时强制快档并递减。
func adaptiveInterval(prev, cur *collector.Metrics, fast, slow time.Duration, fastStreak *int) time.Duration {
	// 采集失败 → 快档（快速重试）
	if cur == nil {
		return fast
	}
	// 首报 → 快档建基线，并要求至少 3 轮快档
	if prev == nil {
		*fastStreak = 3
		return fast
	}
	// 防抖：快档未满 3 轮，继续快档
	if *fastStreak > 0 {
		*fastStreak--
		return fast
	}

	// CPU 绝对变化 > 15 个百分点
	if absf(cur.CPU-prev.CPU) > 15 {
		*fastStreak = 3
		return fast
	}
	// 内存使用相对变化 > 5%
	if cur.MemTotal > 0 {
		dMem := math.Abs(float64(cur.MemUsed) - float64(prev.MemUsed))
		if dMem/float64(cur.MemTotal) > 0.15 {
			*fastStreak = 3
			return fast
		}
	}
	// 网络速率显著变化（当前 >10KB/s 且相对变化 >50%）
	if cur.NetRxRate > 100*1024 && changeRatio(prev.NetRxRate, cur.NetRxRate) > 1.0 {
		*fastStreak = 3
		return fast
	}
	if cur.NetTxRate > 100*1024 && changeRatio(prev.NetTxRate, cur.NetTxRate) > 1.0 {
		*fastStreak = 3
		return fast
	}
	// 负载突增 > 1.0
	if cur.Load1-prev.Load1 > 1.0 {
		*fastStreak = 3
		return fast
	}

	return slow
}

func absf(v float64) float64 {
	if v < 0 {
		return -v
	}
	return v
}

// changeRatio 返回 |cur-prev|/prev；prev<=0 时返回 2.0（从无到有视为显著变化）。
// 注意：返回值需 >1.0 才触发快档，故 prev<=0 时返回 2.0 而非 1.0，
// 否则 "prev=0 且 cur 大" 会因 1.0>1.0=false 漏触发。
// 配合调用处 cur>100KB/s 的前置条件，只有"当前有大流量且之前无"才触发。
func changeRatio(prev, cur float64) float64 {
	if prev <= 0 {
		return 2.0
	}
	return math.Abs(cur-prev) / prev
}
