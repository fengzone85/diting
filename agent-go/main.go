// diting-agent Go 版受控端。
//
// 只采性能数据，不采指纹。单向上报，零入站，无指令通道。
package main

import (
	"context"
	"encoding/json"
	"log"
	"os/signal"
	"syscall"
	"time"

	"github.com/fengzone85/diting/agent-go/collector"
	"github.com/fengzone85/diting/agent-go/config"
	"github.com/fengzone85/diting/agent-go/reporter"
	"github.com/fengzone85/diting/agent-go/state"
)

const version = "1.0.0-go"

func main() {
	log.SetFlags(log.Ltime | log.Lshortfile)
	log.Printf("[agent] starting: version=%s", version)

	// 加载配置
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("[error] config: %v", err)
	}

	// HTTPS 强制校验
	if err := cfg.Validate(); err != nil {
		log.Fatalf("[error] validate: %v", err)
	}

	if cfg.Debug {
		log.Printf("[debug] server=%s id=%s interval=%s disk=%s probes=%s",
			cfg.ServerURL, cfg.AgentID, cfg.Interval, cfg.DiskPath, cfg.ProbeTargets)
	}

	// 初始化模块
	c := collector.NewCollector(cfg.DiskPath)
	r := reporter.NewReporter(cfg.ServerURL, cfg.AgentID, cfg.AgentToken)
	st := state.Load(cfg.StateFile)
	targets := collector.ParseProbeTargets(cfg.ProbeTargets)

	// 优雅退出
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	ticker := time.NewTicker(cfg.Interval)
	defer ticker.Stop()

	// 首次立即上报
	runOnce(c, r, st, targets, cfg)

	for {
		select {
		case <-ctx.Done():
			log.Println("[agent] shutting down")
			return
		case <-ticker.C:
			runOnce(c, r, st, targets, cfg)
			ticker.Reset(cfg.Interval)
		}
	}
}

// runOnce 执行一次采集 + 上报。
func runOnce(c collector.Collector, r *reporter.Reporter, st *state.State, targets []collector.ProbeTarget, cfg *config.Config) {
	// 采集
	m, err := c.Collect()
	if err != nil {
		log.Printf("[error] collect: %v", err)
		return
	}

	// 流量累计（用累计字节算差值，不是速率）
	st.Accumulate(m.NetRx, m.NetTx)

	// 探测
	if len(targets) > 0 {
		m.Probes = collector.ProbeAll(targets)
	}

	// 网络月累计
	m.NetRxMonth = st.MonthRx
	m.NetTxMonth = st.MonthTx

	// 序列化
	payload, err := json.Marshal(m)
	if err != nil {
		log.Printf("[error] marshal: %v", err)
		return
	}

	// 上报
	if err := r.Report(payload); err != nil {
		log.Printf("[warn] report: %v", err)
	}

	// 持久化状态
	if err := st.Save(cfg.StateFile); err != nil {
		log.Printf("[warn] save state: %v", err)
	}
}
