// Package config 加载并校验 Agent 配置。
//
// 严格遵循 Python 版 agent.py 的安全约定：
//   - 非 localhost/127.0.0.1/::1 禁止 http://，防止 Token 明文外发
//   - 仅允许 http/https scheme，杜绝自定义协议
package config

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"time"
)

// Config 由环境变量填充。字段命名与 Python 版一一对应，便于并行对比。
type Config struct {
	ServerURL    string
	AgentID      string
	AgentToken   string
	Interval     time.Duration // 固定模式间隔（ADAPTIVE=false 时生效）
	DiskPath     string
	StateFile    string
	ProbeTargets string
	Debug        bool
	Gzip         bool
	Adaptive     bool          // 纯本地自适应（不解析响应）：变化大→快档，平稳→慢档
	FastInterval time.Duration // 自适应快档间隔
	SlowInterval time.Duration // 自适应慢档间隔
}

// Load 从环境变量加载配置。缺失必填项返回错误（与 Python agent.py 一致）。
//
// 零依赖：使用标准库 os.Getenv，不用 caarlos0/env（减少攻击面、加速交叉编译）。
func Load() (*Config, error) {
	cfg := &Config{
		ServerURL:    os.Getenv("SERVER_URL"),
		AgentID:      os.Getenv("AGENT_ID"),
		AgentToken:   os.Getenv("AGENT_TOKEN"),
		DiskPath:     getEnvDefault("DISK_PATH", "/"),
		StateFile:    getEnvDefault("STATE_FILE", "/data/state.json"),
	}

	// ProbeTargets：未设用默认三家运营商 DNS + 8.8.8.8；显式设空（PROBE_TARGETS=""）则关闭探测。
	// 用 LookupEnv 区分"未设"与"空"，避免 getEnvDefault 把空当作未设而回退默认导致无法关探测。
	if v, ok := os.LookupEnv("PROBE_TARGETS"); ok {
		cfg.ProbeTargets = v
	} else {
		cfg.ProbeTargets = "移动:211.136.192.6,电信:101.226.4.6,联通:202.106.0.20,公共:8.8.8.8"
	}

	// 解析 interval（默认 20s，最小 5s；ADAPTIVE=false 时的固定间隔）
	intervalStr := getEnvDefault("INTERVAL", "20")
	if v, err := strconv.Atoi(intervalStr); err == nil {
		cfg.Interval = time.Duration(v) * time.Second
	} else {
		cfg.Interval = 20 * time.Second
	}
	if cfg.Interval < 5*time.Second {
		cfg.Interval = 5 * time.Second
	}

	// 解析 debug
	if v := os.Getenv("DEBUG"); v == "1" || v == "true" || v == "yes" {
		cfg.Debug = true
	}

	// 解析 gzip（默认关：服务端 Express 默认 express.json() 不解压 gzip 请求体，
	// 开启需服务端先配置请求体解压中间件，否则上报会被 400 拒收）
	if v := os.Getenv("GZIP"); v == "1" || v == "true" || v == "yes" {
		cfg.Gzip = true
	}

	// 解析自适应（默认开启：纯本地决策，不解析服务端响应，守单向安全模型）
	// 慢档需服务端 OFFLINE_THRESHOLD_SEC > SLOW_INTERVAL（建议慢档 60s 配阈值 120s），
	// 否则平稳期 last_seen 间隔过大被误判离线。
	cfg.Adaptive = true
	if v := os.Getenv("ADAPTIVE"); v == "0" || v == "false" || v == "no" {
		cfg.Adaptive = false
	}
	cfg.FastInterval = time.Duration(getEnvInt("FAST_INTERVAL", 10)) * time.Second
	cfg.SlowInterval = time.Duration(getEnvInt("SLOW_INTERVAL", 60)) * time.Second
	if cfg.FastInterval < 5*time.Second {
		cfg.FastInterval = 5 * time.Second
	}
	if cfg.SlowInterval < cfg.FastInterval {
		cfg.SlowInterval = cfg.FastInterval
	}

	// 必填校验
	if cfg.ServerURL == "" {
		return nil, errors.New("SERVER_URL must be set")
	}
	if cfg.AgentID == "" {
		return nil, errors.New("AGENT_ID must be set")
	}
	if cfg.AgentToken == "" {
		return nil, errors.New("AGENT_TOKEN must be set")
	}

	return cfg, nil
}

// getEnvDefault 读取环境变量，空时返回默认值。
func getEnvDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// getEnvInt 读取环境变量为 int，空或非法返回默认值。
func getEnvInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

// Validate 强制 HTTPS：仅 localhost/127.0.0.1/::1 允许 http://。
// 与 Python agent.py:35-40 等价，防止误配导致 Token 明文外发。
func (c *Config) Validate() error {
	u, err := url.Parse(c.ServerURL)
	if err != nil {
		return fmt.Errorf("invalid SERVER_URL: %w", err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("SERVER_URL must start with http(s): %q", c.ServerURL)
	}
	if u.Scheme == "http" {
		host := u.Hostname()
		if host != "localhost" && host != "127.0.0.1" && host != "::1" {
			return fmt.Errorf("SERVER_URL must use https unless pointing at localhost/127.0.0.1/::1")
		}
	}
	return nil
}
