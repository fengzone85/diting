//go:build windows

// windowsCollector 是 Windows 平台的采集器实现。
//
// 口径来源（AGENT_CONSOLIDATION_ROADMAP §1「抄口径不抄架构」）：
//   - 结构体布局与 API 用法参照 gopsutil v4 windows/ 源码（BSD-3-Clause，
//     仅抄 ABI 布局与调用口径，不引入包），零外部依赖（纯 syscall.NewLazyDLL）
//   - 字段语义对齐 Python win_collector.py（两版并行对比的基准）：
//     顶层 disk = 全部固定盘求和（非 DISK_PATH 单盘）；swap = GlobalMemoryStatusEx
//     的 PageFile 语义（与 psutil.swap_memory 一致）；net 排除 loopback。
//
// 红线：Load1/5/15 恒 0.0（不用进程数近似）；Temp=nil（不引 WMI 依赖）；
// 零指纹（不采进程/连接/GPU）。
package collector

import (
	"errors"
	"fmt"
	"net"
	"os"
	"runtime"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

var (
	modKernel32 = syscall.NewLazyDLL("kernel32.dll")
	modIphlpapi = syscall.NewLazyDLL("iphlpapi.dll")
	modAdvapi32 = syscall.NewLazyDLL("advapi32.dll")

	procGetSystemTimes       = modKernel32.NewProc("GetSystemTimes")
	procGlobalMemoryStatusEx = modKernel32.NewProc("GlobalMemoryStatusEx")
	procGetTickCount64       = modKernel32.NewProc("GetTickCount64")
	procGetDiskFreeSpaceExW  = modKernel32.NewProc("GetDiskFreeSpaceExW")
	procGetLogicalDrives     = modKernel32.NewProc("GetLogicalDrives")
	procGetDriveTypeW        = modKernel32.NewProc("GetDriveTypeW")
	procGetIfEntry2          = modIphlpapi.NewProc("GetIfEntry2")
	procRegOpenKeyExW        = modAdvapi32.NewProc("RegOpenKeyExW")
	procRegQueryValueExW     = modAdvapi32.NewProc("RegQueryValueExW")
	procRegCloseKey          = modAdvapi32.NewProc("RegCloseKey")
)

const (
	ifTypeLoopback   = 24 // IF_TYPE_SOFTWARE_LOOPBACK
	driveTypeFixed   = 3  // DRIVE_FIXED
	regHKLM          = 0x80000002
	regKeyRead64     = 0x20119 // KEY_READ | KEY_WOW64_64KEY
	regCurVerKeyPath = `SOFTWARE\Microsoft\Windows NT\CurrentVersion`
)

// filetime 对应 Win32 FILETIME（64 位 100ns 计数）。
type filetime struct {
	LowDateTime  uint32
	HighDateTime uint32
}

func (f filetime) val() uint64 {
	return uint64(f.HighDateTime)<<32 | uint64(f.LowDateTime)
}

// memoryStatusEx 对应 MEMORYSTATUSEX（布局对齐 gopsutil mem_windows.go）。
type memoryStatusEx struct {
	cbSize                  uint32
	dwMemoryLoad            uint32
	ullTotalPhys            uint64
	ullAvailPhys            uint64
	ullTotalPageFile        uint64
	ullAvailPageFile        uint64
	ullTotalVirtual         uint64
	ullAvailVirtual         uint64
	ullAvailExtendedVirtual uint64
}

// guid 对应 Win32 GUID。
type guid struct {
	Data1 uint32
	Data2 uint16
	Data3 uint16
	Data4 [8]byte
}

// mibIfRow2 对应 MIB_IF_ROW2（netioapi.h；布局对齐 gopsutil net_windows.go，
// 含 InterfaceGuid 与 PermanentPhysicalAddress；pad0for64_4for32=0，64 位下
// 后续 uint64 字段由 Go/编译器自然 8 字节对齐，与 C x64 ABI 一致）。
type mibIfRow2 struct {
	InterfaceLuid               uint64
	InterfaceIndex              uint32
	InterfaceGuid               guid
	Alias                       [257]uint16
	Description                 [257]uint16
	PhysicalAddressLength       uint32
	PhysicalAddress             [32]uint8
	PermanentPhysicalAddress    [32]uint8
	Mtu                         uint32
	Type                        uint32
	TunnelType                  uint32
	MediaType                   uint32
	PhysicalMediumType          uint32
	AccessType                  uint32
	DirectionType               uint32
	InterfaceAndOperStatusFlags uint32
	OperStatus                  uint32
	AdminStatus                 uint32
	MediaConnectState           uint32
	NetworkGuid                 guid
	ConnectionType              uint32
	TransmitLinkSpeed           uint64
	ReceiveLinkSpeed            uint64
	InOctets                    uint64
	InUcastPkts                 uint64
	InNUcastPkts                uint64
	InDiscards                  uint64
	InErrors                    uint64
	InUnknownProtos             uint64
	InUcastOctets               uint64
	InMulticastOctets           uint64
	InBroadcastOctets           uint64
	OutOctets                   uint64
	OutUcastPkts                uint64
	OutNUcastPkts               uint64
	OutDiscards                 uint64
	OutErrors                   uint64
	OutUcastOctets              uint64
	OutMulticastOctets          uint64
	OutBroadcastOctets          uint64
	OutQLen                     uint64
}

// cpuSample 是某时刻的 CPU 累计时间（100ns tick）。
// kernel 为原始 kernel time——【包含 idle】，与 GetSystemTimes 语义一致。
type cpuSample struct {
	idle, kernel, user uint64
}

// netSample 是某时刻的网络累计字节。
type netSample struct {
	rx, tx uint64
}

// windowsCollector 是 Windows 平台采集器，内部持有 CPU/网络前次样本。
type windowsCollector struct {
	diskPath    string // 仅保留签名兼容；Windows 顶层盘 = 全部固定盘求和（对齐 Python），不用此字段
	prevCPU     cpuSample
	prevNet     *netSample
	prevNetTime time.Time
}

// NewCollector 创建 Windows 采集器（与 linux.go 同名，build tag 互斥）。
// 构造时 prime 一次 CPU 样本（阻塞 ~100ms），与 Python Collector.__init__ 一致。
func NewCollector(diskPath string) Collector {
	c := &windowsCollector{diskPath: diskPath}
	c.prevCPU, _ = readWinCPUSample()
	if c.prevCPU.total() > 0 {
		time.Sleep(100 * time.Millisecond)
	}
	return c
}

// total 返回该样本的总 CPU 时间（kernel 已含 idle，故 total = kernel + user）。
func (s cpuSample) total() uint64 { return s.kernel + s.user }

// Collect 执行一次完整采集。
// 字段语义与 Python win_collector.py collect() 对齐（并行对比基准）。
func (c *windowsCollector) Collect() (*Metrics, error) {
	now := time.Now()

	// CPU：GetSystemTimes 差分。kernel 含 idle → total = Δkernel + Δuser。
	cur, err := readWinCPUSample()
	if err != nil {
		return nil, fmt.Errorf("GetSystemTimes: %w", err)
	}
	cpu := winCPUPercent(c.prevCPU, cur)
	c.prevCPU = cur

	// 内存 + Swap（PageFile 语义，与 psutil.swap_memory 一致）
	swapUsed, swapTotal, swapPct, memUsed, memTotal, memPct, err := readWinMem()
	if err != nil {
		return nil, fmt.Errorf("GlobalMemoryStatusEx: %w", err)
	}

	// 磁盘：全部固定盘求和（对齐 Python）；多盘数组为 Go 版增量（Python 不发）
	disks := winDiskList()
	var diskUsed, diskTotal uint64
	for _, d := range disks {
		diskUsed += d.Used
		diskTotal += d.Total
	}
	var diskPct float64
	if diskTotal > 0 {
		diskPct = round2(float64(diskUsed) / float64(diskTotal) * 100)
	}

	// 网络：全部非 loopback 接口求和（GetIfEntry2，64 位计数）
	rx, tx, err := winNetTotals()
	if err != nil {
		return nil, fmt.Errorf("GetIfEntry2: %w", err)
	}
	var rxRate, txRate float64
	if c.prevNet != nil && !c.prevNetTime.IsZero() {
		dt := now.Sub(c.prevNetTime).Seconds()
		if dt > 0 {
			if rx > c.prevNet.rx {
				rxRate = float64(rx-c.prevNet.rx) / dt
			}
			if tx > c.prevNet.tx {
				txRate = float64(tx-c.prevNet.tx) / dt
			}
		}
	}
	c.prevNet = &netSample{rx, tx}
	c.prevNetTime = now

	// 运行时间（GetTickCount64，ms）
	uptime := winUptime()

	hostname, _ := os.Hostname()

	return &Metrics{
		Hostname: hostname,
		OS:       winOsName(),
		Uptime:   uptime,
		CPU:      round2(cpu),
		MemUsed:  memUsed,
		MemTotal: memTotal,
		MemPct:   memPct,
		// 顶层盘 = 全部固定盘求和（对齐 Python win_collector.py:218-238）
		DiskUsed: diskUsed,
		DiskTotal: diskTotal,
		DiskPct:  diskPct,
		// Windows 无负载概念；0.0 = 未采集。红线：禁止进程数近似（M-1）。
		Load1:  0.0,
		Load5:  0.0,
		Load15: 0.0,
		Cores:  runtime.NumCPU(),
		Temp:   nil, // Windows 温度需 WMI（第三方依赖），红线不引入
		SwapUsed:  swapUsed,
		SwapTotal: swapTotal,
		SwapPct:   swapPct,
		NetRxRate: rxRate,
		NetTxRate: txRate,
		NetRx:     rx,
		NetTx:     tx,
		// Win32 直采无磁盘 IO 计数（PDH 属性能计数器面，路线图明确不抄）。
		// Python 版经 psutil.disk_io_counters 有真值——并行对比时的已知差异。
		DiskRRate: 0,
		DiskWRate: 0,
		Disks:     disks,
	}, nil
}

// readWinCPUSample 调 GetSystemTimes 取累计 idle/kernel/user。
func readWinCPUSample() (cpuSample, error) {
	var idle, kernel, user filetime
	r, _, _ := procGetSystemTimes.Call(
		uintptr(unsafe.Pointer(&idle)),
		uintptr(unsafe.Pointer(&kernel)),
		uintptr(unsafe.Pointer(&user)))
	if r == 0 {
		return cpuSample{}, errors.New("call failed")
	}
	return cpuSample{idle: idle.val(), kernel: kernel.val(), user: user.val()}, nil
}

// winCPUPercent 计算自上一样本以来的 CPU 占用率。
// 口径（gopsutil systemTimes）：System = kernel - idle（kernel 含 idle），
// total = user + system + idle = kernel + user；busy = total - idle。
func winCPUPercent(prev, cur cpuSample) float64 {
	if prev.total() == 0 || cur.idle < prev.idle || cur.kernel < prev.kernel || cur.user < prev.user {
		return 0 // 首样或计数回退（系统重启）
	}
	dTotal := cur.total() - prev.total()
	dIdle := cur.idle - prev.idle
	if dTotal <= 0 {
		return 0
	}
	pct := (float64(dTotal-dIdle) / float64(dTotal)) * 100
	if pct < 0 {
		pct = 0
	}
	if pct > 100 {
		pct = 100
	}
	return pct
}

// readWinMem 调 GlobalMemoryStatusEx 取内存与交换区（PageFile 语义）。
func readWinMem() (swapUsed, swapTotal uint64, swapPct float64, memUsed, memTotal uint64, memPct float64, err error) {
	var m memoryStatusEx
	m.cbSize = uint32(unsafe.Sizeof(m))
	r, _, _ := procGlobalMemoryStatusEx.Call(uintptr(unsafe.Pointer(&m)))
	if r == 0 {
		return 0, 0, 0, 0, 0, 0, errors.New("call failed")
	}
	if m.ullTotalPhys > 0 {
		memTotal = m.ullTotalPhys
		memUsed = m.ullTotalPhys - m.ullAvailPhys
		memPct = round2(float64(memUsed) / float64(memTotal) * 100)
	}
	if m.ullTotalPageFile > 0 {
		swapTotal = m.ullTotalPageFile
		swapUsed = m.ullTotalPageFile - m.ullAvailPageFile
		swapPct = round2(float64(swapUsed) / float64(swapTotal) * 100)
	}
	return
}

// winUptime 取系统运行秒数（GetTickCount64，49.7 天回绕在 Win Vista+ 已消除）。
func winUptime() float64 {
	r, _, _ := procGetTickCount64.Call()
	return round1(float64(uint64(r)) / 1000.0)
}

// winDiskList 枚举固定盘（GetLogicalDrives + GetDriveTypeW + GetDiskFreeSpaceExW）。
// 对应 Python psutil.disk_partitions() 过滤 'fixed'。按盘符排序，最多 26。
func winDiskList() []DiskInfo {
	mask, _, _ := procGetLogicalDrives.Call()
	var out []DiskInfo
	for bit := 0; bit < 26; bit++ {
		if mask&(1<<uint(bit)) == 0 {
			continue
		}
		root := string(rune('A'+bit)) + `:\`
		rootPtr, err := syscall.UTF16PtrFromString(root)
		if err != nil {
			continue
		}
		if t, _, _ := procGetDriveTypeW.Call(uintptr(unsafe.Pointer(rootPtr))); t != driveTypeFixed {
			continue
		}
		var freeToCaller, totalBytes, totalFree uint64
		r, _, _ := procGetDiskFreeSpaceExW.Call(
			uintptr(unsafe.Pointer(rootPtr)),
			uintptr(unsafe.Pointer(&freeToCaller)),
			uintptr(unsafe.Pointer(&totalBytes)),
			uintptr(unsafe.Pointer(&totalFree)))
		if r == 0 || totalBytes == 0 {
			continue
		}
		used := totalBytes - totalFree
		out = append(out, DiskInfo{
			Mount: root,
			Used:  used,
			Total: totalBytes,
			Pct:   round2(float64(used) / float64(totalBytes) * 100),
		})
	}
	return out
}

// winNetTotals 求和全部非 loopback 接口的收发字节（GetIfEntry2，64 位计数）。
// 对齐 Python psutil.net_io_counters()（排除 loopback）。
func winNetTotals() (uint64, uint64, error) {
	// 标准库 net.Interfaces 在 Windows 底层即 GetAdaptersAddresses（iphlpapi），
	// 零依赖拿到接口索引列表；再用 GetIfEntry2 取 64 位计数。
	ifaces, err := net.Interfaces()
	if err != nil {
		return 0, 0, err
	}
	var rx, tx uint64
	found := false
	for _, ifi := range ifaces {
		row := mibIfRow2{InterfaceIndex: uint32(ifi.Index)}
		r, _, _ := procGetIfEntry2.Call(uintptr(unsafe.Pointer(&row)))
		if r != 0 {
			continue // 单接口失败不拖垮总量（与 psutil 容错一致）
		}
		if row.Type == ifTypeLoopback {
			continue
		}
		rx += row.InOctets
		tx += row.OutOctets
		found = true
	}
	if !found {
		return 0, 0, errors.New("no interface data")
	}
	return rx, tx, nil
}

// winOsName 取产品名口径，与 Python os_name()（L-9 修正后）一致：
// 只输出 "Windows 10" / "Windows 11"（不含 build 号），注册表不可读时 "Windows"。
func winOsName() string {
	h, err := regOpen(regCurVerKeyPath)
	if err != nil {
		return "Windows"
	}
	defer procRegCloseKey.Call(uintptr(h))
	buildStr, err := regGetSz(h, "CurrentBuildNumber")
	if err != nil {
		return "Windows"
	}
	var build int
	for _, ch := range strings.TrimSpace(buildStr) {
		if ch < '0' || ch > '9' {
			break
		}
		build = build*10 + int(ch-'0')
	}
	switch {
	case build >= 22000:
		return "Windows 11"
	case build >= 10240:
		return "Windows 10"
	default:
		return "Windows"
	}
}

// regOpen 打开 HKLM 下注册表键（64 位视图）。
func regOpen(path string) (syscall.Handle, error) {
	var h syscall.Handle
	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return 0, err
	}
	r, _, _ := procRegOpenKeyExW.Call(
		uintptr(regHKLM),
		uintptr(unsafe.Pointer(p)),
		0,
		uintptr(regKeyRead64),
		uintptr(unsafe.Pointer(&h)))
	if r != 0 {
		return 0, fmt.Errorf("RegOpenKeyExW failed: code %d", r)
	}
	return h, nil
}

// regGetSz 读 REG_SZ 值。
func regGetSz(h syscall.Handle, name string) (string, error) {
	np, err := syscall.UTF16PtrFromString(name)
	if err != nil {
		return "", err
	}
	buf := make([]uint16, 512)
	var typ uint32
	buflen := uint32(len(buf) * 2)
	r, _, _ := procRegQueryValueExW.Call(
		uintptr(h),
		uintptr(unsafe.Pointer(np)),
		0,
		uintptr(unsafe.Pointer(&typ)),
		uintptr(unsafe.Pointer(&buf[0])),
		uintptr(unsafe.Pointer(&buflen)))
	if r != 0 {
		return "", fmt.Errorf("RegQueryValueExW failed: code %d", r)
	}
	end := 0
	for ; end < int(buflen/2); end++ {
		if buf[end] == 0 {
			break
		}
	}
	return syscall.UTF16ToString(buf[:end]), nil
}
