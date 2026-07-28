package collector

import (
	"bufio"
	"os"
	"sort"
	"strings"
	"syscall"
)

// realFS 是真实磁盘文件系统类型集合（对齐 Python collector.py:69-72）。
// 注意：刻意排除 tmpfs（内存盘不算硬盘），用 vfat 非 fat32。
var realFS = map[string]bool{
	"ext2": true, "ext3": true, "ext4": true, "xfs": true, "btrfs": true,
	"f2fs": true, "reiserfs": true, "jfs": true, "nilfs2": true,
	"vfat": true, "ntfs": true, "exfat": true, "zfs": true,
}

// diskUsage 调用 statvfs 返回 (used, total, pct) 字节。
func diskUsage(path string) (used, total uint64, pct float64) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return
	}
	bsize := uint64(st.Frsize)
	total = bsize * st.Blocks
	free := bsize * st.Bfree
	if total > free {
		used = total - free
	}
	if total > 0 {
		pct = float64(used) / float64(total) * 100
	}
	return
}

// diskList 返回所有真实磁盘挂载点的使用率列表（多盘展示）。
//
// 核心逻辑（复刻 Python collector.py:75-154）：
//  1. 读 /proc/mounts（Docker 形态优先 /hostproc/mounts）
//  2. 按 fstype 过滤 realFS，排除伪文件系统
//  3. 按 st_dev 去重（同盘多挂载合并，保留最短挂载点）
//  4. Docker 形态：只保留 /host 前缀条目，展示时去掉前缀
//  5. 排序：挂载点越短越靠前（/ 永远在最前）
//
// root: 容器形态传 "/host"，裸跑传 "/"。
func diskList(root string) []DiskInfo {
	prefix := ""
	mountsPath := "/proc/mounts"
	if root != "" && root != "/" {
		prefix = strings.Trim(root, "/")
		if prefix == "host" {
			if _, err := os.Stat("/hostproc/mounts"); err == nil {
				mountsPath = "/hostproc/mounts"
			}
		}
	}

	f, err := os.Open(mountsPath)
	if err != nil {
		return nil
	}
	defer f.Close()

	type cand struct {
		mount  string
		used   uint64
		total  uint64
		pct    float64
		dev    uint64
	}

	var cands []cand
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 3 {
			continue
		}
		mount, fstype := fields[1], fields[2]
		if !realFS[fstype] {
			continue
		}

		// Docker 形态：只保留 /host 前缀
		dispMount := mount
		if prefix == "host" {
			if mount != "/host" && !strings.HasPrefix(mount, "/host/") {
				continue
			}
			dispMount = mount[len("/host"):]
			if dispMount == "" {
				dispMount = "/"
			}
		}

		// 跳过文件型挂载点（如 /etc/hosts）
		info, err := os.Stat(mount)
		if err != nil || !info.IsDir() {
			continue
		}

		var st syscall.Statfs_t
		if err := syscall.Statfs(mount, &st); err != nil {
			continue
		}
		bsize := uint64(st.Frsize)
		total := bsize * st.Blocks
		free := bsize * st.Bfree
		var used uint64
		if total > free {
			used = total - free
		}
		var pct float64
		if total > 0 {
			pct = float64(used) / float64(total) * 100
		}

		dev := info.Sys().(*syscall.Stat_t).Dev
		cands = append(cands, cand{mount: dispMount, used: used, total: total, pct: pct, dev: dev})
	}

	// 按 st_dev 去重：同盘只保留最短挂载点
	best := map[uint64]cand{}
	for _, c := range cands {
		if ex, ok := best[c.dev]; !ok || len(c.mount) < len(ex.mount) {
			best[c.dev] = c
		}
	}

	out := make([]DiskInfo, 0, len(best))
	for _, c := range best {
		mount := c.mount
		if len(mount) > 200 {
			mount = mount[:200]
		}
		out = append(out, DiskInfo{
			Mount: mount,
			Used:  c.used,
			Total: c.total,
			Pct:   round2(c.pct),
		})
	}

	// 排序：挂载点越短越靠前
	sort.Slice(out, func(i, j int) bool {
		return len(out[i].Mount) < len(out[j].Mount) || (len(out[i].Mount) == len(out[j].Mount) && out[i].Mount < out[j].Mount)
	})

	// 约束最多 32 项
	if len(out) > 32 {
		out = out[:32]
	}
	return out
}

// round2 四舍五入到 2 位小数（对齐 Python round(pct, 2)）。
func round2(v float64) float64 {
	return float64(uint64(v*100+0.5)) / 100
}
