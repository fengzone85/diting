package main

import (
	"testing"
	"time"

	"github.com/fengzone85/diting/agent-go/collector"
)

const (
	testFast = 15 * time.Second
	testSlow = 60 * time.Second
)

func metrics(mut func(*collector.Metrics)) *collector.Metrics {
	m := &collector.Metrics{}
	if mut != nil {
		mut(m)
	}
	return m
}

// steady 是一组「相邻两轮完全平稳」的指标，作为多数用例的基线。
func steady() *collector.Metrics {
	return metrics(func(m *collector.Metrics) {
		m.CPU = 10
		m.MemTotal = 1000
		m.MemUsed = 500
		m.Load1 = 1
	})
}

func TestAdaptiveInterval(t *testing.T) {
	const kb = 1024.0
	base := steady()

	cases := []struct {
		name       string
		prev, cur  *collector.Metrics
		streak     int
		want       time.Duration
		wantStreak int
	}{
		{
			name: "采集失败 → 快档，且不消耗防抖计数",
			prev: base, cur: nil, streak: 2,
			want: testFast, wantStreak: 2,
		},
		{
			name: "首报 → 快档建基线并置 3 轮防抖",
			prev: nil, cur: base,
			want: testFast, wantStreak: 3,
		},
		{
			name: "防抖期内即使指标平稳也继续快档",
			prev: base, cur: steady(), streak: 2,
			want: testFast, wantStreak: 1,
		},
		{
			name: "CPU 上升超过 15 个百分点",
			prev: metrics(func(m *collector.Metrics) { m.CPU = 10; m.MemTotal = 1000; m.MemUsed = 500; m.Load1 = 1 }),
			cur:  metrics(func(m *collector.Metrics) { m.CPU = 25.1; m.MemTotal = 1000; m.MemUsed = 500; m.Load1 = 1 }),
			want: testFast, wantStreak: 3,
		},
		{
			name: "CPU 变化恰好 15 个百分点不触发（严格大于）",
			prev: metrics(func(m *collector.Metrics) { m.CPU = 10; m.MemTotal = 1000; m.MemUsed = 500; m.Load1 = 1 }),
			cur:  metrics(func(m *collector.Metrics) { m.CPU = 25; m.MemTotal = 1000; m.MemUsed = 500; m.Load1 = 1 }),
			want: testSlow,
		},
		{
			name: "CPU 骤降同样触发（取绝对值）",
			prev: metrics(func(m *collector.Metrics) { m.CPU = 80; m.MemTotal = 1000; m.MemUsed = 500; m.Load1 = 1 }),
			cur:  metrics(func(m *collector.Metrics) { m.CPU = 50; m.MemTotal = 1000; m.MemUsed = 500; m.Load1 = 1 }),
			want: testFast, wantStreak: 3,
		},
		{
			name: "内存变化量占总内存超过 15%",
			prev: metrics(func(m *collector.Metrics) { m.CPU = 10; m.MemTotal = 1000; m.MemUsed = 100; m.Load1 = 1 }),
			cur:  metrics(func(m *collector.Metrics) { m.CPU = 10; m.MemTotal = 1000; m.MemUsed = 300; m.Load1 = 1 }),
			want: testFast, wantStreak: 3,
		},
		{
			name: "内存变化量恰好占总内存 15% 不触发",
			prev: metrics(func(m *collector.Metrics) { m.CPU = 10; m.MemTotal = 1000; m.MemUsed = 500; m.Load1 = 1 }),
			cur:  metrics(func(m *collector.Metrics) { m.CPU = 10; m.MemTotal = 1000; m.MemUsed = 650; m.Load1 = 1 }),
			want: testSlow,
		},
		{
			name: "MemTotal 为 0 时跳过内存判断（除零守卫）",
			prev: metrics(func(m *collector.Metrics) { m.CPU = 10; m.MemUsed = 0; m.Load1 = 1 }),
			cur:  metrics(func(m *collector.Metrics) { m.CPU = 10; m.MemUsed = 999; m.Load1 = 1 }),
			want: testSlow,
		},
		{
			name: "下行速率 >100KB/s 且相对变化 >100%",
			prev: metrics(func(m *collector.Metrics) {
				m.CPU = 10
				m.MemTotal = 1000
				m.MemUsed = 500
				m.NetRxRate = 100 * kb
				m.Load1 = 1
			}),
			cur: metrics(func(m *collector.Metrics) {
				m.CPU = 10
				m.MemTotal = 1000
				m.MemUsed = 500
				m.NetRxRate = 250 * kb
				m.Load1 = 1
			}),
			want: testFast, wantStreak: 3,
		},
		{
			name: "下行速率 >100KB/s 但相对变化不足 100%",
			prev: metrics(func(m *collector.Metrics) {
				m.CPU = 10
				m.MemTotal = 1000
				m.MemUsed = 500
				m.NetRxRate = 200 * kb
				m.Load1 = 1
			}),
			cur: metrics(func(m *collector.Metrics) {
				m.CPU = 10
				m.MemTotal = 1000
				m.MemUsed = 500
				m.NetRxRate = 250 * kb
				m.Load1 = 1
			}),
			want: testSlow,
		},
		{
			name: "下行速率未达 100KB/s 时即使变化巨大也不触发",
			prev: metrics(func(m *collector.Metrics) {
				m.CPU = 10
				m.MemTotal = 1000
				m.MemUsed = 500
				m.NetRxRate = 50 * kb
				m.Load1 = 1
			}),
			cur: metrics(func(m *collector.Metrics) {
				m.CPU = 10
				m.MemTotal = 1000
				m.MemUsed = 500
				m.NetRxRate = 99 * kb
				m.Load1 = 1
			}),
			want: testSlow,
		},
		{
			name: "上一轮速率为 0、本轮有大流量 → changeRatio 返回 2.0 触发（防 1.0>1.0 漏判）",
			prev: metrics(func(m *collector.Metrics) {
				m.CPU = 10
				m.MemTotal = 1000
				m.MemUsed = 500
				m.NetRxRate = 0
				m.Load1 = 1
			}),
			cur: metrics(func(m *collector.Metrics) {
				m.CPU = 10
				m.MemTotal = 1000
				m.MemUsed = 500
				m.NetRxRate = 200 * kb
				m.Load1 = 1
			}),
			want: testFast, wantStreak: 3,
		},
		{
			name: "上行速率 >100KB/s 且相对变化 >100%",
			prev: metrics(func(m *collector.Metrics) {
				m.CPU = 10
				m.MemTotal = 1000
				m.MemUsed = 500
				m.NetTxRate = 120 * kb
				m.Load1 = 1
			}),
			cur: metrics(func(m *collector.Metrics) {
				m.CPU = 10
				m.MemTotal = 1000
				m.MemUsed = 500
				m.NetTxRate = 400 * kb
				m.Load1 = 1
			}),
			want: testFast, wantStreak: 3,
		},
		{
			name: "负载突增超过 1.0",
			prev: metrics(func(m *collector.Metrics) { m.CPU = 10; m.MemTotal = 1000; m.MemUsed = 500; m.Load1 = 1 }),
			cur:  metrics(func(m *collector.Metrics) { m.CPU = 10; m.MemTotal = 1000; m.MemUsed = 500; m.Load1 = 2.1 }),
			want: testFast, wantStreak: 3,
		},
		{
			name: "负载突增恰好 1.0 不触发",
			prev: metrics(func(m *collector.Metrics) { m.CPU = 10; m.MemTotal = 1000; m.MemUsed = 500; m.Load1 = 1 }),
			cur:  metrics(func(m *collector.Metrics) { m.CPU = 10; m.MemTotal = 1000; m.MemUsed = 500; m.Load1 = 2 }),
			want: testSlow,
		},
		{
			name: "负载骤降不触发（只关心突增）",
			prev: metrics(func(m *collector.Metrics) { m.CPU = 10; m.MemTotal = 1000; m.MemUsed = 500; m.Load1 = 5 }),
			cur:  metrics(func(m *collector.Metrics) { m.CPU = 10; m.MemTotal = 1000; m.MemUsed = 500; m.Load1 = 1 }),
			want: testSlow,
		},
		{
			name: "全平稳 → 慢档",
			prev: base, cur: steady(),
			want: testSlow,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			streak := c.streak
			got := adaptiveInterval(c.prev, c.cur, testFast, testSlow, &streak)
			if got != c.want {
				t.Fatalf("interval = %s, want %s", got, c.want)
			}
			if streak != c.wantStreak {
				t.Fatalf("fastStreak = %d, want %d", streak, c.wantStreak)
			}
		})
	}
}

// 触发快档后实际保持「触发轮 + 3 轮防抖」= 4 轮，第 5 轮才允许回慢档。
// 该用例把现行行为固化下来，避免日后只改注释不看代码。
func TestAdaptiveFastStreakRounds(t *testing.T) {
	streak := 0
	prev := steady()
	trigger := metrics(func(m *collector.Metrics) {
		m.CPU = 60
		m.MemTotal = 1000
		m.MemUsed = 500
		m.Load1 = 1
	})

	if got := adaptiveInterval(prev, trigger, testFast, testSlow, &streak); got != testFast {
		t.Fatalf("触发轮应为快档，实际 %s", got)
	}
	if streak != 3 {
		t.Fatalf("触发后 fastStreak 应为 3，实际 %d", streak)
	}

	// 指标保持平稳，后续 3 轮仍由防抖维持快档
	for i := 0; i < 3; i++ {
		if got := adaptiveInterval(trigger, trigger, testFast, testSlow, &streak); got != testFast {
			t.Fatalf("防抖第 %d 轮应为快档，实际 %s", i+1, got)
		}
	}
	if got := adaptiveInterval(trigger, trigger, testFast, testSlow, &streak); got != testSlow {
		t.Fatalf("防抖结束后应回慢档，实际 %s", got)
	}
}

func TestChangeRatio(t *testing.T) {
	cases := []struct {
		name      string
		prev, cur float64
		want      float64
	}{
		{name: "prev 为 0 视为显著变化（返回 2.0）", prev: 0, cur: 100, want: 2.0},
		{name: "prev 为负同样返回 2.0", prev: -1, cur: 0, want: 2.0},
		{name: "上涨 50%", prev: 100, cur: 150, want: 0.5},
		{name: "下降 50% 取绝对值", prev: 100, cur: 50, want: 0.5},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := changeRatio(c.prev, c.cur); got != c.want {
				t.Fatalf("changeRatio(%v, %v) = %v, want %v", c.prev, c.cur, got, c.want)
			}
		})
	}
}

func TestAbsf(t *testing.T) {
	if got := absf(-3.5); got != 3.5 {
		t.Fatalf("absf(-3.5) = %v", got)
	}
	if got := absf(3.5); got != 3.5 {
		t.Fatalf("absf(3.5) = %v", got)
	}
	if got := absf(0); got != 0 {
		t.Fatalf("absf(0) = %v", got)
	}
}
