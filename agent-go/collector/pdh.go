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
	procPdhGetFormattedCounterArrayW = modPdh.NewProc("PdhGetFormattedCounterArrayW")
	procPdhCloseQuery               = modPdh.NewProc("PdhCloseQuery")
)

const (
	pdhFmtDouble = 0x00000200 // PDH_FMT_DOUBLE

	// PDH_FMT_COUNTERVALUE.CStatus 的两个有效值
	pdhCStatusValidData = 0x0 // PDH_CSTATUS_VALID_DATA
	pdhCStatusNewData   = 0x1 // PDH_CSTATUS_NEW_DATA
)

// pdhFmtCounterValueItem 对应 PDH_FMT_COUNTERVALUE_ITEM_W（多实例计数器值数组元素）：
//
//	LPWSTR szName;              // 偏移 0（8 字节指针）
//	PDH_FMT_COUNTERVALUE FmtValue; // 偏移 8（16 字节）
//
// 每项 24 字节（x64）。
type pdhFmtCounterValueItem struct {
	SzName   *uint16
	FmtValue pdhFmtCounterValue
}

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

// pdhDiskIO 持有 _Total 磁盘读写计数器的查询句柄（进程生命周期内复用），
// 并挂载进程数（\System\Processes）与热区温度（\Thermal Zone Information）两个附加计数器。
type pdhDiskIO struct {
	query syscall.Handle
	rd    syscall.Handle
	wr    syscall.Handle
	ok    bool

	proc    syscall.Handle
	procOK  bool
	thermal syscall.Handle
	thermalOK bool
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
	p.initExtraCounters() // 进程数 + 热区温度（可选能力，失败仅关闭对应字段）
	return p
}

// initExtraCounters 挂载进程数与热区温度计数器（可选，失败不影响磁盘 IO）。
// 单独函数便于阅读：任一计数器不存在（如无 ACPI 热区的机器没有 Thermal Zone
// Information 计数集）都只是对应能力关闭，绝不报错。
func (p *pdhDiskIO) initExtraCounters() {
	if p == nil || p.query == 0 {
		return
	}
	if name, err := syscall.UTF16PtrFromString(`\System\Processes`); err == nil {
		if r, _, _ := procPdhAddEnglishCounterW.Call(uintptr(p.query),
			uintptr(unsafe.Pointer(name)), 0, uintptr(unsafe.Pointer(&p.proc))); r == 0 {
			p.procOK = true
		}
	}
	// 多实例通配：不同机器热区实例名不同（TZ00/TZ01/...），(*) 一网打尽；
	// 计数集不存在时 AddEnglishCounter 直接失败 → thermalOK=false → 温度保持 nil。
	if name, err := syscall.UTF16PtrFromString(`\Thermal Zone Information(*)\Temperature`); err == nil {
		if r, _, _ := procPdhAddEnglishCounterW.Call(uintptr(p.query),
			uintptr(unsafe.Pointer(name)), 0, uintptr(unsafe.Pointer(&p.thermal))); r == 0 {
			p.thermalOK = true
		}
	}
}

// Processes 返回系统进程总数（0 = 不可用；仅计数，无任何进程明细）。
// 需在 Rates()（内含 CollectQueryData）之后调用，共用同一次采集。
func (p *pdhDiskIO) Processes() int {
	if p == nil || !p.procOK {
		return 0
	}
	v := readPdhDouble(p.proc)
	if v <= 0 || v > 1e6 {
		return 0
	}
	return int(v + 0.5)
}

// TempC 返回各热区最高温度（℃）；无热区/无数据/超出合理区间返回 nil。
// 需在 Rates() 之后调用（共用同一次 CollectQueryData）。
//
// 单位处理：微软文档标注 Kelvin，但部分平台实测返回 0.1K（如 3131 ≈ 313.1K
// ≈ 40°C）。启发式：>1000 视为 0.1K 除 10，结果再经 -50..200℃ 区间过滤——
// 宁可 nil（不显示），绝不产出垃圾值。
func (p *pdhDiskIO) TempC() *float64 {
	if p == nil || !p.thermalOK {
		return nil
	}
	var bufSize, itemCount uint32
	// 首次调用取所需 buffer 大小（返回 PDH_MORE_DATA，属预期）
	procPdhGetFormattedCounterArrayW.Call(
		uintptr(p.thermal), pdhFmtDouble,
		uintptr(unsafe.Pointer(&bufSize)), uintptr(unsafe.Pointer(&itemCount)), 0)
	if bufSize == 0 || itemCount == 0 {
		return nil
	}
	buf := make([]byte, bufSize)
	r, _, _ := procPdhGetFormattedCounterArrayW.Call(
		uintptr(p.thermal), pdhFmtDouble,
		uintptr(unsafe.Pointer(&bufSize)), uintptr(unsafe.Pointer(&itemCount)),
		uintptr(unsafe.Pointer(&buf[0])))
	if r != 0 || itemCount == 0 {
		return nil
	}
	items := unsafe.Slice((*pdhFmtCounterValueItem)(unsafe.Pointer(&buf[0])), itemCount)
	maxK, found := 0.0, false
	for i := range items {
		v := items[i].FmtValue
		if v.CStatus != pdhCStatusValidData && v.CStatus != pdhCStatusNewData {
			continue
		}
		k := v.Value
		if k <= 0 {
			continue
		}
		if k > 1000 {
			k /= 10 // 0.1K 单位平台
		}
		if !found || k > maxK {
			maxK, found = k, true
		}
	}
	if !found {
		return nil
	}
	c := maxK - 273.15
	if c < -50 || c > 200 {
		return nil
	}
	c = round1(c)
	return &c
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
