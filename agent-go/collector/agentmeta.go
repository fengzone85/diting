package collector

import (
	"regexp"
	"runtime"
	"runtime/debug"
	"strings"
)

// AgentMeta 是构建元信息（AGENT_DISTRIBUTION_PLAN V.1）。
//
// 边界说明：这些字段描述「这个二进制是怎么来的」，不描述主机——不属指纹面
// （与 2026-09-12 采集边界一致：聚合计数与构建元信息均可上报）。
// 服务端据此回答「哪些节点跑的是旧版 / fork 版 / 定制版」。
type AgentMeta struct {
	Version   string `json:"version"`
	BuildSHA  string `json:"build_sha"`
	BuildTime string `json:"build_time"`
	Platform  string `json:"platform"`
}

// shaRe 与 V.3 服务端正则同口径：7–40 位小写 hex。非 hex（含脏构建带的
// "-dirty" 后缀）一律丢弃——该值会进面板展示与后续脚本拼接，必须干净。
var shaRe = regexp.MustCompile(`^[0-9a-f]{7,40}$`)

// timeRe：UTC RFC3339（秒级或带毫秒）。服务端用同一口径校验。
var timeRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T[\d:]+Z$`)

// platformRe：goos-goarch，两侧均小写字母数字。
var platformRe = regexp.MustCompile(`^[a-z0-9]{2,10}-[a-z0-9]{2,10}$`)

// BuildAgentMeta 组装构建元信息。三个入参来自 main 包的 ldflags 注入
// （`-X main.version= -X main.buildSHA= -X main.buildTime=`）。
//
// 兜底（V.2）：ldflag 缺失时读 `debug.ReadBuildInfo()` 的 vcs.revision /
// vcs.time——Go 1.18+ 在 git 仓库内构建会自动嵌入，对存量 Release 产物即有效；
// ldflag 注入只是短路优化，避免依赖构建环境。
func BuildAgentMeta(version, buildSHA, buildTime string) *AgentMeta {
	m := &AgentMeta{
		Version:   strings.TrimSpace(version),
		BuildSHA:  strings.ToLower(strings.TrimSpace(buildSHA)),
		BuildTime: strings.TrimSpace(buildTime),
		Platform:  runtime.GOOS + "-" + runtime.GOARCH,
	}

	// 脏构建（vcs.modified=true）时 vcs.revision 与 tag 不对应：仍如实上报 sha，
	// 由管理员用 build_tag 标注，服务端不自动判定「是否官方构建」。
	if bi, ok := debug.ReadBuildInfo(); ok {
		if !shaRe.MatchString(m.BuildSHA) {
			if v := vcsSetting(bi, "vcs.revision"); shaRe.MatchString(strings.ToLower(v)) {
				m.BuildSHA = strings.ToLower(v)
			}
		}
		if !timeRe.MatchString(m.BuildTime) {
			if v := vcsSetting(bi, "vcs.time"); timeRe.MatchString(v) {
				m.BuildTime = v
			}
		}
	}

	// 最终清洗：不合口径的一律置空（宁可「未知」也不要脏值进面板/脚本）
	if !shaRe.MatchString(m.BuildSHA) {
		m.BuildSHA = ""
	}
	if !timeRe.MatchString(m.BuildTime) {
		m.BuildTime = ""
	}
	if !platformRe.MatchString(m.Platform) {
		m.Platform = ""
	}
	return m
}

// vcsSetting 从 buildinfo 的 Settings 里取 VCS 相关键值。
func vcsSetting(bi *debug.BuildInfo, key string) string {
	if bi == nil {
		return ""
	}
	for _, s := range bi.Settings {
		if s.Key == key {
			return s.Value
		}
	}
	return ""
}
