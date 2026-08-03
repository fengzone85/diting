'use strict';
// 公开受控端详情页（游客可访问，走免登录 /api/public/* 接口）
// 参考 Komari node detail：顶部状态卡 + 实时曲线 + 磁盘分区 + 系统信息 + 网络流量
(function () {
  const $ = (id) => document.getElementById(id);
  function fmtPct(p) { return (p == null ? '—' : Number(p).toFixed(1)) + '%'; }
  function fmtRate(bps) { return fmtBytes(Number(bps) || 0) + '/s'; }
  function fmtUptime(s) {
    s = Number(s) || 0;
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return d > 0 ? `${d}天${h}时${m}分` : `${h}时${m}分`;
  }
  function fmtDate(s) { if (!s) return '—'; try { return new Date(s).toLocaleDateString('zh-CN'); } catch (e) { return s; } }

  // Komari 式剩余价值计算：剩余天数 + 状态着色
  // 参考 chunk-PriceTags：c=ceil((expired_at-now)/86400000)
  function valueInfo(expireAt) {
    if (!expireAt) return null;
    const end = new Date(expireAt).getTime();
    if (isNaN(end)) return null;
    const f = end - Date.now();
    const c = Math.ceil(f / 86400000);
    if (c <= 0) return { days: c, label: '已到期', cls: 'val-expired' };
    if (c > 36500) return { days: c, label: '长期', cls: 'val-long' };
    const cls = c <= 7 ? 'val-warn' : c <= 15 ? 'val-mid' : 'val-ok';
    return { days: c, label: '剩余 ' + c + ' 天', cls };
  }

  // 只保留当前实际探测的探针标签（过滤 agent 已放弃的旧目标历史，避免曲线杂乱/浏览器卡顿）
  function filterCurrentProbes(series) {
    if (!series) return {};
    if (!currentProbeKeys.length) return series;
    const out = {};
    currentProbeKeys.forEach(k => { if (series[k]) out[k] = series[k]; });
    return out;
  }

  // 聚合序列：对每个探测点的 ms 序列做聚合（对齐 Komari 延迟聚合 value: avg/p95）
  // raw 原样；avg 用窗口移动平均平滑看趋势；p95 用滚动窗口取 95 分位看最差情况。
  function aggregateSeries(series, mode) {
    if (!series || mode === 'raw') return series;
    const WIN = mode === 'avg' ? 5 : 20; // avg 用小窗平滑，p95 用大窗统计
    const out = {};
    Object.keys(series).forEach((label) => {
      const pts = series[label];
      out[label] = pts.map((p, i) => {
        // 滚动窗口 [i-WIN+1, i]
        const from = Math.max(0, i - WIN + 1);
        const win = pts.slice(from, i + 1).filter(x => x.ms != null).map(x => x.ms);
        if (!win.length) return p;
        let v;
        if (mode === 'avg') v = Math.round(win.reduce((a, b) => a + b, 0) / win.length);
        else { // p95
          const s = win.slice().sort((a, b) => a - b);
          v = s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
        }
        return { ts: p.ts, ms: v, ok: p.ok, agg: mode };
      });
    });
    return out;
  }

  // 剩余价值徽章 HTML
  function valueHtml(expireAt) {
    const v = valueInfo(expireAt);
    if (!v) return '';
    return `<span class="nv-val ${v.cls}">${esc(v.label)}</span>`;
  }

  // Komari 式价格/周期标签（参考 chunk-PriceTags 的 billing_cycle 映射）
  function planLabel(price, cycle, currency) {
    const cur = currency || '¥';
    if (price == null) return '';
    if (price === -1) return '免费';
    const priceStr = cur + price;
    let cycleStr;
    const e = Number(cycle) || 0;
    if (e >= 27 && e <= 32) cycleStr = '月付';
    else if (e >= 87 && e <= 95) cycleStr = '季付';
    else if (e >= 175 && e <= 185) cycleStr = '半年';
    else if (e >= 360 && e <= 370) cycleStr = '年付';
    else if (e >= 720 && e <= 750) cycleStr = '两年';
    else if (e >= 1080 && e <= 1150) cycleStr = '三年';
    else if (e >= 1800 && e <= 1850) cycleStr = '五年';
    else if (e === -1) cycleStr = '一次性';
    else cycleStr = e + ' 天';
    return priceStr + ' / ' + cycleStr;
  }

  // 轻量 SVG 折线图：pts 为数值数组(0~max)，返回 inline svg 字符串
  function sparkline(pts, max, color) {
    if (!pts || !pts.length) return '<svg class="nv-chart" viewBox="0 0 100 30" preserveAspectRatio="none"></svg>';
    const n = pts.length;
    const maxV = max || Math.max.apply(null, pts) || 1;
    const step = n > 1 ? 100 / (n - 1) : 100;
    let d = '';
    for (let i = 0; i < n; i++) {
      const x = (i * step).toFixed(2);
      const y = (30 - Math.min(30, (pts[i] / maxV) * 30)).toFixed(2);
      d += (i === 0 ? 'M' : 'L') + x + ' ' + y + ' ';
    }
    const area = `M0 30 L ${d.replace(/^M/, '').trim().replace(/ L/g, ' L')} L100 30 Z`;
    return `<svg class="nv-chart" viewBox="0 0 100 30" preserveAspectRatio="none">
      <path d="${area}" fill="${color}" opacity="0.12"/>
      <path d="${d}" fill="none" stroke="${color}" stroke-width="1.4" vector-effect="non-scaling-stroke"/>
    </svg>`;
  }
  function bar(pct, cls) {
    const p = Math.max(0, Math.min(100, Number(pct) || 0));
    const c = cls || (p >= 90 ? 'bar-danger' : p >= 75 ? 'bar-warn' : '');
    return `<div class="nv-bar"><div class="nv-bar-fill ${c}" style="width:${p}%"></div></div>`;
  }
  function fmtTime(ts) {
    try { const d = new Date(ts); return d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0'); }
    catch (_) { return ''; }
  }
  // 多序列折线图（完全参考 Glassmorphism/Recharts 延迟图表）
  // - 尺寸：高 260px（Recharts 常见图表高度），宽 100% 容器自适应
  // - 交互：鼠标 hover 显示十字准星 + tooltip 浮层（时间 : 各曲线延迟值，分隔符 " : "）
  // - 图例点击切换曲线显示/隐藏、失败点红叉、延迟分档着色
  // - hiddenSet 为当前被隐藏的探测点标签集合
  function multiLine(series, hiddenSet) {
    const labels = Object.keys(series).filter(l => (series[l] || []).length);
    if (!labels.length) return '<div class="muted">暂无延迟数据</div>';
    const shown = labels.filter(l => !hiddenSet.has(l));
    // 配色跟随主题（Glassmorphism 用主题色 stroke-border，此处用 diting 主题变量）
    const palette = ['var(--accent)', 'var(--accent2)', 'var(--green, #2fc27e)', 'var(--yellow, #e4b41e)', '#a78bfa', '#2dd4bf', '#fb7185', '#34d399'];
    // 16:9 宽高比 + YAxis 宽 60 / XAxis 高 30（对齐 Glassmorphism aspect-video / YAxis width 60 / XAxis height 30）
    const W = 960, H = 540, padL = 12, padR = 60, padT = 12, padB = 30;
    // 每条曲线独立归一化（各探针延迟量级差异大，独立刻度才能看清各自的波动趋势）
    // 每条曲线用 [P05, P90] 作为纵轴范围，忽略极端尖峰，让主要数据铺满图表。
    const perLabelScale = {};
    const scaleOf = (l) => {
      if (!perLabelScale[l]) {
        const vals = series[l].filter(p => p.ms != null).map(p => p.ms);
        if (!vals.length) { perLabelScale[l] = { min: 0, max: 100 }; }
        else {
          const s = vals.slice().sort((a, b) => a - b);
          const min = s[Math.floor(s.length * 0.05)];
          const max = s[Math.min(s.length - 1, Math.floor(s.length * 0.9))];
          perLabelScale[l] = {
            min: Math.min(min, 0) - (max - min) * 0.1,
            max: max + (max - min) * 0.1
          };
          if (perLabelScale[l].max - perLabelScale[l].min < 1) { perLabelScale[l].min = perLabelScale[l].max - 1; }
        }
      }
      return perLabelScale[l];
    };
    // 以可见曲线中点数最多者为 x 基准
    let baseN = 1;
    shown.forEach(l => { if (series[l].length > baseN) { baseN = series[l].length; } });
    const xScale = (idx) => padL + (idx / Math.max(1, baseN - 1)) * (W - padL - padR);
    const yFor = (ms, sc) => padT + (ms == null ? 0 : Math.min(1, Math.max(0, (ms - sc.min) / (sc.max - sc.min)))) * (H - padT - padB);
    const svg = [];
    svg.push(`<svg class="nv-ping-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">`);
    // 背景网格（横线 0/25/50/75/100% + 纵线 4 等分）；纵轴为相对刻度（各曲线独立归一化）
    for (let i = 0; i <= 4; i++) {
      const gy = padT + (H - padT - padB) * (i / 4);
      svg.push(`<line x1="${padL}" y1="${gy.toFixed(1)}" x2="${W - padR}" y2="${gy.toFixed(1)}" class="nv-grid-line"/>`);
      svg.push(`<text x="${W - padR + 4}" y="${(gy + 3).toFixed(1)}" class="nv-grid-label" text-anchor="start">${100 - i * 25}%</text>`);
    }
    for (let i = 1; i <= 3; i++) {
      const gx = padL + (W - padL - padR) * (i / 4);
      svg.push(`<line x1="${gx.toFixed(1)}" y1="${padT}" x2="${gx.toFixed(1)}" y2="${H - padB}" class="nv-grid-line"/>`);
    }
    // 每条可见曲线（单色线 + 数据点 dot，每条按自身独立刻度归一化）
    shown.forEach((label, li) => {
      const pts = series[label];
      const color = palette[li % palette.length];
      const sc = scaleOf(label);
      // 曲线（线性，连接有效点；null 断线）
      let d = '';
      for (let i = 0; i < pts.length; i++) {
        if (pts[i].ms == null) { d = ''; continue; }
        const x = xScale(i), y = yFor(pts[i].ms, sc);
        d += (d === '' ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1) + ' ';
      }
      if (d) svg.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"/>`);
      // 数据点（dot）——数据点较密时降采样，避免视觉杂乱
      const step = Math.max(1, Math.ceil(pts.length / 400));
      for (let i = 0; i < pts.length; i += step) {
        const p = pts[i];
        if (p.ms == null) continue;
        const x = xScale(i), y = yFor(p.ms, sc);
        if (p.ok === false) {
          // 失败点红叉
          svg.push(`<g class="nv-fail"><line x1="${(x - 3).toFixed(1)}" y1="${(y - 3).toFixed(1)}" x2="${(x + 3).toFixed(1)}" y2="${(y + 3).toFixed(1)}"/><line x1="${(x - 3).toFixed(1)}" y1="${(y + 3).toFixed(1)}" x2="${(x + 3).toFixed(1)}" y2="${(y - 3).toFixed(1)}"/></g>`);
        } else {
          // 数据点小圆（Recharts dot:true）
          svg.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.5" fill="${color}" stroke="none"/>`);
        }
      }
    });
    // 横轴时间刻度（起止时间）
    if (shown.length) {
      const allTs = [];
      shown.forEach(l => series[l].forEach(p => { if (p.ts) allTs.push(p.ts); }));
      if (allTs.length) {
        const t0 = Math.min.apply(null, allTs), t1 = Math.max.apply(null, allTs);
        const fmtAxis = (t) => { try { const d = new Date(t); return (d.getMonth() + 1) + '-' + d.getDate() + ' ' + d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0'); } catch (_) { return ''; } };
        svg.push(`<text x="${padL}" y="${H - 6}" class="nv-grid-label" text-anchor="start">${esc(fmtAxis(t0))}</text>`);
        svg.push(`<text x="${W - padR}" y="${H - 6}" class="nv-grid-label" text-anchor="end">${esc(fmtAxis(t1))}</text>`);
      }
    }
    svg.push('</svg>');
    // 图例：探测点 + 平均延迟 + 颜色，点击可切换曲线显示/隐藏
    const legend = labels.map((l, i) => {
      const off = hiddenSet.has(l);
      const pts = series[l];
      const vals = pts.filter(p => p.ms != null).map(p => p.ms);
      const avg = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
      const style = off ? '' : `style="background:${palette[i % palette.length]}"`;
      return `<span class="nv-legend-item${off ? ' off' : ''}" data-key="${esc(l)}"><span class="nv-legend-dot" ${style}></span>${esc(probeShort(l))}${avg != null ? ' <b>' + avg + 'ms</b>' : ''}</span>`;
    }).join('');
    // tooltip 浮层（鼠标 hover 显示交叉点信息，Recharts 风格）
    currentChartCfg = { W, H, padL, padR, padT, padB, baseN, shown, series, palette, perLabelScale };
    return `<div class="nv-ping-wrap">
      ${svg.join('')}
      <div class="nv-tip" id="nvTip" hidden></div>
      <div class="nv-legend">${legend}</div>
    </div>`;
  }
  function probeShort(l) { return { '联通': 'cu', '电信': 'ct', '移动': 'cm', '公共': 'GG' }[l] || l.slice(0, 6); }
  function probeHtml(probes) {
    if (!probes || !Object.keys(probes).length) return '<span class="muted">—</span>';
    return Object.keys(probes).map(k => {
      const v = probes[k] || {};
      const ms = v.ms, ok = v.ok;
      const cls = !ok ? 'probe-bad' : (ms == null ? 'probe-na' : ms <= 50 ? 'probe-ok' : ms <= 200 ? 'probe-mid' : ms <= 1000 ? 'probe-warn' : 'probe-bad');
      const label = { '联通': 'cu', '电信': 'ct', '移动': 'cm', '公共': 'GG' }[k] || k.slice(0, 2);
      const txt = ok ? (ms == null ? '—' : Math.round(ms) + 'ms') : '✕';
      return `<span class="nv-probe ${cls}" title="${esc(k)}">${esc(label)} ${txt}</span>`;
    }).join('');
  }

  function statusOf(a) {
    // 公开页仅给当前 cpu 时间戳近似在线；用 online 字段
    return a.online ? 'online' : 'offline';
  }

  function render(agent, history, probeSeries) {
    const flag = (agent.country && flagImg(agent.country)) ? `<span class="flag">${flagImg(agent.country)}</span>` : '';
    const country = agent.country ? `<span class="nv-meta">${flag}${esc(countryName(agent.country))}</span>` : '';
    const grp = agent.group ? `<span class="nv-meta"><span class="badge">${esc(agent.group)}</span></span>` : '';
    const merchant = agent.merchant ? `<span class="nv-meta"><span class="badge">${esc(agent.merchant)}</span></span>` : '';
    const st = statusOf(agent);

    // 历史序列
    const cpu = history.map(h => Number(h.cpu) || 0);
    const mem = history.map(h => Number(h.mem_pct) || 0);
    const netRx = history.map(h => Number(h.net_rx_rate) || 0);
    const netTx = history.map(h => Number(h.net_tx_rate) || 0);
    const load = history.map(h => Number(h.load1) || 0);
    const diskIO = history.map(h => (Number(h.disk_r_rate) || 0) + (Number(h.disk_w_rate) || 0));
    const temp = history.map(h => Number(h.temp) || 0);

    const disks = (agent.disks && agent.disks.length)
      ? agent.disks.map(d => `<div class="nv-disk-row">
          <div class="nv-disk-head"><span class="nv-disk-mount">${esc(d.mount)}</span><span class="nv-disk-val">${fmtBytes(d.used)} / ${fmtBytes(d.total)} (${fmtPct(d.pct)})</span></div>
          ${bar(d.pct)}
        </div>`).join('')
      : '<div class="muted">无磁盘数据</div>';

    const quota = Number(agent.monthly_quota_gb) > 0;
    const tqUsed = Number(agent.net_rx_month) + Number(agent.net_tx_month);
    const quotaBytes = Number(agent.monthly_quota_gb) * 1e9;

    const probes = parseProbes(agent.probes);

    $('nvMain').innerHTML = `
      <section class="nv-hero">
        <div class="nv-hero-main">
          <div class="nv-status ${st}"></div>
          <h1 class="nv-name">${esc(agent.name)}</h1>
          <div class="nv-hero-meta">${country}${grp}${merchant}</div>
        </div>
        <div class="nv-hero-side">
          <div class="nv-hero-stat"><span class="nv-hs-val">${fmtPct(agent.cpu)}</span><span class="nv-hs-label" data-i18n="node.cpu">CPU</span></div>
          <div class="nv-hero-stat"><span class="nv-hs-val">${fmtPct(agent.mem_pct)}</span><span class="nv-hs-label" data-i18n="node.mem">内存</span></div>
          <div class="nv-hero-stat"><span class="nv-hs-val">${fmtPct(agent.disk_pct)}</span><span class="nv-hs-label" data-i18n="node.disk">磁盘</span></div>
        </div>
      </section>

      <section class="nv-grid">
        <div class="nv-card">
          <div class="nv-card-title"><span data-i18n="node.cpu_load">CPU 负载</span><span class="nv-card-now">${fmtPct(agent.cpu)}</span></div>
          ${sparkline(cpu, 100, 'var(--accent)')}
        </div>
        <div class="nv-card">
          <div class="nv-card-title"><span data-i18n="node.memory">内存</span><span class="nv-card-now">${fmtPct(agent.mem_pct)}</span></div>
          ${sparkline(mem, 100, 'var(--accent2)')}
        </div>
        <div class="nv-card">
          <div class="nv-card-title"><span data-i18n="node.net_down">下行</span><span class="nv-card-now">${fmtRate(agent.net_rx_rate)}</span></div>
          ${sparkline(netRx, Math.max.apply(null, netRx.concat([1])), '#4ade80')}
        </div>
        <div class="nv-card">
          <div class="nv-card-title"><span data-i18n="node.net_up">上行</span><span class="nv-card-now">${fmtRate(agent.net_tx_rate)}</span></div>
          ${sparkline(netTx, Math.max.apply(null, netTx.concat([1])), '#f59e0b')}
        </div>
        <div class="nv-card">
          <div class="nv-card-title"><span data-i18n="node.load1">Load 1</span><span class="nv-card-now">${Number(agent.load1 || 0).toFixed(2)}</span></div>
          ${sparkline(load, Math.max.apply(null, load.concat([1])), '#60a5fa')}
        </div>
        <div class="nv-card">
          <div class="nv-card-title"><span data-i18n="node.disk_io">磁盘 IO</span><span class="nv-card-now">${fmtRate(diskIO[diskIO.length - 1] || 0)}</span></div>
          ${sparkline(diskIO, Math.max.apply(null, diskIO.concat([1])), '#a78bfa')}
        </div>
        <div class="nv-card">
          <div class="nv-card-title"><span data-i18n="node.temp">温度</span><span class="nv-card-now">${agent.temp ? Number(agent.temp).toFixed(0) + '°C' : '—'}</span></div>
          ${sparkline(temp, Math.max.apply(null, temp.concat([1])), '#f87171')}
        </div>
        <div class="nv-card">
          <div class="nv-card-title"><span data-i18n="node.swap">Swap</span><span class="nv-card-now">${fmtPct(agent.swap_pct)}</span></div>
          ${sparkline(history.map(h => Number(h.swap_pct) || 0), 100, '#fb7185')}
        </div>
      </section>

      <section class="nv-cols">
        <div class="nv-col">
          <h2 class="nv-section" data-i18n="node.disks">磁盘分区</h2>
          <div class="nv-disks">${disks}</div>
          <h2 class="nv-section" data-i18n="node.traffic">网络流量</h2>
          <div class="nv-traffic">
            <div class="nv-disk-row"><div class="nv-disk-head"><span class="nv-disk-mount" data-i18n="node.month_down">本月下行</span><span class="nv-disk-val">${fmtBytes(agent.net_rx_month)}</span></div></div>
            <div class="nv-disk-row"><div class="nv-disk-head"><span class="nv-disk-mount" data-i18n="node.month_up">本月上行</span><span class="nv-disk-val">${fmtBytes(agent.net_tx_month)}</span></div></div>
            <div class="nv-disk-row"><div class="nv-disk-head"><span class="nv-disk-mount" data-i18n="node.month_total">本月合计</span><span class="nv-disk-val">${fmtBytes(tqUsed)}</span></div></div>
            ${quota ? `<div class="nv-disk-row"><div class="nv-disk-head"><span class="nv-disk-mount" data-i18n="node.quota">配额用量</span><span class="nv-disk-val">${fmtPct(tqUsed / quotaBytes * 100)}</span></div>${bar(tqUsed / quotaBytes * 100)}</div>` : `<div class="nv-disk-row"><div class="nv-disk-head"><span class="nv-disk-mount" data-i18n="node.quota">配额</span><span class="nv-disk-val">∞</span></div></div>`}
          </div>
        </div>
        <div class="nv-col">
          <h2 class="nv-section" data-i18n="node.sysinfo">系统信息</h2>
          <div class="nv-sys">
            <div class="nv-sys-row"><span class="nv-sys-key" data-i18n="node.os">系统</span><span class="nv-sys-val">${esc(agent.os || '—')}</span></div>
            <div class="nv-sys-row"><span class="nv-sys-key" data-i18n="node.hostname">主机名</span><span class="nv-sys-val">${esc(agent.hostname || '—')}</span></div>
            <div class="nv-sys-row"><span class="nv-sys-key" data-i18n="node.mem_total">内存</span><span class="nv-sys-val">${agent.mem_total ? fmtBytes(agent.mem_total) : '—'}</span></div>
            <div class="nv-sys-row"><span class="nv-sys-key" data-i18n="node.disk_total">磁盘</span><span class="nv-sys-val">${agent.disk_total ? fmtBytes(agent.disk_total) : '—'}</span></div>
            <div class="nv-sys-row"><span class="nv-sys-key" data-i18n="node.conns">连接数</span><span class="nv-sys-val"><span class="nv-cap" title="diting 刻意不采集连接数，保持零入侵">未采集</span></span></div>
            <div class="nv-sys-row"><span class="nv-sys-key" data-i18n="node.procs">进程数</span><span class="nv-sys-val"><span class="nv-cap" title="diting 刻意不采集进程数，保持零入侵">未采集</span></span></div>
            <div class="nv-sys-row"><span class="nv-sys-key" data-i18n="node.uptime">运行时长</span><span class="nv-sys-val">${fmtUptime(agent.uptime)}</span></div>
            ${(agent.price > 0 || agent.price === -1) ? `<div class="nv-sys-row"><span class="nv-sys-key" data-i18n="node.plan">套餐</span><span class="nv-sys-val">${esc(planLabel(agent.price, agent.billing_cycle, agent.currency))}</span></div>` : ''}
            <div class="nv-sys-row"><span class="nv-sys-key" data-i18n="node.expire">到期</span><span class="nv-sys-val">${fmtDate(agent.expire_at)} ${valueHtml(agent.expire_at)}</span></div>
            <div class="nv-sys-row"><span class="nv-sys-key" data-i18n="node.note">备注</span><span class="nv-sys-val">${esc(agent.note || '—')}</span></div>
          </div>
          <h2 class="nv-section" data-i18n="node.probes">探测点</h2>
          <div class="nv-probes">${probeHtml(probes)}</div>
        </div>
      </section>

      <section class="nv-col">
        <h2 class="nv-section" data-i18n="node.ping_analysis">Ping 延迟分析</h2>
        <div class="nv-bar-group">
          <div class="nv-range-bar" id="nvRangeBar">
            <span class="nv-range-btn active" data-range="1h">时</span>
            <span class="nv-range-btn" data-range="24h">日</span>
            <span class="nv-range-btn" data-range="7d">周</span>
            <span class="nv-range-btn" data-range="30d">月</span>
          </div>
          <div class="nv-agg-bar" id="nvAggBar">
            <span class="nv-agg-btn active" data-mode="raw">原始</span>
            <span class="nv-agg-btn" data-mode="avg">平均</span>
            <span class="nv-agg-btn" data-mode="p95">P95</span>
          </div>
        </div>
        <div class="nv-ping" id="nvPingWrap">${multiLine(probeSeries || {}, hiddenProbes)}</div>
      </section>
    `;
    if (window.I18N) I18N.applyDOM();
  }

  function parseProbes(s) {
    if (!s) return {};
    try { const o = JSON.parse(s); return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {}; } catch (e) { return {}; }
  }

  let currentId = null;
  let currentProbeRange = '1h'; // 默认"时"（对齐 Glassmorphism 默认一小时曲线）
  let currentProbeKeys = []; // 当前实际探测的探针标签白名单（用于过滤旧目标历史）
  let hiddenProbes = new Set(); // 图例点击隐藏的探测点（可选展示，对齐 Glassmorphism）
  let currentProbeSeries = {}; // 当前加载的探针历史（图例切换时重渲染用）
  let currentChartCfg = null; // 当前图表坐标配置（tooltip 交叉点换算用）
  let currentProbeAgg = 'raw'; // 聚合模式：raw原始 / avg移动平均 / p95分位（对齐 Komari 延迟聚合）

  async function load() {
    const id = new URLSearchParams(location.search).get('id');
    if (!id) { $('nvMain').innerHTML = '<div class="nv-loading">缺少节点 ID</div>'; return; }
    currentId = id;
    try {
      const [meta, list, sp, probes] = await Promise.all([
        fetch('/api/public/meta', { cache: 'no-store' }).then(r => r.ok ? r.json() : {}),
        fetch('/api/public/agents', { cache: 'no-store' }).then(r => r.ok ? r.json() : []),
        fetch('/api/public/agents/sparklines?id=' + encodeURIComponent(id) + '&range=' + currentProbeRange, { cache: 'no-store' }).then(r => r.ok ? r.json() : {}),
        fetch('/api/public/agents/' + encodeURIComponent(id) + '/probes?range=' + currentProbeRange, { cache: 'no-store' }).then(r => r.ok ? r.json() : {})
      ]);
      if (meta.site_title) { $('nvSiteTitle').textContent = meta.site_title; document.title = '节点详情 — ' + meta.site_title; }
      // 页脚：与 index.html 公开页一致（Powered by DiTing + 社交链接）
      if ($('nvFooter')) {
        var socialHtml = '';
        var socialItems = [
          { key: 'social_email', icon: '&#9993;', prefix: 'mailto:', label: '邮箱' },
          { key: 'social_telegram', icon: '&#9992;', prefix: 'https://t.me/', label: 'Telegram' },
          { key: 'social_qq', icon: '&#9993;', prefix: 'https://wpa.qq.com/msgrd?v=3&uin=', label: 'QQ' },
          { key: 'social_website', icon: '&#127760;', prefix: '', label: '网站' }
        ];
        socialItems.forEach(function(item) {
          if (meta[item.key]) {
            var raw = meta[item.key].trim();
            var val = item.key === 'social_website' ? raw : encodeURIComponent(raw);
            socialHtml += ' <a href="' + item.prefix + val + '" target="_blank" rel="noopener" title="' + item.label + '" style="color:inherit;text-decoration:none;font-size:14px">' + item.icon + '</a>';
          }
        });
        $('nvFooter').innerHTML = 'Powered by <a href="https://github.com/fengzone85/diting" target="_blank" rel="noopener">DiTing</a><span style="float:right">' + socialHtml + '</span>';
      }
      // 后台入口链接统一走「项目网址」（与公开页一致）
      const $na = $('nvAdmin');
      if ($na) {
        const su = (meta && meta.site_url || '').trim();
        $na.href = su ? (su.replace(/\/+$/, '') + '/admin.html') : '/admin.html';
      }
      const agent = (Array.isArray(list) ? list : []).find(a => a.id === id);
      if (!agent) { $('nvMain').innerHTML = '<div class="nv-loading">未找到该节点</div>'; return; }
      const history = (sp && sp[id]) || [];
      try { currentProbeKeys = Object.keys(JSON.parse(agent.probes || '{}')); } catch (_) { currentProbeKeys = []; }
      currentProbeSeries = filterCurrentProbes(probes);
      render(agent, history, aggregateSeries(currentProbeSeries, currentProbeAgg));
      // 同步日/周/月切换栏激活态
      document.querySelectorAll('.nv-range-btn').forEach(b => b.classList.toggle('active', b.getAttribute('data-range') === currentProbeRange));
    } catch (e) {
      $('nvMain').innerHTML = '<div class="nv-loading">加载失败：' + esc(e.message) + '</div>';
    }
  }

  // 时间范围切换（日/周/月）：重拉探针历史 + 曲线，更新按钮态
  async function switchProbeRange(range) {
    if (range === currentProbeRange || !currentId) return;
    currentProbeRange = range;
    document.querySelectorAll('.nv-range-btn').forEach(b => b.classList.toggle('active', b.getAttribute('data-range') === range));
    // 仅重拉探针历史并局部更新 Ping 区块
    try {
      const probes = await fetch('/api/public/agents/' + encodeURIComponent(currentId) + '/probes?range=' + range, { cache: 'no-store' }).then(r => r.ok ? r.json() : {});
      currentProbeSeries = filterCurrentProbes(probes);
      const box = $('nvPingWrap');
      if (box) box.innerHTML = multiLine(aggregateSeries(currentProbeSeries, currentProbeAgg), hiddenProbes);
    } catch (_) {}
  }

  // 聚合模式切换（原始/平均/P95，对齐 Komari 延迟聚合）：仅重渲染 Ping 区块
  function switchProbeAgg(mode) {
    if (mode === currentProbeAgg) return;
    currentProbeAgg = mode;
    document.querySelectorAll('.nv-agg-btn').forEach(b => b.classList.toggle('active', b.getAttribute('data-mode') === mode));
    const box = $('nvPingWrap');
    if (box) box.innerHTML = multiLine(aggregateSeries(currentProbeSeries, mode), hiddenProbes);
  }

  // 主题切换（与 index.html 公开页一致）
  function nvCurrentTheme() {
    const t = localStorage.getItem('theme');
    if (t === 'light' || t === 'dark') return t;
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  }
  function nvSyncIcon() {
    const btn = $('nvTheme');
    if (!btn) return;
    btn.textContent = nvCurrentTheme() === 'dark' ? '🌙' : '☀️';
    btn.title = nvCurrentTheme() === 'dark' ? '切换到亮色' : '切换到暗色';
  }
  function nvToggleTheme() {
    const next = nvCurrentTheme() === 'dark' ? 'light' : 'dark';
    localStorage.setItem('theme', next);
    document.documentElement.setAttribute('data-theme', next);
    nvSyncIcon();
  }
  function nvApplyTheme(t) {
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
  }
  nvApplyTheme(localStorage.getItem('theme') || 'auto');
  nvSyncIcon();

  if (window.I18N) I18N.ready(load); else window.addEventListener('DOMContentLoaded', load);
  // 每 15 秒刷新实时数据
  setInterval(() => { if (location.pathname.endsWith('node.html')) load(); }, 15000);

  // 主题切换 + 范围切换 + 图例点击（事件委托，符合严格 CSP 无内联）
  document.addEventListener('click', (e) => {
    const tb = e.target.closest && e.target.closest('#nvTheme');
    if (tb) return nvToggleTheme();
    const btn = e.target.closest && e.target.closest('#nvRangeBar .nv-range-btn');
    if (btn) return switchProbeRange(btn.getAttribute('data-range'));
    const aggBtn = e.target.closest && e.target.closest('#nvAggBar .nv-agg-btn');
    if (aggBtn) return switchProbeAgg(aggBtn.getAttribute('data-mode'));
    const legendItem = e.target.closest && e.target.closest('.nv-legend-item[data-key]');
    if (legendItem) {
      const key = legendItem.getAttribute('data-key');
      if (hiddenProbes.has(key)) hiddenProbes.delete(key); else hiddenProbes.add(key);
      const box = $('nvPingWrap');
      if (box) box.innerHTML = multiLine(currentProbeSeries, hiddenProbes);
      // 重渲染后移除旧准星元素
      const old = box.querySelector('.nv-crosshair');
      if (old) old.remove();
    }
  });

  // 十字准星 + tooltip 交叉点信息（完全对齐 Glassmorphism/Recharts hover 交互）
  document.addEventListener('mousemove', (e) => {
    const chart = e.target.closest && e.target.closest('#nvPingWrap .nv-ping-chart');
    const tip = $('nvTip');
    if (!chart || !tip || !currentChartCfg) return;
    const cfg = currentChartCfg;
    const rect = chart.getBoundingClientRect();
    const viewX = (e.clientX - rect.left) * (cfg.W / Math.max(1, rect.width));
    // 找最近 x 索引（基于 baseN）
    const idx = Math.max(0, Math.min(cfg.baseN - 1, Math.round((viewX - cfg.padL) / Math.max(1, cfg.W - cfg.padL - cfg.padR) * (cfg.baseN - 1))));
    const px = cfg.padL + (idx / Math.max(1, cfg.baseN - 1)) * (cfg.W - cfg.padL - cfg.padR);
    // 画垂直准星线
    let cross = chart.parentNode.querySelector('.nv-crosshair');
    if (!cross) {
      const NS = 'http://www.w3.org/2000/svg';
      cross = document.createElementNS(NS, 'line');
      cross.setAttribute('class', 'nv-crosshair');
      cross.setAttribute('y1', cfg.padT);
      cross.setAttribute('y2', cfg.H - cfg.padB);
      chart.appendChild(cross);
    }
    cross.setAttribute('x1', px.toFixed(1));
    cross.setAttribute('x2', px.toFixed(1));
    cross.setAttribute('stroke', '#888');
    cross.setAttribute('stroke-width', '1');
    cross.setAttribute('stroke-dasharray', '3 3');
    // 清除旧的 activeDot，画新的（hover 高亮当前点，对齐 Recharts activeDot）
    chart.parentNode.querySelectorAll('.nv-activedot').forEach((n) => n.remove());
    const NS = 'http://www.w3.org/2000/svg';
    const palette = cfg.palette || ['#4ade80', '#60a5fa', '#f59e0b', '#a78bfa', '#f87171', '#2dd4bf', '#fb7185', '#34d399'];
    // 按 cfg 坐标换算（与 multiLine 一致，每条曲线独立刻度）
    const xScaleCfg = (i) => cfg.padL + (i / Math.max(1, cfg.baseN - 1)) * (cfg.W - cfg.padL - cfg.padR);
    const yForCfg = (ms, sc) => cfg.padT + (ms == null ? 0 : Math.min(1, Math.max(0, (ms - sc.min) / (sc.max - sc.min)))) * (cfg.H - cfg.padT - cfg.padB);
    cfg.shown.forEach((l) => {
      const pts = cfg.series[l];
      const p = pts[idx] || (pts.length ? pts[Math.min(idx, pts.length - 1)] : null);
      if (!p || p.ms == null) return;
      const color = palette[cfg.shown.indexOf(l) % palette.length];
      const sc = cfg.perLabelScale && cfg.perLabelScale[l];
      const x = xScaleCfg(idx), y = sc ? yForCfg(p.ms, sc) : cfg.padT;
      const dot = document.createElementNS(NS, 'circle');
      dot.setAttribute('class', 'nv-activedot');
      dot.setAttribute('cx', x.toFixed(1));
      dot.setAttribute('cy', y.toFixed(1));
      dot.setAttribute('r', '4');
      dot.setAttribute('fill', color);
      dot.setAttribute('stroke', 'var(--card,#fff)');
      dot.setAttribute('stroke-width', '1.5');
      chart.appendChild(dot);
    });
    // 组装 tooltip：时间 + 各曲线在该 x 的延迟值
    const t = cfg.series && cfg.shown.length ? (cfg.series[cfg.shown[0]][idx] && cfg.series[cfg.shown[0]][idx].ts) : null;
    const tStr = t ? fmtTime(t) : '';
    let html = `<div class="nv-tip-time">${esc(tStr)}</div>`;
    cfg.shown.forEach((l) => {
      const pts = cfg.series[l];
      const p = pts[idx] || (pts.length ? pts[Math.min(idx, pts.length - 1)] : null);
      const color = palette[cfg.shown.indexOf(l) % palette.length];
      const val = p && p.ms != null ? p.ms + 'ms' : (p && p.ok === false ? '失败' : '—');
      html += `<div class="nv-tip-row"><span class="nv-tip-dot" style="background:${color}"></span>${esc(probeShort(l))} <b>: ${esc(val)}</b></div>`;
    });
    tip.innerHTML = html;
    tip.hidden = false;
    // 浮层跟随鼠标（限制在图表范围内）
    tip.style.left = (e.clientX - rect.left + 14) + 'px';
    tip.style.top = '8px';
  });

  // 鼠标离开图表隐藏 tooltip
  document.addEventListener('mouseleave', () => { const tip = $('nvTip'); if (tip) tip.hidden = true; });
  document.addEventListener('mousemove', (e) => {
    if (!(e.target.closest && e.target.closest('#nvPingWrap .nv-ping-chart'))) {
      const tip = $('nvTip'); if (tip) tip.hidden = true;
    }
  });
})();
