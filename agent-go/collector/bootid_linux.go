//go:build linux

package collector

import (
	"os"
	"strings"
)

// bootID 读取内核启动 ID：每次重启都不同，用作 epoch 的 boot 段。
// 读失败返回空串（epoch 变为 "/<digest>"：仍能检测接口集变化，只是重启补账失效）。
func bootID() string {
	b, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}
