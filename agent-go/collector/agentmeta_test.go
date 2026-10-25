package collector

import (
	"encoding/json"
	"runtime"
	"strings"
	"testing"
)

// TestBuildAgentMetaLdflags ldflag 注入的值应原样透传（sha 归一为小写）。
func TestBuildAgentMetaLdflags(t *testing.T) {
	m := BuildAgentMeta("1.2.3", "ABC1234", "2026-10-25T12:00:00Z")
	if m.Version != "1.2.3" {
		t.Fatalf("version = %q", m.Version)
	}
	if m.BuildSHA != "abc1234" {
		t.Fatalf("build_sha = %q, want lowercased abc1234", m.BuildSHA)
	}
	if m.BuildTime != "2026-10-25T12:00:00Z" {
		t.Fatalf("build_time = %q", m.BuildTime)
	}
	if want := runtime.GOOS + "-" + runtime.GOARCH; m.Platform != want {
		t.Fatalf("platform = %q, want %q", m.Platform, want)
	}
}

// TestBuildAgentMetaShaNonHex 非 hex（含脏构建 "-dirty" 后缀）必须置空，
// 绝不把脏值透传到面板与后续脚本拼接里。
func TestBuildAgentMetaShaNonHex(t *testing.T) {
	for _, bad := range []string{"abc", "zzzzzzz", "c76d2f2-dirty", "not-a-sha"} {
		m := BuildAgentMeta("1.0.0", bad, "")
		// buildinfo 兜底可能补上合法 sha；这里只断言「传入的脏值不会被采用」
		if m.BuildSHA == strings.ToLower(bad) {
			t.Fatalf("脏 sha %q 被原样采用", bad)
		}
	}
}

// TestBuildAgentMetaFallback ldflag 全空时应从 debug.ReadBuildInfo() 的
// vcs.revision/vcs.time 兜底（Go 1.18+ git 仓库内构建自动嵌入）。
// 兜底不到时允许为空——「未知」优于脏值。
func TestBuildAgentMetaFallback(t *testing.T) {
	m := BuildAgentMeta("", "", "")
	if m.Platform == "" {
		t.Fatal("platform 不应为空（runtime.GOOS/GOARCH 恒可得）")
	}
	if m.BuildSHA != "" && len(m.BuildSHA) < 7 {
		t.Fatalf("兜底 sha 长度异常: %q", m.BuildSHA)
	}
	if m.BuildTime != "" && !strings.HasSuffix(m.BuildTime, "Z") {
		t.Fatalf("兜底 build_time 应为 UTC RFC3339: %q", m.BuildTime)
	}
}

// TestBuildAgentMetaTimeInvalid 非法时间格式（非 UTC/带偏移）应置空。
func TestBuildAgentMetaTimeInvalid(t *testing.T) {
	m := BuildAgentMeta("1.0.0", "abc1234", "2026-10-25 12:00:00")
	if m.BuildTime != "" {
		t.Fatalf("非法时间应置空，得到 %q", m.BuildTime)
	}
	// sha 合法时应保留
	if m.BuildSHA != "abc1234" {
		t.Fatalf("build_sha = %q", m.BuildSHA)
	}
}

// TestAgentMetaJSONShape 序列化形状：字段名与服务端 V.3 校验口径一致。
func TestAgentMetaJSONShape(t *testing.T) {
	m := BuildAgentMeta("1.0.0", "abc1234", "2026-10-25T12:00:00Z")
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, want := range []string{`"version"`, `"build_sha"`, `"build_time"`, `"platform"`} {
		if !strings.Contains(string(b), want) {
			t.Fatalf("json = %s, 缺字段 %s", b, want)
		}
	}
}
