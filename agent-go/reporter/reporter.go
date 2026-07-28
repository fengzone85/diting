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
	"encoding/json"
	"fmt"
	"net/http"
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
	client    *http.Client
}

// NewReporter 创建上报器。
func NewReporter(serverURL, agentID, token string) *Reporter {
	return &Reporter{
		serverURL: serverURL + "/api/report",
		agentID:   agentID,
		token:     token,
		client:    &http.Client{Timeout: timeout},
	}
}

// Report 执行上报。返回 nil 表示成功。
//
// 重试策略（对齐 agent.py:46-80）：
//   - 401/403: 长退避 authBackoff 后返回错误（不重试）
//   - 其他错误: 指数退避重试最多 3 次（1s→2s→4s，封顶 30s）
func (r *Reporter) Report(payload []byte) error {
	var lastErr error
	for attempt := 0; attempt <= 3; attempt++ {
		if attempt > 0 {
			// 指数退避: 2^attempt * 1s，封顶 30s
			backoff := time.Duration(1<<attempt) * time.Second
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
	return lastErr
}

// errAuthRejected 表示 401/403 认证失败。
var errAuthRejected = fmt.Errorf("auth rejected")

// doReport 执行单次 HTTP 上报。
func (r *Reporter) doReport(payload []byte) error {
	req, err := http.NewRequest(http.MethodPost, r.serverURL, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
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
