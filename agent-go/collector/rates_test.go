//go:build linux

package collector

import (
	"math"
	"testing"
)

// rateFromCounter 的口径：只有严格递增才出速率，其余（回退 / 无增量 / dt<=0）一律 0。
//
// 回退保护的必要性：磁盘计数器在设备重建、热插拔、虚拟机磁盘重置时会变小，
// uint64 相减下溢成 ~1.8e19 ⇒ 速率算出天文数字 ⇒ 面板出现「1000 TB/s」尖刺。
// 网络分支一直有这个保护，磁盘分支此前是裸相减（本次统一）。
func TestRateFromCounter(t *testing.T) {
	cases := []struct {
		name      string
		cur, prev uint64
		dt        float64
		want      float64
	}{
		{"正常递增", 150, 50, 2, 50},
		{"计数器回退（设备重建/热插拔）", 50, 150, 1, 0},
		{"回退且幅度极大（下溢场景）", 1, math.MaxUint64 - 10, 1, 0},
		{"无增量", 100, 100, 1, 0},
		{"dt 为 0", 150, 50, 0, 0},
		{"dt 为负", 150, 50, -1, 0},
		{"起始（prev=0）", 100, 0, 1, 100},
		{"两者皆为 0", 0, 0, 1, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := rateFromCounter(c.cur, c.prev, c.dt)
			if got != c.want {
				t.Fatalf("rateFromCounter(%d, %d, %v) = %v, want %v", c.cur, c.prev, c.dt, got, c.want)
			}
			if math.IsNaN(got) || math.IsInf(got, 0) {
				t.Fatalf("返回了 NaN/Inf: %v", got)
			}
		})
	}
}

// 下溢必须被挡住，不能让「天文数字」流到上报里（服务端 1e15 钳位只是兜底）。
func TestRateFromCounterNeverOverflows(t *testing.T) {
	got := rateFromCounter(1, math.MaxUint64, 1)
	if got != 0 {
		t.Fatalf("下溢未被挡住：got %v", got)
	}
	if got > 1e15 {
		t.Fatalf("返回值超过服务端钳位阈值：%v", got)
	}
}
