// Package reporter 负责将采集结果上报到服务端。
//
// 安全约束：
//   - 只通过 HTTPS 上报（localhost 除外，由 config.Validate 保证）
//   - Header 携带 Token（不落盘、不打印）
//   - 响应体"从不解析/不执行"（单向上报模型）
//   - 401/403 长退避 10 分钟（静态 token 不可自愈）
//   - 退避可被 ctx 取消，保证 SIGTERM 能及时退出
package reporter

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"time"
)

const (
	timeout = 10 * time.Second
	// defaultAuthBackoff 是 401/403 的默认退避时长（对齐 agent.py:68）。
	// 实际值放在 Reporter.authBackoff 字段里：生产用默认，测试可注入毫秒级值，
	// 否则验证这条分支要真等 10 分钟。
	defaultAuthBackoff = 10 * time.Minute
)

// Reporter 负责 HTTP 上报。
type Reporter struct {
	serverURL string
	agentID   string
	token     string
	interval  time.Duration // 上报间隔，用于退避计算
	userAgent string        // User-Agent 头（diting-agent-go/<version>）
	client    *http.Client
	// authBackoff 是 401/403 的退避时长（默认 10 分钟）。
	// 独立成字段而非包级常量：测试才能用毫秒级值覆盖这条分支。
	authBackoff time.Duration
}

// NewReporter 创建上报器。
// interval 是 Agent 的上报间隔，退避时长 = min(30, 2^attempt * interval)。
// version 用于构造 User-Agent，与 main.version 同源，便于 ldflags 注入统一。
//
// 注：请求体 GZIP 选项已于 2026-10-12 移除（服务端无解压中间件，开启即被
// 400 拒收，属从未可用的死选项；正常部署的 agent 上报体仅 ~1KB，压缩收益
// 也有限）。若未来要重新引入需服务端配套 gunzip 中间件。
func NewReporter(serverURL, agentID, token string, interval time.Duration, version string) *Reporter {
	return &Reporter{
		serverURL:   serverURL + "/api/report",
		agentID:     agentID,
		token:       token,
		interval:    interval,
		userAgent:   "diting-agent-go/" + version,
		client:      &http.Client{Timeout: timeout},
		authBackoff: defaultAuthBackoff,
	}
}

// Report 执行上报。返回 nil 表示成功。
//
// 重试策略（对齐 agent.py:77-79）：
//   - 401/403: 长退避 authBackoff 后返回错误（不重试）
//   - 其他错误: 指数退避重试最多 3 次，时长 = min(30s, 2^attempt * interval)
//
// 所有退避均可被 ctx 取消，确保收到 SIGINT/SIGTERM 能及时退出，
// 不会因 10 分钟 authBackoff 卡死而被 docker stop 超时 SIGKILL。
//
// 监控指标为时序数据，每周期独立上报，失败不缓存重发：服务端用
// Date.now() 生成 ts，重发旧 payload 会被当成当前时刻入库导致曲线错位。
func (r *Reporter) Report(ctx context.Context, payload []byte) error {
	var lastErr error
	for attempt := 0; attempt <= 3; attempt++ {
		if attempt > 0 {
			// 指数退避: 2^attempt * interval，封顶 30s（对齐 Python）
			backoff := time.Duration(1<<uint(attempt)) * r.interval
			if backoff > 30*time.Second {
				backoff = 30 * time.Second
			}
			select {
			case <-time.After(backoff):
			case <-ctx.Done():
				return ctx.Err()
			}
		}

		err := r.doReport(payload)
		if err == nil {
			return nil
		}
		lastErr = err

		// 401/403 不重试，长退避后返回
		if err == errAuthRejected {
			select {
			case <-time.After(r.authBackoff):
			case <-ctx.Done():
				return ctx.Err()
			}
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
	req.Header.Set("User-Agent", r.userAgent)

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
