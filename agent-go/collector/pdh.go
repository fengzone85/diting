//go:build windows

// pdh.go - Windows 磁盘 IO 速率（经 pdh.dll 直调性能计数器）。
//
// 决策（2026-10-12 修订 M2 红线）：M2 时曾把磁盘 IO 列为"不抄 PDH"砍掉，
// 但 Python 版经 psutil.disk_io_counters 一直有真值（4 周对比期 7 万+ 条记录），
// Go 版缺失属功能回归而非采集面扩张。恢复方式选择零依赖直调（不引 WMI、
// 不引任何第三方包），与既有 syscall.NewLazyDLL 模式一致。
//
// 口径：
//   - 计数器 \PhysicalDisk(_Total)\Disk Read|Write Bytes/sec（English 计数器
//     API，与系统语言无关），直接是 B/s，无需自行差分；
//   - 普通用户可读（Performance Counters 默认权限）；
//   - 查询失败/无数据时回退 0（不拖垮整轮采集，与网络接口容错一致）。
package collector

import (
	"syscall"
	"unsafe"
)

var (
	modPdh = syscall.NewLazyDLL("pdh.dll")

	procPdhOpenQueryW               = modPdh.NewProc("PdhOpenQueryW")
	procPdhAddEnglishCounterW       = modPdh.NewProc("PdhAddEnglishCounterW")
	procPdhCollectQueryData         = modPdh.NewProc("PdhCollectQueryData")
	procPdhGetFormattedCounterValue = modPdh.NewProc("PdhGetFormattedCounterValue")
	procPdhCloseQuery               = modPdh.NewProc("PdhCloseQuery")
)

const (
	pdhFmtDouble = 0x00000200 // PDH_FMT_DOUBLE

	// PDH_FMT_COUNTERVALUE.CStatus 的两个有效值
	pdhCStatusValidData = 0x0 // PDH_CSTATUS_VALID_DATA
	pdhCStatusNewData   = 0x1 // PDH_CSTATUS_NEW_DATA
)

// pdhFmtCounterValue 对应 PDH_FMT_COUNTERVALUE（x64 布局）：
//   DWORD CStatus;           // 偏移 0（4 字节）
//   <padding 4 字节>          // union 内 double 需 8 字节对齐
//   union { ...; double; };  // 偏移 8（8 字节）
// 合计 16 字节；Go 中 float64 自然 8 字节对齐，布局与 C x64 ABI 一致。
type pdhFmtCounterValue struct {
	CStatus uint32
	_       uint32
	Value   float64
}

// pdhDiskIO 持有 _Total 磁盘读写计数器的查询句柄（进程生命周期内复用）。
type pdhDiskIO struct {
	query syscall.Handle
	rd    syscall.Handle
	wr    syscall.Handle
	ok    bool
}

// newPdhDiskIO 打开查询、挂载两个英文计数器并采首次基线。
// 任一步失败则 ok=false，后续 Rates 恒返回 0（等价旧行为，不报错）。
func newPdhDiskIO() *pdhDiskIO {
	p := &pdhDiskIO{}
	var q syscall.Handle
	if r, _, _ := procPdhOpenQueryW.Call(0, 0, uintptr(unsafe.Pointer(&q))); r != 0 {
		return p
	}
	p.query = q

	rdName, err1 := syscall.UTF16PtrFromString(`\PhysicalDisk(_Total)\Disk Read Bytes/sec`)
	wrName, err2 := syscall.UTF16PtrFromString(`\PhysicalDisk(_Total)\Disk Write Bytes/sec`)
	if err1 != nil || err2 != nil {
		return p
	}
	if r, _, _ := procPdhAddEnglishCounterW.Call(uintptr(q),
		uintptr(unsafe.Pointer(rdName)), 0, uintptr(unsafe.Pointer(&p.rd))); r != 0 {
		return p
	}
	if r, _, _ := procPdhAddEnglishCounterW.Call(uintptr(q),
		uintptr(unsafe.Pointer(wrName)), 0, uintptr(unsafe.Pointer(&p.wr))); r != 0 {
		return p
	}
	// 速率计数器需要两次采集：这里采首次基线，首轮 Rates 即能出值。
	if r, _, _ := procPdhCollectQueryData.Call(uintptr(q)); r != 0 {
		return p
	}
	p.ok = true
	return p
}

// Rates 返回 (读 B/s, 写 B/s)；未就绪/无数据返回 0,0。
func (p *pdhDiskIO) Rates() (float64, float64) {
	if p == nil || !p.ok {
		return 0, 0
	}
	if r, _, _ := procPdhCollectQueryData.Call(uintptr(p.query)); r != 0 {
		return 0, 0
	}
	return readPdhDouble(p.rd), readPdhDouble(p.wr)
}

// Close 释放查询句柄（进程退出时由 OS 兜底，可选调用）。
func (p *pdhDiskIO) Close() {
	if p != nil && p.query != 0 {
		procPdhCloseQuery.Call(uintptr(p.query))
		p.query = 0
	}
}

// readPdhDouble 读一个计数器的 double 值；无效状态返回 0。
func readPdhDouble(h syscall.Handle) float64 {
	var v pdhFmtCounterValue
	var typ uint32
	r, _, _ := procPdhGetFormattedCounterValue.Call(
		uintptr(h), pdhFmtDouble,
		uintptr(unsafe.Pointer(&typ)),
		uintptr(unsafe.Pointer(&v)))
	if r != 0 {
		return 0
	}
	if v.CStatus != pdhCStatusValidData && v.CStatus != pdhCStatusNewData {
		return 0 // PDH_INVALID_DATA / NO_DATA 等
	}
	if v.Value < 0 {
		return 0
	}
	return v.Value
}
