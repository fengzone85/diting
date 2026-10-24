// diting-agent Go 版受控端。
//
// 只采性能数据，不采指纹。单向上报，零入站，无指令通道。
// 上报间隔支持纯本地自适应（不解析服务端响应）：指标变化大→快档，平稳→慢档。
package main

import (
	"context"
	"encoding/json"
	"log"
	"os/signal"
	"runtime/debug"
	"syscall"
	"time"

	"github.com/fengzone85/diting/agent-go/collector"
	"github.com/fengzone85/diting/agent-go/config"
	"github.com/fengzone85/diting/agent-go/reporter"
)

// memLimit 是 Agent 的软内存上限（32 MB）。
const memLimit = 32 * 1024 * 1024

// version 用 var 而非 const，以便 Makefile 通过 -ldflags "-X main.version=..."
// 在构建时注入版本号（-X 只能注入 string var，不能注入 const）。
var version = "1.0.0"

func main() {
	log.SetFlags(log.Ltime | log.Lshortfile)
	debug.SetMemoryLimit(memLimit)

	log.Printf("[agent] starting: version=%s mem_limit=%dMB", version, memLimit/1024/1024)

	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("[error] config: %v", err)
	}
	if err := cfg.Validate(); err != nil {
		log.Fatalf("[error] validate: %v", err)
	}

	if cfg.Debug {
		mode := "fixed"
		if cfg.Adaptive {
			mode = "adaptive"
		}
		log.Printf("[debug] server=%s id=%s mode=%s fast=%s slow=%s interval=%s disk=%s probes=%s iface_filter=%v iface_only=%q",
			cfg.ServerURL, cfg.AgentID, mode, cfg.FastInterval, cfg.SlowInterval, cfg.Interval, cfg.DiskPath, cfg.ProbeTargets, cfg.NetIfaceFilter, cfg.NetIfaceOnly)
	}

	c := collector.NewCollector(cfg.DiskPath, collector.NetIfaceOptions{
		Filter: cfg.NetIfaceFilter,
		Only:   collector.ParseIfaceOnly(cfg.NetIfaceOnly),
	})
	r := reporter.NewReporter(cfg.ServerURL, cfg.AgentID, cfg.AgentToken, cfg.Interval, version)
	targets := collector.ParseProbeTargets(cfg.ProbeTargets)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// 探测后台化：独立 60s 节奏刷新缓存，上报只取最近快照（不可达目标不拖慢上报）
	probes := collector.NewProbeRunner(targets)
	probes.Start(ctx)

	// 首次立即上报
	prevM := runOnce(ctx, c, r, probes, cfg)

	// 自适应状态：首报后强制 3 轮快档建基线
	var fastStreak int
	if cfg.Adaptive {
		fastStreak = 3
	}

	// 主循环：用 time.After 每轮新建定时器，避免 time.Ticker.Reset 在 runOnce
	// 耗时 > 间隔时产生的 channel 积压导致下轮立即触发（间隔失真）。
	for {
		// 本轮等待时长：自适应按 fastStreak 决定，固定模式用 INTERVAL
		wait := cfg.Interval
		if cfg.Adaptive {
			if fastStreak > 0 {
				wait = cfg.FastInterval
			} else {
				wait = cfg.SlowInterval
			}
		}
		select {
		case <-ctx.Done():
			log.Println("[agent] shutting down")
			return
		case <-time.After(wait):
			t0 := time.Now()
			m := runOnce(ctx, c, r, probes, cfg)
			d := time.Since(t0)
			if cfg.Adaptive {
				decided := adaptiveInterval(prevM, m, cfg.FastInterval, cfg.SlowInterval, &fastStreak)
				if cfg.Debug && prevM != nil && m != nil {
					log.Printf("[debug] adaptive: decided=%s wait=%s runOnce=%s (cpu=%.1f->%.1f mem=%d->%d net_rx=%.0f->%.0f net_tx=%.0f->%.0f load1=%.2f->%.2f)",
						decided, wait, d, prevM.CPU, m.CPU, prevM.MemUsed, m.MemUsed, prevM.NetRxRate, m.NetRxRate, prevM.NetTxRate, m.NetTxRate, prevM.Load1, m.Load1)
				}
			}
			prevM = m
		}
	}
}

// lastReportAt 记录上一次上报时刻，用于计算并上报本机的实际上报间隔（审查 C-1/E2）。
var lastReportAt time.Time

// runOnce 执行一次采集 + 上报，返回本轮指标（用于自适应判断；采集失败返回 nil）。
func runOnce(ctx context.Context, c collector.Collector, r *reporter.Reporter, probes *collector.ProbeRunner, cfg *config.Config) *collector.Metrics {
	t0 := time.Now()
	m, err := c.Collect()
	if err != nil {
		log.Printf("[error] collect: %v", err)
		return nil
	}
	// 审查 C-1/E2：上报本机实际上报间隔（距上次上报的秒数）。服务端用它
	// （并结合相邻 ts 观测）校正离线阈值与 AI 超阈值时长估算；首轮无上次
	// 时刻时留 0，服务端按"未上报"处理并回退到相邻 ts 观测。
	if !lastReportAt.IsZero() {
		if sec := int(time.Since(lastReportAt).Seconds()); sec > 0 {
			m.Interval = sec
		}
	}
	lastReportAt = time.Now()
	tCollect := time.Since(t0)

	// 探测快照 + 序列化。月累计不再本地累加（P4 cleanup）：服务端 traffic_state
	// 累加器以 net_rx/net_tx 绝对计数器为准，回写 net_rx_month/net_tx_month。
	tA := time.Now()
	m.Probes = probes.Snapshot()
	m.MonthRotate = cfg.MonthRotate
	payload, err := json.Marshal(m)
	if err != nil {
		log.Printf("[error] marshal: %v", err)
		return m
	}
	tMid := time.Since(tA)

	// 上报
	t1 := time.Now()
	if err := r.Report(ctx, payload); err != nil {
		log.Printf("[warn] report: %v", err)
	}
	tReport := time.Since(t1)

	if cfg.Debug {
		log.Printf("[debug] runOnce: collect=%s mid=%s report=%s", tCollect, tMid, tReport)
	}

	return m
}
