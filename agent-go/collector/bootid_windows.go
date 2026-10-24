//go:build windows

package collector

import (
	"fmt"
	"strings"
	"sync"
	"time"
)

// Windows 没有 boot_id 文件：用「MachineGuid + 开机时间」拼 boot 段。
//   - MachineGuid 保证装机唯一（换机器必然变）；
//   - 开机时间（now - uptime 取整到分钟）保证重启后必变；
//   - 分隔符用 '@' 而不是 '/'：epoch 格式是 bootID/digest，服务端只取第一个 '/'
//     之前的部分作为 boot 段，用 '/' 拼会让 boot 段永远只剩下 MachineGuid。
var (
	bootIDOnce  sync.Once
	bootIDValue string
)

func bootID() string {
	bootIDOnce.Do(func() {
		guid := strings.Trim(strings.TrimSpace(machineGuid()), "{}")
		if guid == "" {
			guid = "unknown"
		}
		// 开机时间：进程首次采集时 now - uptime，按分钟取整吸收抖动。
		boot := time.Now().Unix() - int64(winUptime())
		boot = boot / 60 * 60
		bootIDValue = fmt.Sprintf("%s@%d", guid, boot)
	})
	return bootIDValue
}

// machineGuid 读 HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid。
// 注册表值可能带花括号，调用方负责 Trim；读不到返回空串。
func machineGuid() string {
	h, err := regOpen(`SOFTWARE\Microsoft\Cryptography`)
	if err != nil {
		return ""
	}
	defer procRegCloseKey.Call(uintptr(h))
	v, err := regGetSz(h, "MachineGuid")
	if err != nil {
		return ""
	}
	return v
}
