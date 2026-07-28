'use strict';

/* ============================================================
   糖果屋 (Neobrutalism) — Diting 公开状态页渲染逻辑
   数据源：免登录的 /api/public/* （与官方 public.js 同源契约）
   ============================================================ */

const $ = (id) => document.getElementById(id);

let publicAgents = [];
let publicServerOrder = [];
let localOrder = [];
let publicLayout = 'grid';
let publicTemplate = 'visual';
let publicOverview = null;
let publicSparklines = {};

// ---------- helpers ----------
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}
function fmtBytes(b) {
  if (b == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0; let n = Number(b);
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i ? 1 : 0) + ' ' + u[i];
}
function fmtPct(p) { return (p == null ? '—' : Number(p).toFixed(1)) + '%'; }
function fmtUptime(s) {
  s = Number(s) || 0;
  const d = Math.floor(s / 86400); const h = Math.floor((s % 86400) / 3600);
  return d > 0 ? d + '天' + h + '时' : h + '时' + Math.floor((s % 3600) / 60) + '分';
}
function pctClass(p) {
  if (p == null) return '';
  if (p >= 90) return 'bar-danger';
  if (p >= 75) return 'bar-warn';
  return '';
}
// 进度条填充：四档糖果彩虹（绿→黄→橙→粉），按使用率上色；不影响文字配色
function barFillCls(p) {
  if (p == null) return '';
  if (p >= 90) return 'bar-danger';
  if (p >= 78) return 'bar-orange';
  if (p >= 60) return 'bar-yellow';
  return '';
}
const PROBE_ABBR = { '联通': 'cu', '电信': 'ct', '移动': 'cm', '公共': 'GG' };
function probeLabel(l) { return PROBE_ABBR[l] || l; }
function probeClass(ms) {
  if (ms == null) return 'probe-na';
  if (ms < 50) return 'probe-green';
  if (ms < 200) return 'probe-blue';
  if (ms < 1000) return 'probe-yellow';
  return 'probe-red';
}
function parseProbes(s) {
  if (!s) return {};
  try { const o = JSON.parse(s); return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {}; }
  catch (e) { return {}; }
}
function fmtRate(bps) { return fmtBytes(Number(bps) || 0) + '/s'; }
function osIcon(os) {
  if (!os) return null;
  const l = os.toLowerCase();
  if (l.includes('debian'))  return { file: 'os-debian.svg', alt: 'Debian' };
  if (l.includes('ubuntu'))  return { file: 'os-ubuntu.svg', alt: 'Ubuntu' };
  if (l.includes('windows')) return { file: 'os-windows.svg', alt: 'Windows' };
  if (l.includes('centos'))  return { file: 'os-centos.svg', alt: 'CentOS' };
  if (l.includes('alma'))    return { file: 'os-alma.svg', alt: 'AlmaLinux' };
  if (l.includes('rocky'))   return { file: 'os-rocky.svg', alt: 'Rocky' };
  if (l.includes('fedora'))  return { file: 'os-fedora.svg', alt: 'Fedora' };
  if (l.includes('arch'))    return { file: 'os-arch.svg', alt: 'Arch' };
  if (l.includes('alpine'))  return { file: 'os-alpine.svg', alt: 'Alpine' };
  if (l.includes('freebsd')) return { file: 'os-freebsd.svg', alt: 'FreeBSD' };
  if (l.includes('macos') || l.includes('darwin')) return { file: 'os-macos.svg', alt: 'macOS' };
  return null;
}
function daysUntil(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d)) return null;
  return Math.ceil((d - new Date()) / 86400000);
}
function _flagImgImg(code) { return window.flagImg ? window.flagImg(code) : ''; }
function _countryName(code) { return window.countryName ? window.countryName(code) : code; }

// ---------- 主题（暗 / 亮） ----------
function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
  else document.documentElement.removeAttribute('data-theme');
}
function currentEffectiveTheme() {
  const t = localStorage.getItem('theme');
  if (t === 'light' || t === 'dark') return t;
  return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
}
function syncThemeIcon() {
  const btn = $('pvTheme');
  if (!btn) return;
  const dark = currentEffectiveTheme() === 'dark';
  btn.textContent = dark ? '🌙' : '☀️';
  btn.title = dark ? '切换到亮色' : '切换到暗色';
  btn.setAttribute('aria-pressed', dark ? 'true' : 'false');
}
function quickToggleTheme() {
  const next = currentEffectiveTheme() === 'dark' ? 'light' : 'dark';
  localStorage.setItem('theme', next);
  applyTheme(next);
  syncThemeIcon();
}

// ---------- sparkline 内联 SVG ----------
function pubSparkline(values, color) {
  values = (values || []).filter((v) => Number.isFinite(v));
  if (values.length === 0) return '';
  const w = 100, h = 30, max = Math.max(...values, 1e-9), min = Math.min(...values, 0);
  const range = (max - min) || 1;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1 || 1)) * w;
    const y = h - ((v - min) / range) * (h - 4) - 2;
    return x.toFixed(1) + ',' + y.toFixed(1);
  }).join(' ');
  return '<svg class="spark" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none">' +
    '<polyline points="' + pts + '" fill="none" stroke="' + color + '" stroke-width="1.8" /></svg>';
}
function pubSparkline2(rArr, wArr, rColor, wColor) {
  const r = (rArr || []).filter(v => Number.isFinite(v));
  const w = (wArr || []).filter(v => Number.isFinite(v));
  if (!r.length && !w.length) return '';
  const all = r.concat(w);
  const max = Math.max(...all, 1e-9), min = Math.min(...all, 0);
  const range = (max - min) || 1;
  const W = 100, H = 30;
  const pts = (arr) => {
    if (!arr.length) return '';
    return arr.map((v, i) => {
      const x = (i / (arr.length - 1 || 1)) * W;
      const y = H - ((v - min) / range) * (H - 4) - 2;
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
  };
  return '<svg class="spark" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' +
    (r.length ? '<polyline points="' + pts(r) + '" fill="none" stroke="' + rColor + '" stroke-width="1.8" />' : '') +
    (w.length ? '<polyline points="' + pts(w) + '" fill="none" stroke="' + wColor + '" stroke-width="1.8" />' : '') +
    '</svg>';
}

// ---------- 月流量 + 硬盘 两列 ----------
function pubTrafficAndDiskHtml(a) {
  const rx = Number(a.net_rx_month) || 0;
  const tx = Number(a.net_tx_month) || 0;
  const tqUsed = rx + tx;
  const quotaGB = Number(a.monthly_quota_gb) || 0;
  const quotaBytes = quotaGB * 1e9;
  const tqPct = quotaBytes > 0 ? Math.min(100, tqUsed / quotaBytes * 100) : 100;
  const tqCls = quotaGB > 0 ? barFillCls(tqPct) : '';
  const tqBar = '<div class="bar"><div class="bar-fill ' + tqCls + '" style="width:' + tqPct.toFixed(2) + '%"></div></div>';
  const tqStr = quotaGB > 0 ? (fmtBytes(tqUsed) + ' / ' + fmtBytes(quotaBytes)) : (fmtBytes(tqUsed) + ' / ∞');
  const tqPctStr = quotaGB > 0 ? tqPct.toFixed(1) + '%' : '—';

  let dUsed = 0, dTotal = 0;
  const disks = (a && Array.isArray(a.disks) && a.disks.length) ? a.disks : null;
  if (disks) { for (const d of disks) { dUsed += Number(d.used) || 0; dTotal += Number(d.total) || 0; } }
  else { dUsed = Number(a.disk_used) || 0; dTotal = Number(a.disk_total) || 0; }
  const dPct = dTotal ? (dUsed / dTotal * 100) : 0;
  const dCls = barFillCls(dPct);
  return '<div class="disk-row-2col">' +
    '<div class="disk-col">' +
      '<span class="dc-top"><span class="m-lbl">月流量</span><span class="dc-pct">' + tqPctStr + '</span></span>' +
      '<span class="dc-val">' + tqStr + '</span>' +
      tqBar +
    '</div>' +
    '<div class="disk-col">' +
      '<span class="dc-top"><span class="m-lbl">硬盘</span><span class="dc-pct">' + dPct.toFixed(1) + '%</span></span>' +
      '<span class="dc-val">' + fmtBytes(dUsed) + ' / ' + fmtBytes(dTotal) + '</span>' +
      '<div class="bar"><div class="bar-fill ' + dCls + '" style="width:' + dPct.toFixed(2) + '%"></div></div>' +
    '</div>' +
  '</div>';
}

// ---------- 单个节点卡片（visual / simple 两种模板） ----------
function pubCardHtml(a) {
  const statusCls = a.online ? 'on' : 'offline';
  const cpu = a.cpu, mem = a.mem_pct, disk = a.disk_pct;

  // ===== Visual 模板：完整指标 + sparkline 曲线 =====
  if (publicTemplate === 'visual') {
    const sp = publicSparklines[a.id] || [];
    const histOk = sp.length > 0;
    const cpuArr = histOk ? sp.map(x => x.cpu) : [cpu];
    const memArr = histOk ? sp.map(x => x.mem_pct) : [mem];
    const rxArr = histOk ? sp.map(x => +(x.net_rx_rate / 1024).toFixed(1)) : [0];
    const txArr = histOk ? sp.map(x => +(x.net_tx_rate / 1024).toFixed(1)) : [0];
    const loadArr = histOk ? sp.map(x => x.load1) : [a.load1];
    const tempArr = histOk ? sp.map(x => x.temp) : [a.temp];
    const swapArr = histOk ? sp.map(x => x.swap_pct) : [a.swap_pct];
    const diskRArr = histOk ? sp.map(x => +(x.disk_r_rate / 1024 / 1024).toFixed(1)) : [0];
    const diskWArr = histOk ? sp.map(x => +(x.disk_w_rate / 1024 / 1024).toFixed(1)) : [0];

    const d = daysUntil(a.expire_at);
    let expireBadge = '';
    if (d != null) {
      const cls = d < 0 ? 'expire' : (d <= 7 ? 'expire-soon' : '');
      const txt = d < 0 ? ('已过期 ' + (-d) + '天') : ('剩 ' + d + ' 天');
      expireBadge = '<span class="badge ' + cls + '">' + txt + '</span>';
    }
    const merchant = a.merchant ? '<span class="badge">' + esc(a.merchant) + '</span>' : '';
    const countryBadge = (a.country && _flagImgImg(a.country))
      ? _flagImgImg(a.country)
      : '';
    const probes = parseProbes(a.probes);
    const probeHtml = Object.keys(probes).length
      ? '<div class="probes">' + Object.keys(probes).map(l => {
          const p = probes[l];
          return '<span class="probe ' + probeClass(p && p.ms) + '">' + esc(probeLabel(l)) + ' ' + (p && p.ok ? (p.ms != null ? p.ms : '✓') : '—') + '</span>';
        }).join('') + '</div>'
      : '';

    const osHtml = a.online && a.os ? (() => {
      const o = osIcon(a.os);
      return (o ? '<img class="os-icon" src="/' + o.file + '" title="' + esc(o.alt) + '" />' : '') + esc(a.os);
    })() : '离线';

    return '<div class="card pub-card tpl-visual" data-id="' + esc(a.id) + '" draggable="true">' +
      '<div class="card-top">' +
        '<span class="status ' + statusCls + '"></span>' +
        '<h3>' + esc(a.name) + '</h3>' +
        merchant + countryBadge +
      '</div>' +
      '<div class="card-meta">' + esc(a.online ? (a.hostname || '') : '') + ' · ' + osHtml + '</div>' +
      (a.note ? '<div class="card-note">📝 ' + esc(a.note) + '</div>' : '') +
      '<div class="metrics">' +
        '<div class="metric"><div class="m-spark">' + pubSparkline(cpuArr, '#00BFFF') + '</div>' +
          '<div class="m-info"><span class="m-lbl">CPU</span><span class="m-val ' + pctClass(cpu) + '">' + fmtPct(cpu) + '</span></div></div>' +
        '<div class="metric"><div class="m-spark">' + pubSparkline(memArr, '#FF1493') + '</div>' +
          '<div class="m-info"><span class="m-lbl">内存</span><span class="m-val ' + pctClass(mem) + '">' + fmtPct(mem) + '</span></div></div>' +
        '<div class="metric"><div class="m-spark">' + pubSparkline(loadArr, '#FF6B1A') + '</div>' +
          '<div class="m-info"><span class="m-lbl">负载</span><span class="m-val">' + (a.load1 != null ? Number(a.load1).toFixed(2) : '—') + '</span></div></div>' +
        '<div class="metric"><div class="m-spark">' + pubSparkline(tempArr, '#B026FF') + '</div>' +
          '<div class="m-info"><span class="m-lbl">温度</span><span class="m-val">' + (a.temp != null ? Number(a.temp).toFixed(1) + '°' : '—') + '</span></div></div>' +
        '<div class="metric"><div class="m-spark">' + pubSparkline(swapArr, '#B026FF') + '</div>' +
          '<div class="m-info"><span class="m-lbl">Swap</span><span class="m-val">' + fmtPct(a.swap_pct) + '</span></div></div>' +
        '<div class="metric"><div class="m-spark">' + pubSparkline2(diskRArr, diskWArr, '#00BFFF', '#FF6B1A') + '</div>' +
          '<div class="m-info"><span class="m-lbl">IO</span><span class="m-val">' + ((a.disk_r_rate || 0) / 1048576).toFixed(2) + '/' + ((a.disk_w_rate || 0) / 1048576).toFixed(2) + '</span></div></div>' +
        '<div class="metric metric-wide">' +
          '<div class="m-spark">' + pubSparkline(rxArr, '#BFFF00') + '</div>' +
          '<div class="m-info">' +
            '<span class="m-lbl">网络</span>' +
            '<span class="m-val">↓ ' + fmtRate(a.net_rx_rate) + ' &nbsp;↑ ' + fmtRate(a.net_tx_rate) + '</span>' +
            probeHtml +
          '</div>' +
        '</div>' +
      '</div>' +
      pubTrafficAndDiskHtml(a) +
      '<div class="card-foot"><span class="uptime">⏱ ' + (a.online ? fmtUptime(a.uptime) : '—') + '</span>' +
        expireBadge +
        '<span class="foot-traffic">↓↑ ' + fmtBytes((a.net_rx_month || 0) + (a.net_tx_month || 0)) + '</span></div>' +
    '</div>';
  }

  // ===== Simple 模板：基础指标，无曲线 =====
  const d = daysUntil(a.expire_at);
  let expireBadge = '';
  if (d != null) {
    const cls = d < 0 ? 'expire' : (d <= 7 ? 'expire-soon' : '');
    const txt = d < 0 ? ('已过期 ' + (-d) + '天') : ('剩 ' + d + ' 天');
    expireBadge = '<span class="badge ' + cls + '">' + txt + '</span>';
  }
  const countryBadge = (a.country && _flagImgImg(a.country)) ? _flagImgImg(a.country) : '';
  const merchant = a.merchant ? '<span class="badge">' + esc(a.merchant) + '</span>' : '';

  return '<div class="card pub-card tpl-simple" data-id="' + esc(a.id) + '" draggable="true">' +
    '<div class="card-top">' +
      '<span class="status ' + statusCls + '"></span>' +
      '<h3>' + esc(a.name) + '</h3>' +
      merchant + countryBadge +
    '</div>' +
    '<div class="metrics-simple">' +
      '<div class="metric"><div class="m-info"><span class="m-lbl">CPU</span><span class="m-val ' + pctClass(cpu) + '">' + fmtPct(cpu) + '</span></div></div>' +
      '<div class="metric"><div class="m-info"><span class="m-lbl">内存</span><span class="m-val ' + pctClass(mem) + '">' + fmtPct(mem) + '</span></div></div>' +
      '<div class="metric"><div class="m-info"><span class="m-lbl">硬盘</span><span class="m-val ' + pctClass(disk) + '">' + fmtPct(disk) + '</span></div></div>' +
    '</div>' +
    pubTrafficAndDiskHtml(a) +
    '<div class="card-foot"><span class="uptime">⏱ ' + (a.online ? fmtUptime(a.uptime) : '—') + '</span>' +
      expireBadge +
      '<span class="foot-traffic">↓↑ ' + fmtBytes((a.net_rx_month || 0) + (a.net_tx_month || 0)) + '</span></div>' +
  '</div>';
}

// ---------- 列表视图 ----------
function pubListHtml(list) {
  if (!list || !list.length) return '<div class="empty">暂无客户端数据</div>';
  const body = list.map(a => {
    const statusCls = a.online ? 'on' : 'offline';
    const flag = a.country && _flagImgImg(a.country)
      ? _flagImgImg(a.country)
      : '<span class="ct-sub">—</span>';
    return '<tr data-id="' + a.id + '" tabindex="0" aria-expanded="false">' +
      '<td><div class="ct-name"><span class="status ' + statusCls + '"></span>' + esc(a.name) + '</div>' +
        '<div class="ct-sub">' + esc(a.group || '') + (a.online ? (' · ' + esc(a.hostname || '')) : ' · 离线') + '</div></td>' +
      '<td>' + flag + '</td>' +
      '<td class="ct-num ' + (a.online && a.cpu >= 90 ? 'danger' : (a.online && a.cpu >= 75 ? 'warn' : '')) + '">' + fmtPct(a.cpu) + '</td>' +
      '<td class="ct-num ' + (a.online && a.mem_pct >= 90 ? 'danger' : (a.online && a.mem_pct >= 75 ? 'warn' : '')) + '">' + fmtPct(a.mem_pct) + '</td>' +
      '<td class="ct-num ' + pctClass(a.disk_pct) + '">' + fmtPct(a.disk_pct) + '</td>' +
      '<td class="ct-num">' + (a.online ? fmtUptime(a.uptime) : '—') + '</td>' +
      '<td class="ct-sub">' + (a.online ? (() => { const o = osIcon(a.os); return (o ? '<img class="os-icon" src="/' + o.file + '" title="' + esc(o.alt) + '" />' : '') + esc(a.os); })() : '—') + '</td>' +
      '<td class="ct-num">↓' + fmtRate(a.net_rx_rate) + ' ↑' + fmtRate(a.net_tx_rate) + '</td>' +
    '</tr>';
  }).join('');
  return '<table class="ctable"><thead><tr>' +
    '<th>名称</th><th>地区</th><th>CPU</th><th>内存</th><th>硬盘</th><th>在线</th><th>系统</th><th>网速</th>' +
    '</tr></thead><tbody>' + body + '</tbody></table>';
}

// ---------- 列表行点击展开详情 ----------
function showPublicDetail(id, tr) {
  const next = tr.nextElementSibling;
  if (next && next.classList.contains('expanded-row')) {
    next.remove();
    tr.classList.remove('expanded');
    tr.setAttribute('aria-expanded', 'false');
    return;
  }
  document.querySelectorAll('#pvList .expanded-row').forEach(r => r.remove());
  document.querySelectorAll('#pvList tr.expanded').forEach(r => { r.classList.remove('expanded'); r.setAttribute('aria-expanded', 'false'); });
  const a = publicAgents.find(x => String(x.id) === String(id));
  if (!a) return;
  tr.classList.add('expanded');
  tr.setAttribute('aria-expanded', 'true');
  const probes = parseProbes(a.probes);
  const probeKeys = Object.keys(probes);
  const statusCls = a.online ? 'on' : 'offline';
  const row = document.createElement('tr');
  row.className = 'expanded-row';
  row.innerHTML = '<td colspan="8"><div class="expand-content">' +
    '<div class="ex-header">' +
      '<span class="status ' + statusCls + '"></span>' +
      '<strong>' + esc(a.name) + '</strong>' +
      (a.merchant ? '<span class="badge">' + esc(a.merchant) + '</span>' : '') +
      (a.country && _flagImgImg(a.country) ? _flagImgImg(a.country) : '') +
      '<span class="badge">' + esc(a.hostname || '') + '</span>' +
      (a.os ? '<span class="badge">' + (() => { const o = osIcon(a.os); return o ? '<img class="os-icon" src="/' + o.file + '" title="' + esc(o.alt) + '" />' : ''; })() + esc(a.os) + '</span>' : '') +
    '</div>' +
    '<div class="ex-stats">' +
      '<div class="ex-stat"><span class="ex-lbl">CPU</span><span class="ex-val ' + pctClass(a.cpu) + '">' + fmtPct(a.cpu) + '</span></div>' +
      '<div class="ex-stat"><span class="ex-lbl">内存</span><span class="ex-val ' + pctClass(a.mem_pct) + '">' + fmtPct(a.mem_pct) + '</span></div>' +
      '<div class="ex-stat"><span class="ex-lbl">硬盘</span><span class="ex-val ' + pctClass(a.disk_pct) + '">' + fmtPct(a.disk_pct) + '</span></div>' +
      '<div class="ex-stat"><span class="ex-lbl">负载</span><span class="ex-val">' + (a.load1 != null ? Number(a.load1).toFixed(2) : '—') + '</span></div>' +
      '<div class="ex-stat"><span class="ex-lbl">温度</span><span class="ex-val">' + (a.temp != null ? Number(a.temp).toFixed(1) + '°C' : '—') + '</span></div>' +
      '<div class="ex-stat"><span class="ex-lbl">Swap</span><span class="ex-val">' + fmtPct(a.swap_pct) + '</span></div>' +
    '</div>' +
    '<div class="ex-net-row">' +
      '<span class="ex-lbl">网络</span>' +
      '<span class="ex-rate" style="color:#00BFFF">↓ ' + fmtRate(a.net_rx_rate) + '</span>' +
      '<span class="ex-rate" style="color:#FF1493">↑ ' + fmtRate(a.net_tx_rate) + '</span>' +
      '<span class="ex-lbl">⏱ ' + (a.online ? fmtUptime(a.uptime) : '—') + '</span>' +
      '<span class="ex-lbl">↓↑ ' + fmtBytes((a.net_rx_month || 0) + (a.net_tx_month || 0)) + '</span>' +
    '</div>' +
    '<div class="ex-probes">' + (probeKeys.length ? probeKeys.map(l => {
      const p = probes[l];
      return '<span class="probe ' + probeClass(p && p.ms) + '">' + esc(probeLabel(l)) + ' ' + (p && p.ok ? (p.ms != null ? p.ms : '✓') : '—') + '</span>';
    }).join('') : '<span class="ct-sub">暂无探测数据</span>') + '</div>' +
  '</div></td>';
  tr.after(row);
}

// ---------- 渲染 ----------
function renderPublic() {
  const grid = $('pvGrid');
  const list = $('pvList');
  if (!grid || !list) {
    console.error("Missing elements in renderPublic");
    return;
  }

  // 10s 重渲染前，记下列表视图的展开态与键盘焦点，刷新后还原，避免被整段 innerHTML 清空
  let preservedExpanded = null, preservedFocus = null;
  if (publicLayout === 'list') {
    const expTr = list.querySelector('tr.expanded');
    if (expTr) preservedExpanded = expTr.getAttribute('data-id');
    const ae = document.activeElement;
    const fTr = ae && ae.closest ? ae.closest('#pvList tr[data-id]') : null;
    if (fTr) preservedFocus = fTr.getAttribute('data-id');
  }

  const ov = publicOverview;
  if ($('pvOverview') && ov) {
    const tr = publicAgents.reduce((s, a) => s + (a.net_rx_rate || 0) + (a.net_tx_rate || 0), 0);
    $('pvOverview').innerHTML =
      '<div class="stat-card stat-total"><div class="stat-k">总数</div><div class="stat-v">' + ov.total + '<small>台</small></div></div>' +
      '<div class="stat-card stat-online"><div class="stat-k">在线</div><div class="stat-v">' + ov.online + '<small>台</small></div></div>' +
      '<div class="stat-card stat-offline"><div class="stat-k">离线</div><div class="stat-v">' + ov.offline + '<small>台</small></div></div>' +
      '<div class="stat-card stat-net"><div class="stat-k">实时流量</div><div class="stat-v" style="font-size:1.4rem">↓ ' + fmtRate(publicAgents.reduce((s, a) => s + (a.net_rx_rate || 0), 0)) + ' ↑ ' + fmtRate(publicAgents.reduce((s, a) => s + (a.net_tx_rate || 0), 0)) + '</div></div>';
  }

  if (publicLayout === 'list') {
    grid.hidden = true; list.hidden = false;
    list.innerHTML = pubListHtml(publicAgents);
    const findTr = id => { let r = null; list.querySelectorAll('tr[data-id]').forEach(x => { if (x.getAttribute('data-id') === id) r = x; }); return r; };
    if (preservedExpanded) { const t = findTr(preservedExpanded); if (t) showPublicDetail(preservedExpanded, t); }
    if (preservedFocus) { const t = findTr(preservedFocus); if (t) t.focus(); }
  } else {
    grid.hidden = false; list.hidden = true;
    grid.innerHTML = publicAgents.length ? publicAgents.map(pubCardHtml).join('') : '<div class="empty">暂无客户端数据</div>';
  }
}

// ---------- 社交链接 ----------
function renderSocialLinks(meta) {
  const el = $('footerSocial');
  if (!el) return;
  const items = [
    { key: 'social_email', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>', prefix: 'mailto:', label: '邮箱' },
    { key: 'social_telegram', icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>', prefix: 'https://t.me/', label: 'Telegram' },
    { key: 'social_qq', icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69a.2.2 0 0 0-.05-.18c-.06-.05-.14-.03-.21-.02-.09.02-1.49.95-4.22 2.79-.4.27-.76.41-1.08.4-.36-.01-1.04-.2-1.55-.37-.63-.2-1.12-.31-1.08-.66.02-.18.27-.36.74-.55 2.92-1.27 4.86-2.11 5.83-2.51 2.78-1.16 3.35-1.36 3.73-1.36.08 0 .27.02.39.12.1.08.13.19.14.27-.01.06.01.24 0 .37z"/></svg>', prefix: 'https://wpa.qq.com/msgrd?v=3&uin=', label: 'QQ' },
    { key: 'social_website', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>', prefix: '', label: '网站' }
  ];
  const html = items
    .filter(item => meta && meta[item.key])
    .map(item => {
      const val = encodeURIComponent(meta[item.key].trim());
      const href = item.prefix + val;
      return '<a href="' + href + '" target="_blank" rel="noopener" aria-label="' + item.label + '" title="' + item.label + '">' + item.icon + '</a>';
    }).join('');
  el.innerHTML = html;
}

// ---------- 加载 ----------
async function initPublic() {
  applyTheme(localStorage.getItem('theme') || 'auto');
  syncThemeIcon();
  let meta = null;
  try { meta = await (await fetch('/api/public/meta')).json(); } catch (e) {}
  const enabled = !!(meta && meta.public_enabled);
  publicServerOrder = (meta && Array.isArray(meta.agent_order)) ? meta.agent_order : [];
  try { const lo = JSON.parse(localStorage.getItem('pv_order') || '[]'); if (Array.isArray(lo)) localOrder = lo; } catch (e) {}
  const title = (meta && meta.site_title) || '谛听 · Diting';
  if ($('navTitle')) $('navTitle').textContent = title;
  if ($('pageTitle')) $('pageTitle').textContent = '轻量级探针';
  document.title = title + ' · 状态';
  const $pa = $('pvAdmin');
  if ($pa) {
    const su = (meta && meta.site_url || '').trim();
    $pa.href = su ? (su.replace(/\/+$/, '') + '/admin.html') : '/admin.html';
  }
  // 渲染社交链接
  renderSocialLinks(meta);
  // 异步加载版本
  fetch('/api/version').then(r => r.json()).then(function (v) {
    const el = $('fvVer');
    const ver = (v && v.data && v.data.version) || (v && v.version);
    if (el && ver) el.textContent = 'v' + ver;
  }).catch(function () {});
  if (!enabled) {
    if ($('pvOverview')) $('pvOverview').innerHTML = '';
    if ($('pvGrid')) $('pvGrid').innerHTML = '<div class="empty">本站暂未开放公开状态页</div>';
    if ($('pvList')) $('pvList').innerHTML = '';
    return;
  }
  publicLayout = meta.home_layout || 'grid';
  publicTemplate = localStorage.getItem('pv_template') || 'visual';
  syncLayoutButtons();
  syncTemplateButtons();
  await loadPublic();
}

async function loadPublic() {
  try {
    const [ov, ag, sp] = await Promise.all([
      fetch('/api/public/overview').then(r => r.json()).catch(() => null),
      fetch('/api/public/agents').then(r => r.json()).catch(() => []),
      (publicTemplate === 'visual')
        ? fetch('/api/public/agents/sparklines?range=6h').then(r => r.json()).catch(() => ({}))
        : Promise.resolve({})
    ]);
    publicOverview = ov;
    publicAgents = Array.isArray(ag) ? ag : [];
    publicAgents = sortByOrder(publicAgents);
    publicSparklines = sp || {};
  } catch (e) { publicOverview = null; publicAgents = []; publicSparklines = {}; }
  renderPublic();
}

// ---------- 布局/模版切换 ----------
function syncLayoutButtons() {
  document.querySelectorAll('[data-pvlayout]').forEach(b => {
    const on = b.getAttribute('data-pvlayout') === publicLayout;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}
function setPublicLayout(v) {
  publicLayout = v;
  syncLayoutButtons();
  renderPublic();
}
function syncTemplateButtons() {
  document.querySelectorAll('[data-pvtemplate]').forEach(b => {
    const on = b.getAttribute('data-pvtemplate') === publicTemplate;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}
function setPublicTemplate(v) {
  if (v !== 'simple' && v !== 'visual') return;
  publicTemplate = v;
  localStorage.setItem('pv_template', v);
  syncTemplateButtons();
  loadPublic();
}

// ---------- 拖拽排序 ----------
function sortByOrder(list) {
  const order = (localOrder && localOrder.length) ? localOrder : publicServerOrder;
  if (!order || !order.length) return list;
  const m = new Map(order.map((id, i) => [String(id), i]));
  return [...list].sort((a, b) => {
    const ia = m.has(String(a.id)) ? m.get(String(a.id)) : Infinity;
    const ib = m.has(String(b.id)) ? m.get(String(b.id)) : Infinity;
    return ia - ib;
  });
}
function persistOrder() {
  const order = publicAgents.map(a => String(a.id));
  localOrder = order;
  try { localStorage.setItem('pv_order', JSON.stringify(order)); } catch (e) {}
  fetch('/api/public/order', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order })
  }).then(r => { if (r.ok) publicServerOrder = order; }).catch(() => {});
}
function bindGridDrag() {
  const grid = $('pvGrid');
  if (!grid) return;
  let dragging = null;
  grid.addEventListener('dragstart', e => {
    const card = e.target.closest('.pub-card');
    if (!card) return;
    dragging = card;
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', card.getAttribute('data-id')); } catch (_) {}
  });
  grid.addEventListener('dragend', e => {
    const card = e.target.closest('.pub-card');
    if (card) card.classList.remove('dragging');
    if (dragging) {
      const ids = [...grid.querySelectorAll('.pub-card')].map(el => el.getAttribute('data-id'));
      const map = new Map(publicAgents.map(a => [String(a.id), a]));
      publicAgents = ids.map(id => map.get(id)).filter(Boolean);
      persistOrder();
    }
    dragging = null;
  });
  grid.addEventListener('dragover', e => {
    e.preventDefault();
    if (!dragging) return;
    const target = e.target.closest('.pub-card');
    if (!target || target === dragging) return;
    const box = target.getBoundingClientRect();
    const after = (e.clientX - box.left) > box.width / 2 || (e.clientY - box.top) > box.height / 2;
    if (after) grid.insertBefore(dragging, target.nextSibling);
    else grid.insertBefore(dragging, target);
  });
}

// ---------- 事件绑定 ----------
function bindPublic() {
  // Safety check: ensure required elements exist
  const grid = $('pvGrid');
  const list = $('pvList');
  if (!grid || !list) {
    console.error('Missing required DOM elements: pvGrid, pvList');
    return;
  }
  document.querySelectorAll('[data-pvlayout]').forEach(b => b.addEventListener('click', () => setPublicLayout(b.getAttribute('data-pvlayout'))));
  document.querySelectorAll('[data-pvtemplate]').forEach(b => b.addEventListener('click', () => setPublicTemplate(b.getAttribute('data-pvtemplate'))));
  const tb = $('pvTheme'); if (tb) tb.addEventListener('click', quickToggleTheme);
  bindGridDrag();
  const pl = $('pvList');
  if (pl) {
    pl.addEventListener('click', e => { const r = e.target.closest('tr[data-id]'); if (r) showPublicDetail(r.getAttribute('data-id'), r); });
    pl.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      const r = e.target.closest('tr[data-id]');
      if (!r) return;
      e.preventDefault();
      showPublicDetail(r.getAttribute('data-id'), r);
    });
  }
}

// Debug overlay — shows JS errors and load status directly on page
function showDebug(msg) {
  let el = $('pvDebug');
  if (!el) {
    el = document.createElement('div');
    el.id = 'pvDebug';
    el.style.cssText = 'position:fixed;top:60px;right:10px;z-index:9999;background:#FFE135;border:3px solid #000;padding:8px 12px;font:12px/1.4 JetBrains Mono,monospace;max-width:320px;box-shadow:4px 4px 0 0 #000;';
    document.body.appendChild(el);
  }
  el.innerHTML += '<br>' + new Date().toLocaleTimeString() + ' ' + msg;
}
function initPublicSafe() {
  try {
    initPublic();
  } catch(e) {
    showDebug('✗ initPublic ERROR: ' + e.message);
  }
}
window.addEventListener('error', e => showDebug('✗ window error: ' + e.message));

// Wait for DOM to be ready before initializing
document.addEventListener('DOMContentLoaded', () => {
  console.log('DOMContentLoaded - initializing neobrutalism theme');
  try {
    bindPublic();
    initPublicSafe();
    setInterval(loadPublic, 10000);
  } catch(e) {
    console.error('Failed to initialize:', e);
    showDebug('✗ init failed: ' + e.message);
  }
});