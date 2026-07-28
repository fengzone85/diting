// Package reporter 负责将采集结果上报到服务端。
//
// 安全约束：
//   - 只通过 HTTPS 上报（localhost 除外，由 config.Validate 保证）
//   - Header 携带 Token（不落盘、不打印）
//   - 响应体"从不解析/不执行"（单向上报模型）
//   - 401/403 长退避 10 分钟（静态 token 不可自愈）
package reporter

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

const (
	userAgent = "diting-agent-go/1.0"
	timeout   = 10 * time.Second
	// authBackoff 是 401/403 的退避时长（对齐 agent.py:68）
	authBackoff = 10 * time.Minute
)

// Reporter 负责 HTTP 上报。
type Reporter struct {
	serverURL string
	agentID   string
	token     string
	interval  time.Duration // 上报间隔，用于退避计算
	client    *http.Client

	mu      sync.Mutex // 保护 pending
	pending []byte     // 失败缓存（断线恢复用）
}

// NewReporter 创建上报器。
// interval 是 Agent 的上报间隔，退避时长 = min(30, 2^attempt * interval)。
func NewReporter(serverURL, agentID, token string, interval time.Duration) *Reporter {
	return &Reporter{
		serverURL: serverURL + "/api/report",
		agentID:   agentID,
		token:     token,
		interval:  interval,
		client:    &http.Client{Timeout: timeout},
	}
}

// Report 执行上报。返回 nil 表示成功。
//
// 重试策略（对齐 agent.py:77-79）：
//   - 401/403: 长退避 authBackoff 后返回错误（不重试）
//   - 其他错误: 指数退避重试最多 3 次，时长 = min(30s, 2^attempt * interval)
//   - 失败时缓存到 pending，下轮重发
func (r *Reporter) Report(payload []byte) error {
	// 先尝试发送缓存的 pending（断线恢复）
	r.flushPending()

	var lastErr error
	for attempt := 0; attempt <= 3; attempt++ {
		if attempt > 0 {
			// 指数退避: 2^attempt * interval，封顶 30s（对齐 Python）
			backoff := time.Duration(1<<uint(attempt)) * r.interval
			if backoff > 30*time.Second {
				backoff = 30 * time.Second
			}
			time.Sleep(backoff)
		}

		err := r.doReport(payload)
		if err == nil {
			return nil
		}
		lastErr = err

		// 401/403 不重试，直接退避
		if err == errAuthRejected {
			time.Sleep(authBackoff)
			return err
		}
	}

	// 全部重试失败，缓存 pending（最多缓存 1 条，避免内存无限增长）
	r.mu.Lock()
	r.pending = payload
	r.mu.Unlock()
	return lastErr
}

// flushPending 尝试发送缓存的 pending payload。
func (r *Reporter) flushPending() {
	r.mu.Lock()
	pending := r.pending
	r.pending = nil
	r.mu.Unlock()

	if pending == nil {
		return
	}
	// 只尝试一次，失败则丢弃（避免阻塞主循环）
	if err := r.doReport(pending); err != nil {
		// 仍失败，重新缓存
		r.mu.Lock()
		r.pending = pending
		r.mu.Unlock()
	}
}

// errAuthRejected 表示 401/403 认证失败。
var errAuthRejected = fmt.Errorf("auth rejected")

// compressPayload 用 gzip 压缩 payload，减少上行流量。
// 压缩后添加 Content-Encoding: gzip，服务端需支持解压。
func (r *Reporter) compressPayload(payload []byte) ([]byte, error) {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	if _, err := gz.Write(payload); err != nil {
		return nil, err
	}
	if err := gz.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// doReport 执行单次 HTTP 上报（gzip 压缩）。
func (r *Reporter) doReport(payload []byte) error {
	// 压缩 payload
	compressed, err := r.compressPayload(payload)
	if err != nil {
		return fmt.Errorf("compress: %w", err)
	}

	req, err := http.NewRequest(http.MethodPost, r.serverURL, bytes.NewReader(compressed))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Content-Encoding", "gzip")
	req.Header.Set("Authorization", "Bearer "+r.token)
	req.Header.Set("X-Agent-ID", r.agentID)
	req.Header.Set("User-Agent", userAgent)

	resp, err := r.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode == 401 || resp.StatusCode == 403 {
		return errAuthRejected
	}
	if resp.StatusCode != 200 {
		return fmt.Errorf("status %d", resp.StatusCode)
	}
	return nil
}

// MarshalJSON 是辅助函数，用于序列化 payload（便于测试）。
func MarshalJSON(v interface{}) ([]byte, error) {
	return json.Marshal(v)
}
