#!/usr/bin/env python3
"""Collect system metrics on Windows using psutil.

The returned dict shape mirrors agent/collector.py so the server treats reports
from Windows and Linux agents identically (no server-side changes required).

Windows has no load average; load1/load5/load15 are reported as 0.0
(not collected — process count is a forbidden fingerprint field).
"""
import os
import re
import time
import json
import shutil
import socket
import platform
import subprocess
import logging
import concurrent.futures
from datetime import datetime

log = logging.getLogger('diting.win_collector')

try:
    import psutil
except ImportError:
    import sys
    print('ERROR: psutil is required. Run: pip install -r requirements.txt', file=sys.stderr)
    raise


def parse_probe_targets(spec):
    """Parse PROBE_TARGETS env spec: 'label:host[:port],...'. Empty -> [].

    The server NEVER supplies these targets — fixed in the agent's local
    config. Probing is a self-contained reachability test against public
    infrastructure, NOT a server-pushed scan (no command channel).
    """
    out = []
    if not spec:
        return out
    for part in spec.split(','):
        part = part.strip()
        if not part:
            continue
        if ':' not in part:
            out.append((part, part, 53))
            continue
        label, rest = part.split(':', 1)
        host = rest
        port = 53
        if ':' in rest:
            host, p = rest.rsplit(':', 1)
            try:
                port = int(p)
            except Exception as e:
                log.debug("bad probe port %r: %s", p, e)
                port = 53
        # 基础格式校验（防御 operator 误配；host 来自本地配置，非服务端下发，无注入面）。
        # host 非空且长度 ≤ 253（域名上限）；port 落在 [1,65535]；label 超限截断到 24（与服务端一致）。
        label = label.strip() or host
        if not host or len(host) > 253 or not (1 <= int(port) <= 65535):
            continue
        if len(label) > 24:
            label = label[:24]
        out.append((label, host, port))
        if len(out) >= 8:  # 上限 8 个目标，与 Go 端一致
            break
    return out


def probe_one(host, port=443, timeout=2.5, retries=3):
    """Measure RTT (ms) to host. Prefer ICMP (system ping); fall back to TCP.

    宽松化（与 Linux agent/collector.py 保持一致）：TCP 回退依次尝试
    443 / 80 / 目标端口，只要任一可连通即视为可达；并重试多次吸收单次抖动/
    端口偶发不可达，避免把运营商探测点（cm/cu 等）轻易判为"中断"。
    返回 (ms: float|None, ok: bool)。纯网络自测，只采 RTT 与可达性，不采任何
    主机指纹。"""
    def _icmp():
        if shutil.which('ping'):
            try:
                if os.name == 'nt':
                    cmd = ['ping', '-n', '1', '-w', str(int(timeout * 1000)), host]
                else:
                    cmd = ['ping', '-c', '1', '-W', str(int(timeout)), host]
                out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 2)
                s = (out.stdout or '') + (out.stderr or '')
                m = re.search(r'平均\s*=\s*([\d.,]+)\s*ms', s)            # Windows
                if not m:
                    m = re.search(r'=\s*[\d.]+/([\d.]+)/[\d.]+/[\d.]+\s*ms', s)  # Linux avg
                if m:
                    return round(float(m.group(1).replace(',', '.')), 1), True
                # ICMP 通但 RTT 解析失败（个别系统输出格式差异）仍判可达，
                # 避免把能 ping 通的运营商 DNS 误判为中断。Windows 的 ping 对
                # 不可达也返回 0，故仅对非 nt 生效。
                if out.returncode == 0 and os.name != 'nt':
                    return None, True
            except Exception as e:
                log.debug("icmp probe failed: %s", e)
        return None, False

    def _tcp():
        import socket as _sock
        # 443/80 最常被放行；目标端口（如 DNS 的 53）作为最后兜底。
        ports = [443, 80]
        if port not in ports:
            ports.append(port)
        for p in ports:
            try:
                t0 = time.time()
                with _sock.create_connection((host, p), timeout=timeout):
                    return round((time.time() - t0) * 1000.0, 1), True
            except Exception as e:
                log.debug("tcp probe %s:%s failed: %s", host, p, e)
                continue
        return None, False

    for _ in range(max(1, retries)):
        ms, ok = _icmp()
        if ok:
            return ms, True
        ms, ok = _tcp()
        if ok:
            return ms, True
    return None, False


def os_name():
    """Best-effort human-readable Windows edition, e.g. 'Windows 11 Pro 23H2'."""
    try:
        import winreg
        with winreg.OpenKey(
            winreg.HKEY_LOCAL_MACHINE,
            r'SOFTWARE\Microsoft\Windows NT\CurrentVersion',
        ) as k:
            prod = winreg.QueryValueEx(k, 'ProductName')[0]
            try:
                build = winreg.QueryValueEx(k, 'DisplayVersion')[0]
            except Exception as e:
                log.debug("DisplayVersion read failed: %s", e)
                build = ''
            try:
                cb = int(winreg.QueryValueEx(k, 'CurrentBuild')[0] or 0)
                # Windows 11 has build >= 22000 (registry still says "Windows 10")
                if cb >= 22000 and prod.startswith('Windows 10'):
                    prod = prod.replace('Windows 10', 'Windows 11')
            except Exception as e:
                log.debug("CurrentBuild read failed: %s", e)
            return (prod + (' ' + build if build else '')).strip()
    except Exception as e:
        log.debug("winreg os name failed: %s", e)
    try:
        # L-9：兜底只取产品名（如 "Windows 10"），不带 build 号——
        # ver[1] 是 build 号、platform.platform() 含内核版本，同属主机指纹范围。
        ver = platform.win32_ver()
        return ' '.join([platform.system(), ver[0]]).strip()
    except Exception as e:
        log.debug("win32_ver failed: %s", e)
        return platform.system()


class WinCollector:
    def __init__(self, disk_path='C:\\', state_file='state.json', probe_targets=None):
        self.disk_path = disk_path or 'C:\\'
        self.state_file = state_file
        self.probe_targets = probe_targets or []
        self._net_prev = None
        self._net_prev_ts = 0
        self._disk_io_prev = None
        self._disk_io_prev_ts = 0
        # 告警限流时间戳必须先于 _load_state 初始化：_load_state 失败时会走
        # _warn_state，若此处顺序颠倒会在构造期抛 AttributeError 导致 agent 起不来。
        self._state_warn_ts = 0.0
        # 状态加载结果：self._state_mode ∈ {'ok','first-run','corrupt','blocked'}
        self._state, self._state_mode = self._load_state()
        # Prime the CPU sample so the first collect() returns a real percentage.
        try:
            psutil.cpu_percent(interval=0.1)
        except Exception as e:
            log.debug("cpu primer failed: %s", e)

    def _warn_state(self, msg):
        """状态文件异常告警：首条立即打，其后同一小时内最多一条（不刷屏）。

        用 warning 而非 debug：默认日志级别是 WARNING，debug 会让「state.json
        写不进去」这类持续错误在日志里完全不可见（2026-10-13 真机复盘：写入自
        09-15 起持续失败 28 天，月流量每次重启静默归零，日志里零线索）。
        """
        now = time.time()
        if now - self._state_warn_ts >= 3600:
            self._state_warn_ts = now
            log.warning("%s: %s", self.state_file, msg)

    def _load_state(self):
        """读取月流量状态，返回 (state, mode)。

        mode 语义（关键：「读不到」不能当成「新月」或「首跑」）：
          ok        读到合法状态 → 正常续算
          first-run 文件不存在（首次运行）→ 从 0 起算
          corrupt   文件存在但不是合法 JSON 对象 → 内容不可恢复，告警后重建
          blocked   文件存在但读不出来（权限/占用/IO 错误）→ 不清零、不写盘，
                    每轮 collect() 重试，恢复后自动接上历史月值
        """
        try:
            with open(self.state_file) as f:
                data = json.load(f)
        except FileNotFoundError:
            return {}, 'first-run'
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._warn_state('内容损坏无法解析，将重建（原月累计已丢失）')
            return {}, 'corrupt'
        except OSError as e:
            self._warn_state("读取失败（%s）；月累计暂存内存并自动重试" % e)
            return {}, 'blocked'
        if not isinstance(data, dict):
            self._warn_state('内容不是 JSON 对象，将重建（原月累计已丢失）')
            return {}, 'corrupt'
        return data, 'ok'

    def _save_state(self):
        """原子写入状态文件：先写同目录 .tmp，再 os.replace 覆盖（L-14）。

        与 Linux 版 collector.py:421-429 及 Go 版 state.go 一致。原实现直接
        open(w) 覆写，断电/进程被杀时可能留下空文件；且失败只打 debug 日志。
        此处写失败仅告警不抛出——采集/上报主流程不因状态文件不可写而中断
        （月累计此时退化为进程内存内累计，并在日志中明确可见）。
        """
        try:
            d = os.path.dirname(self.state_file) or '.'
            os.makedirs(d, exist_ok=True)
            tmp = self.state_file + '.tmp'
            with open(tmp, 'w') as f:
                json.dump(self._state, f)
            os.replace(tmp, self.state_file)
        except Exception as e:
            self._warn_state("写入失败（%s）；本轮月累计未落盘，下轮重试" % e)

    def _net_totals(self):
        """Total rx/tx bytes across all interfaces (excludes loopback by psutil)."""
        c = psutil.net_io_counters()
        return c.bytes_recv, c.bytes_sent

    def collect(self):
        # CPU: percent since the primer / last call.
        try:
            cpu = psutil.cpu_percent(interval=None)
        except Exception as e:
            log.debug("cpu percent failed: %s", e)
            cpu = 0.0
        if cpu is None:
            cpu = 0.0

        vm = psutil.virtual_memory()
        mem_used = vm.used
        mem_total = vm.total
        mem_pct = vm.percent

        try:
            # 自动探测所有固定硬盘（disk_path 为 'C:\' 或空时走全盘检测）
            paths = []
            if self.disk_path and self.disk_path.strip() and self.disk_path.strip() != 'C:\\':
                paths = [p.strip() for p in self.disk_path.split(',') if p.strip()]
            else:
                paths = [p.mountpoint for p in psutil.disk_partitions()
                         if 'fixed' in (p.opts or '').lower()]
            total_used = 0
            total_total = 0
            for p in paths:
                try:
                    du = psutil.disk_usage(p)
                    total_used += du.used
                    total_total += du.total
                except Exception as e:
                    log.debug("disk_usage %s failed: %s", p, e)
            disk_total = total_total
            disk_used = total_used
            disk_pct = round(total_used / total_total * 100, 2) if total_total > 0 else 0.0
        except Exception as e:
            log.debug("disk usage scan failed: %s", e)
            disk_total = disk_used = 0
            disk_pct = 0.0

        rx, tx = self._net_totals()
        now = time.time()
        rx_rate = tx_rate = 0.0
        if self._net_prev is not None and self._net_prev_ts:
            dt = now - self._net_prev_ts
            if dt > 0:
                rx_rate = max(0.0, (rx - self._net_prev[0]) / dt)
                tx_rate = max(0.0, (tx - self._net_prev[1]) / dt)
        self._net_prev = (rx, tx)
        self._net_prev_ts = now

        # Disk I/O rate
        disk_r_rate = disk_w_rate = 0.0
        try:
            dio = psutil.disk_io_counters()
            if dio:
                dr, dw = dio.read_bytes, dio.write_bytes
                if self._disk_io_prev is not None and self._disk_io_prev_ts:
                    dt = now - self._disk_io_prev_ts
                    if dt > 0:
                        disk_r_rate = max(0.0, (dr - self._disk_io_prev[0]) / dt)
                        disk_w_rate = max(0.0, (dw - self._disk_io_prev[1]) / dt)
                self._disk_io_prev = (dr, dw)
                self._disk_io_prev_ts = now
        except Exception as e:
            log.debug("disk io rate failed: %s", e)

        # Monthly cumulative traffic (persisted, survives restart, resets on month rollover).
        # 'blocked'（文件存在但读不出来）时每轮重试一次读取：既不写盘也不做跨月
        # 判定，避免把可能完好的历史月值覆盖成「从 0 开始的新状态」；读取一旦恢复，
        # 本轮的差值累加会自动补上这段时间的流量（rx - 文件里的 last_rx）。
        if self._state_mode == 'blocked':
            self._state, self._state_mode = self._load_state()
        month_key = datetime.now().strftime('%Y-%m')
        st = self._state
        if self._state_mode != 'blocked' and st.get('month_key') != month_key:
            st['month_key'] = month_key
            st['month_rx'] = 0
            st['month_tx'] = 0
        if 'last_rx' in st and 'last_tx' in st:
            st['month_rx'] = st.get('month_rx', 0) + max(0, rx - st['last_rx'])
            st['month_tx'] = st.get('month_tx', 0) + max(0, tx - st['last_tx'])
        st['last_rx'] = rx
        st['last_tx'] = tx
        if self._state_mode != 'blocked':
            self._save_state()

        # Network self-test (fixed public targets from local config; no server command).
        probes = {}
        if self.probe_targets:
            try:
                with concurrent.futures.ThreadPoolExecutor(max_workers=len(self.probe_targets)) as ex:
                    for label, ms, ok in ex.map(lambda t: (t[0],) + probe_one(t[1], t[2]), self.probe_targets):
                        probes[label] = {'ms': ms, 'ok': ok}
            except Exception as e:
                log.debug("probe collection failed: %s", e)
                probes = {}

        try:
            uptime = time.time() - psutil.boot_time()
        except Exception as e:
            log.debug("boot_time failed: %s", e)
            uptime = 0.0

        # Temperature (may be empty on some hosts -> None). Non-fingerprint metric.
        try:
            temps = []
            for _, entries in psutil.sensors_temperatures().items():
                for e in entries:
                    if e.current is not None:
                        temps.append(e.current)
            temp = round(max(temps), 1) if temps else None
        except Exception as ex:
            log.debug("temp scan failed: %s", ex)
            temp = None

        # Swap usage. Non-fingerprint metric.
        try:
            sm = psutil.swap_memory()
            swap_used = sm.used
            swap_total = sm.total
            swap_pct = sm.percent
        except Exception as e:
            log.debug("swap_memory failed: %s", e)
            swap_used = swap_total = 0
            swap_pct = 0.0

        return {
            'hostname': socket.gethostname(),
            'os': os_name(),
            'uptime': round(uptime, 1),
            'cpu': round(cpu, 2),
            'mem_used': mem_used,
            'mem_total': mem_total,
            'mem_pct': round(mem_pct, 2),
            'disk_used': disk_used,
            'disk_total': disk_total,
            'disk_pct': round(disk_pct, 2),
            # Windows has no load average concept; 0.0 = 未采集。
            # 禁止用进程数（len(psutil.pids())）近似：进程列表属指纹字段（红线）。
            'load1': 0.0, 'load5': 0.0, 'load15': 0.0,
            # 逻辑核数（§9 T18）：服务端据此换算每核负载；拿不到则为 0（视为未上报）
            'cores': psutil.cpu_count(logical=True) or 0,
            'temp': temp,
            'swap_used': swap_used,
            'swap_total': swap_total,
            'swap_pct': round(swap_pct, 2),
            'net_rx_rate': rx_rate,
            'net_tx_rate': tx_rate,
            'net_rx_month': st.get('month_rx', 0),
            'net_tx_month': st.get('month_tx', 0),
            'disk_r_rate': disk_r_rate,
            'disk_w_rate': disk_w_rate,
            'probes': probes
        }
