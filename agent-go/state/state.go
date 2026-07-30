// Package state 管理流量月累计状态持久化。
//
// 设计要点（对齐 Python collector.py:423-435）：
//   - HasPrev 守卫：首跑只设 LastRx/LastTx，不累加（避免巨大尖峰）
//   - MonthKey 变更（新月）时自动清零
//   - 原子写入：先 .tmp 再 rename，防断电损坏
package state

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"time"
)

// State 是持久化的流量累计状态。
type State struct {
	HasPrev  bool   `json:"has_prev"`  // 首跑守卫
	LastRx   uint64 `json:"last_rx"`   // 上次采样 rx（算差值用）
	LastTx   uint64 `json:"last_tx"`   // 上次采样 tx
	MonthKey string `json:"month_key"` // "2026-07"，变更即重置
	MonthRx  uint64 `json:"month_rx"`  // 月累计接收
	MonthTx  uint64 `json:"month_tx"`  // 月累计发送
}

// Load 从文件加载状态，不存在返回零值。
func Load(path string) *State {
	s := &State{}
	data, err := os.ReadFile(path)
	if err != nil {
		return s
	}
	if err := json.Unmarshal(data, s); err != nil {
		log.Printf("[warn] state: unmarshal %s: %v", path, err)
	}
	return s
}

// Accumulate 累加流量。
// 首跑只设 LastRx/Tx 不累加（避免巨大尖峰）。
// MonthKey 变更时自动清零。
func (s *State) Accumulate(rx, tx uint64) {
	mk := time.Now().Format("2006-01")
	if mk != s.MonthKey {
		s.MonthKey = mk
		s.MonthRx = 0
		s.MonthTx = 0
	}
	if !s.HasPrev {
		s.LastRx = rx
		s.LastTx = tx
		s.HasPrev = true
		return
	}
	if rx > s.LastRx {
		s.MonthRx += rx - s.LastRx
	}
	if tx > s.LastTx {
		s.MonthTx += tx - s.LastTx
	}
	s.LastRx = rx
	s.LastTx = tx
}

// Save 原子写入状态文件。
func (s *State) Save(path string) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	data, err := json.Marshal(s)
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
