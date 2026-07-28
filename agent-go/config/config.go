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
	Interval     time.Duration
	DiskPath     string
	StateFile    string
	ProbeTargets string
	Debug        bool
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
		ProbeTargets: getEnvDefault("PROBE_TARGETS", "移动:211.136.192.6,电信:101.226.4.6,联通:202.106.0.20,公共:8.8.8.8"),
	}

	// 解析 interval（默认 20s，最小 5s）
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
