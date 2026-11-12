//go:build windows

package collector

import (
	"fmt"
	"sync"
	"time"
)

// Windows 没有内核 boot_id 文件：boot 段 = 开机时间戳（now - uptime，取整到分钟
// 吸收抖动），前缀 'w' 便于与 Linux 的内核 UUID 区分。
//
// 语义：同一 boot 内稳定、跨 boot 必变——net_epoch 只需要 **per-agent** 的 boot
// 代际区分（服务端做不透明比较，检测重启以修正计数器连续性），无需全局唯一，
// agent 身份已由 token 承载。
//
// 2026-11-12 红线拍板（方案一）：不再使用 MachineGuid——装机唯一标识属个体级
// 指纹（跨重装/换 token 稳定，可关联同一物理机），替换为开机时间戳后该采集面撤销。
var (
	bootIDOnce  sync.Once
	bootIDValue string
)

func bootID() string {
	bootIDOnce.Do(func() {
		// 开机时间：进程首次采集时 now - uptime，按分钟取整吸收抖动。
		boot := time.Now().Unix() - int64(winUptime())
		boot = boot / 60 * 60
		bootIDValue = fmt.Sprintf("w%d", boot)
	})
	return bootIDValue
}
