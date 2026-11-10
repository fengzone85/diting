<script setup lang="ts">
import { onMounted, onUnmounted, computed, ref, markRaw, watch } from 'vue';
import { useRoute, useRouter, RouterLink } from 'vue-router';
import AppHeader from '../components/AppHeader.vue';
import ChartLatency from '../components/ChartLatency.vue';
import ChartLatencyMulti from '../components/ChartLatencyMulti.vue';
import ChartLatencyDual from '../components/ChartLatencyDual.vue';
import Loading from '../components/ui/Loading.vue';
import EmptyState from '../components/ui/EmptyState.vue';
import ErrorMessage from '../components/ui/ErrorMessage.vue';
import AiNodeAnalysisDialog from '../components/ai/AiNodeAnalysisDialog.vue';
import { publicApi } from '../services/publicApi';
import { useApp } from '../composables/useApp';
import { t } from '../composables/useI18n';
import type { Probes, ProbeAvailability, OnlineHistory, ChartPoint, SparklinePoint } from '../services/types';
import { formatBytes, formatBitsPerSecond, formatDuration, formatPercent, formatNumber, formatCurrency, formatRemaining } from '../utils/format';
import {
  Cpu,
  Computer,
  Code,
  Timer,
  Server,
  Memory,
  Switch,
  HardDisk,
  TransferData,
  DashboardOne,
  ApplicationTwo,
  VideoOne,
  Ticket,
  ShoppingBag,
  Time,
  Wallet,
  Star,
  ArrowLeft,
  ArrowRight,
} from '@icon-park/vue-next';

function formatDate(s: string | undefined): string {
  if (!s) return '—';
  return s;
}

const route = useRoute();
const router = useRouter();
const { state, visibleAgents, isFavoriteNode, toggleFavoriteNode } = useApp();
const agentId = computed(() => route.params.id as string);
// 对齐 Komari：切 range 打后端，后端按 max_points 降采样返回（避免短 range 从 30d 全量截取导致点过稀）
const probes = ref<Probes>({});
// F4：可用率/证书元信息（与 probes 同一次请求返回，窗口 = currentRange）
const availability = ref<Record<string, ProbeAvailability>>({});
// F7：30 天在线时段（daily 热力条 + 最近停机）
const online = ref<OnlineHistory | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

// AI 单节点分析（§8 T15）：按钮对访客可见，但弹窗内先探测登录态——
// 未登录只提示「需要管理员登录」并发「去登录」，不发请求（不消耗限流配额）；
// 接口本身是 adminOnly，匿名请求即便发出也会被服务端拦下（不触发模型调用、零费用）。
const showAiDialog = ref(false);

// 本节点时序历史（CPU/内存/磁盘 IO/负载/温度/swap 六图）。
// 刻意【不复用 useApp 的全局 state.sparklines】：首页 full 模板会按 5s 轮询刷新该全局对象，
// 且 template!=='full' 时会被置为 {}，把详情页补拉的数据清空 → 六张图全空白。
// 详情页数据生命周期与首页不同，故用组件内独立 ref 彻底解耦。
const sparkRows = ref<SparklinePoint[]>([]);
// 磁盘耗尽预测专用：固定 30d。切 range 时图表数据会变，但 ETA 必须基于 30d 长窗口，
// 否则短窗口噪声会让「剩余天数」剧烈抖动，故与图表数据分开维护。
const sparkRows30d = ref<SparklinePoint[]>([]);

// 网络质量（延迟）图范围：对齐 Glassmorphism PingChart 的 1h/6h/12h/1d/7d + 自定义
const RANGES = ['1h', '6h', '12h', '24h', '7d'];
const currentRange = ref('1h');
// 上方六图（CPU/内存/磁盘IO/负载/温度/swap）范围：对齐 Glassmorphism LoadChart
// 的 实时/4h/1d/7d/30d + 自定义。磁盘耗尽预测不走这里，固定用 sparkRows30d。
const CHART_RANGES = ['realtime', '4h', '24h', '7d', '30d'];
const chartRange = ref('realtime');
// 每段 range 各自的降采样点数（对齐 Komari：短 range 也保持点数合适，不互相挤占）
const RANGE_MAX_POINTS: Record<string, number> = { '1h': 600, '4h': 800, '6h': 1000, '12h': 1200, '24h': 1500, '7d': 2000, '30d': 3000 };

// 实时模式：先用 1h 历史垫底，再每 10s 把 agent 快照追加到滚动窗口（保留 60 点）。
const rtRows = ref<SparklinePoint[]>([]);
let rtTimer: ReturnType<typeof setInterval> | null = null;

// 自定义时间窗（浮层）
const customOpen = ref(false);
const customTarget = ref<'chart' | 'probes'>('chart');
const customStart = ref('');
const customEnd = ref('');
const customChart = ref<{ start: string; end: string } | null>(null);
const customProbes = ref<{ start: string; end: string } | null>(null);
// 组件存活标志：startRealtime 的 await 期间可能已卸载/切换节点，防止卸载后仍启动定时器。
let alive = true;

const agent = computed(() => state.agents.find(a => a.id === agentId.value));

// 网络卡背景进度层宽度：月流量已用 / 配额占用率
const netUsagePct = computed(() => {
  const a = agent.value;
  if (!a || a.monthly_quota_gb == null || a.monthly_quota_gb <= 0) return 0;
  const used = (a.net_rx_month || 0) + (a.net_tx_month || 0);
  const quota = a.monthly_quota_gb * 1024 ** 3;
  return Math.min((used / quota) * 100, 100);
});

// 顶部计费卡片：节点价格 / 月均支出 / 剩余时间 / 剩余价值（对齐 Komari 顶部统计卡）
const billingCards = computed(() => {
  const a = agent.value;
  if (!a) return [];
  const price = typeof a.price === 'number' ? a.price : null;
  const cycle = typeof a.billing_cycle === 'number' && a.billing_cycle > 0 ? a.billing_cycle : null;
  const currency = a.currency || '¥';
  const monthly = price != null && cycle != null ? price / cycle : null;
  const rem = formatRemaining(a.expire_at);
  // 剩余价值：优先用服务端计算结果（server/src/billing.js，Komari 口径
  // = 价格 × 剩余天数 ÷ 计费周期天数，UTC 整日）；接口未返回时回退本地折算。
  let remainingValue: number | null = null;
  if (typeof a.remaining_value === 'number') {
    remainingValue = a.remaining_value;
  } else if (monthly != null && a.expire_at) {
    const exp = new Date(a.expire_at).getTime();
    if (!Number.isNaN(exp)) {
      const months = (exp - Date.now()) / (86400000 * 30);
      if (months > 0) remainingValue = monthly * months;
    }
  }
  return [
    {
      key: 'nodePrice',
      label: t('node.billing.nodePrice'),
      icon: markRaw(Ticket),
      value: price != null ? formatCurrency(price, currency) : '—',
      status: 'normal' as const,
    },
    {
      key: 'monthlyCost',
      label: t('node.billing.monthlyCost'),
      icon: markRaw(ShoppingBag),
      value: a.billing_status === 'free'
        ? t('public.free')
        : (typeof a.monthly_cost === 'number'
            ? `${formatCurrency(a.monthly_cost, currency)} / 月`
            : (monthly != null ? `${formatCurrency(monthly, currency)} / 月` : '—')),
      status: 'normal' as const,
    },
    {
      key: 'remainingTime',
      label: t('node.billing.remainingTime'),
      icon: markRaw(Time),
      value: rem.text,
      status: rem.status,
    },
    {
      key: 'remainingValue',
      label: t('node.billing.remainingValue'),
      icon: markRaw(Wallet),
      value: a.billing_status === 'free'
        ? t('public.free')
        : (remainingValue != null ? formatCurrency(remainingValue, currency) : '—'),
      status: 'normal' as const,
    },
  ];
});

// 剩余时间状态对应的文字颜色（对齐 Komari：过期/紧急红、警告橙、长期灰、正常绿）
const remainingStatusClass: Record<string, string> = {
  expired: 'text-rose-400',
  critical: 'text-rose-400',
  warning: 'text-orange-400',
  long_term: 'text-muted-foreground',
  normal: 'text-emerald-400',
};

// 硬件卡动态条目：架构/虚拟化/GPU（无字段则显示 -；不对指纹字段扩展采集）。
// 核心数已并入上方 CPU 型号行，不再单独占一项。
const hwDynamic = computed(() => {
  const a = agent.value;
  if (!a) return [];
  const items: { label: string; value: string; icon: any }[] = [];
  // 核心数不再单独占一项：并入 CPU 型号行（`型号 (N vCPU)`），与 Glassmorphism 对齐。
  // 架构（管理员手填优先；未填时服务端按受控端构建平台派生）
  items.push({ label: t('node.arch'), value: (a as any).arch || '—', icon: ApplicationTwo });
  // 虚拟化（管理员手填）
  items.push({ label: t('node.virtualization'), value: (a as any).virtualization || '—', icon: Server });
  // GPU（仅当管理员填写时渲染；空 / 'None' = 无或不公开）
  const gpu = String((a as any).gpu_name || '').trim();
  if (gpu && gpu.toLowerCase() !== 'none') {
    items.push({ label: t('node.gpu'), value: gpu, icon: VideoOne });
  }
  return items;
});

// 多物理硬盘聚合：所有盘 used/total 求和，pct 取加权平均
const diskAgg = computed(() => {
  const a = agent.value;
  if (!a) return { used: 0, total: 0, pct: 0 };
  const list = Array.isArray(a.disks) ? a.disks : [];
  let used = 0, total = 0, pct = 0;
  if (list.length > 0) {
    for (const d of list) {
      used += Number(d.used) || 0;
      total += Number(d.total) || 0;
    }
    pct = total > 0 ? (used / total) * 100 : 0;
  } else {
    used = a.disk_used || 0;
    total = a.disk_total || 0;
    pct = a.disk_pct || (total > 0 ? (used / total) * 100 : 0);
  }
  // 离线回退：agent 实时接口对离线节点不返回 disks/disk_total（实测均为 0/空数组），
  // 会导致 diskPredict 因 total=0 返回 null、磁盘卡片正文整块消失。
  // 历史时序每行都带 disk_total/disk_used，这里取最后一个有效采样点补上，
  // 使离线节点仍能显示其最后已知容量与耗尽预测。
  if (!total) {
    const src = sparkRows30d.value.length ? sparkRows30d.value : sparkRows.value;
    for (let i = src.length - 1; i >= 0; i--) {
      const r = src[i];
      if (r && Number(r.disk_total) > 0) {
        total = Number(r.disk_total) || 0;
        used = Number(r.disk_used) || 0;
        break;
      }
    }
    pct = total > 0 ? (used / total) * 100 : 0;
  }
  return { used, total, pct };
});

// 节点切换：按首页同一顺序（visibleAgents）取上一个/下一个，下拉列全部节点。
// 对齐 Glassmorphism 顶栏下方的「← / 节点下拉 / →」控件。
const nodeList = computed(() => (visibleAgents.value.length ? visibleAgents.value : state.agents));
const currentIndex = computed(() => nodeList.value.findIndex((a) => a.id === agentId.value));
const prevNode = computed(() => (currentIndex.value > 0 ? nodeList.value[currentIndex.value - 1] : null));
const nextNode = computed(() => (
  currentIndex.value >= 0 && currentIndex.value < nodeList.value.length - 1
    ? nodeList.value[currentIndex.value + 1]
    : null
));
const favorite = computed(() => isFavoriteNode(agentId.value));
function goNode(id: string) {
  if (id && id !== agentId.value) router.push(`/node/${id}`);
}

const sparkline = computed(() => (chartRange.value === 'realtime' ? rtRows.value : sparkRows.value));
const cpuSeries = computed<ChartPoint[]>(() => sparkline.value.map(d => ({ t: d.ts, v: d.cpu ?? d.cpu_percent ?? 0 })));
const memSeries = computed<ChartPoint[]>(() => sparkline.value.map(d => ({ t: d.ts, v: d.mem_pct ?? 0 })));
const loadSeries = computed<ChartPoint[]>(() => sparkline.value.map(d => ({ t: d.ts, v: d.load1 ?? 0 })));
// Windows 无 Unix load（load1 恒 0，图上是一条贴底直线 = "没显示"）：
// 该图对 Windows 节点改画进程总数曲线（与卡片进程胶囊同口径）。
// 过滤无值点：process_count 从 2026-10-12 才开始采集，窗口内更早的点为 null，
// 映射成 0 会画出一段伪造的贴底直线——曲线应从最早有值点开始。
const isWindows = computed(() => (agent.value?.os || '').toLowerCase().includes('windows'));
const processSeries = computed<ChartPoint[]>(() =>
  sparkline.value
    .filter(d => d.process_count != null)
    .map(d => ({ t: d.ts, v: d.process_count as number }))
);

// —— 图表卡右上角当前值（对齐 Komari「标题 + 当前值」卡片风格）——
// 数据取实时 agent（与首页卡片同源）；agent 未加载/字段缺失返回 undefined → 不渲染。
const cpuCurrent = computed(() => (agent.value ? formatPercent(agent.value.cpu ?? agent.value.cpu_percent) : undefined));
const memCurrent = computed(() => (agent.value ? formatPercent(agent.value.mem_pct) : undefined));
const swapCurrent = computed(() => (agent.value ? formatPercent(agent.value.swap_pct) : undefined));
const tempCurrent = computed(() => {
  const a = agent.value;
  return a && a.temp != null ? `${a.temp.toFixed(1)} °C` : undefined;
});
const diskIoCurrent = computed(() => {
  const a = agent.value;
  if (!a) return undefined;
  return `R ${formatBytes(a.disk_r_rate || 0, 1)}/s · W ${formatBytes(a.disk_w_rate || 0, 1)}/s`;
});
const loadCurrent = computed(() => {
  const a = agent.value;
  if (!a) return undefined;
  if (isWindows.value) return a.process_count != null ? String(a.process_count) : undefined;
  return a.load1 != null ? a.load1.toFixed(2) : undefined;
});
const diskReadSeries = computed<ChartPoint[]>(() => sparkline.value.map(d => ({ t: d.ts, v: d.disk_r_rate ?? 0 })));
const diskWriteSeries = computed<ChartPoint[]>(() => sparkline.value.map(d => ({ t: d.ts, v: d.disk_w_rate ?? 0 })));
const tempSeries = computed<ChartPoint[]>(() => sparkline.value.map(d => ({ t: d.ts, v: d.temp ?? 0 })));
const swapSeries = computed<ChartPoint[]>(() => sparkline.value.map(d => ({ t: d.ts, v: d.swap_pct ?? 0 })));

function avgProbe(points: { ts: number; ms: number | null; ok: boolean | null; loss: number | null }[]) {
  if (!points || !points.length) return null;
  // 三态：无采样（ok=null）不计入均值
  const ok = points.filter(p => p.ok === true && p.ms != null);
  if (!ok.length) return null;
  return ok.reduce((s, p) => s + (p.ms as number), 0) / ok.length;
}

function lossPercent(points: { ts: number; ms: number | null; ok: boolean | null; loss: number | null }[]) {
  // 分母只算有采样条目；无采样既不是成功也不是失败，不能把丢包率抬到 100%
  const sampled = (points || []).filter(p => p.loss != null);
  if (!sampled.length) return 0;
  return sampled.filter(p => p.ok === false).length / sampled.length * 100;
}

function p95Probe(points: { ts: number; ms: number | null; ok: boolean | null; loss: number | null }[]) {
  const ok = (points || []).filter(p => p.ok === true && p.ms != null).map(p => p.ms as number).sort((a, b) => a - b);
  if (!ok.length) return null;
  const idx = Math.min(ok.length - 1, Math.ceil(ok.length * 0.95) - 1);
  return ok[Math.max(0, idx)];
}

// ---- F4：可用率 / 证书倒计时 ----------------------------------------------
// 可用率文案：全失败显示「不可达」而非 0%——运营商 DNS 等目标对 TCP 全拒，
// 显示 0% 会被误读成探测链路故障。
function probeUpLabel(target: string): string {
  const av = availability.value[target];
  if (!av) return '—';
  if (av.unreachable) return t('node.probeUnreachable');
  return av.up_pct == null ? '—' : `${av.up_pct.toFixed(1)}%`;
}

// 详情浮层是固定深底：颜色一律返回内联色值，不用 Tailwind 语义色类
//（亮色主题会改写这些类，在深底上可能变得看不清）。
function probeUpColor(target: string): string {
  const av = availability.value[target];
  if (!av || av.unreachable) return '#fca5a5';
  const pct = av.up_pct ?? 0;
  if (pct >= 99) return '#6ee7b7';
  if (pct >= 95) return '#fbbf24';
  return '#fca5a5';
}

// 证书剩余天数 = 上报时刻的 cert_days − 距上报经过的天数。
// 必须做这个衰减：快照可能几天没更新（节点离线/历史停写），直接展示 cert_days
// 会让倒计时停在过去。
function probeCertLeft(target: string): number | null {
  const av = availability.value[target];
  if (!av || av.cert_days == null) return null;
  const age = av.cert_ts ? Math.max(0, Math.floor((Date.now() - av.cert_ts) / 86400000)) : 0;
  return Math.max(0, av.cert_days - age);
}

function probeCertColor(target: string): string {
  const left = probeCertLeft(target);
  if (left == null) return '#cbd5e1';
  if (left <= 14) return '#fca5a5';
  if (left <= 30) return '#fbbf24';
  return '#6ee7b7';
}

// ---- F7：在线率卡 ----------------------------------------------------------
function onlineDayClass(pct: number | null): string {
  if (pct == null) return 'bg-slate-600/40';
  if (pct >= 99) return 'bg-emerald-400/80';
  if (pct >= 95) return 'bg-amber-400/80';
  return 'bg-rose-400/80';
}

function onlineBarHeight(pct: number | null): number {
  // 0% 也保留一条可见的短柱，否则「全绿里夹一天全停」在视觉上会消失
  return pct == null ? 6 : Math.max(8, Math.min(100, pct));
}

function onlinePctClass(pct: number | null): string {
  if (pct == null) return 'text-muted';
  if (pct >= 99) return 'text-emerald-400';
  if (pct >= 95) return 'text-amber-400';
  return 'text-rose-400';
}

function fmtDateTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 探测三态（master 的 V1.2 改造）：ok 可为 null（解析超时 = 无采样），ms 同理
function probeSeries(points: { ts: number; ms: number | null; ok: boolean | null; loss: number | null }[]): ChartPoint[] {
  if (!points) return [];
  return points
    .filter(p => p.ok === true && p.ms != null)
    .map(p => ({ t: p.ts, v: p.ms as number })) // metrics.ts 已是毫秒，勿再 *1000
    .sort((a, b) => a.t - b.t);
}

const PALETTE = ['#f472b6', '#38bdf8', '#a78bfa', '#34d399', '#fbbf24', '#fb7185'];

const probeSeriesList = computed(() =>
  Object.entries(probes.value).map(([target, points], i) => ({
    name: target,
    color: PALETTE[i % PALETTE.length],
    data: probeSeries(points),
  }))
);

function stopRealtime() {
  if (rtTimer) { clearInterval(rtTimer); rtTimer = null; }
}

function appendRealtime() {
  if (chartRange.value !== 'realtime') return;
  const a = agent.value;
  if (!a) return;
  const prev = rtRows.value[rtRows.value.length - 1];
  const ts = Date.now();
  // 快照轮询本身是 10s；避免同一时刻重复追加
  if (prev && ts - prev.ts < 5000) return;
  const next: SparklinePoint = {
    ts,
    cpu: a.cpu ?? a.cpu_percent,
    mem_pct: a.mem_pct,
    disk_pct: a.disk_pct,
    net_rx_rate: a.net_rx_rate,
    net_tx_rate: a.net_tx_rate,
    load1: a.load1,
    temp: a.temp,
    swap_pct: a.swap_pct,
    uptime: a.uptime,
    process_count: a.process_count,
    // agent 快照没有磁盘速率，沿用上一个历史点，避免实时模式磁盘 IO 图掉 0
    disk_r_rate: prev?.disk_r_rate,
    disk_w_rate: prev?.disk_w_rate,
  };
  rtRows.value = [...rtRows.value.slice(-59), next];
}

async function startRealtime() {
  stopRealtime();
  const id = agentId.value;
  const sl = await publicApi.sparklines(id, '1h');
  // 垫底请求返回时可能已切节点/切范围/卸载：不得写旧数据，更不得留下孤儿定时器。
  if (!alive || id !== agentId.value || chartRange.value !== 'realtime') return;
  rtRows.value = (sl?.[id] || []).slice(-40);
  appendRealtime();
  rtTimer = setInterval(appendRealtime, 10000);
}

async function loadSpark(range: string) {
  if (range === 'realtime') { await startRealtime(); return; }
  stopRealtime();
  const id = agentId.value;
  // custom 复用已选窗口（节点切换后重载时原样恢复），不再把 'custom' 当 range 传给后端。
  const win = range === 'custom' ? customChart.value : null;
  if (range === 'custom' && !win) { sparkRows.value = []; return; }
  const sl = await publicApi.sparklines(id, win ? undefined : range, win || undefined);
  if (!alive || id !== agentId.value) return;
  sparkRows.value = sl?.[id] || [];
}

async function load() {
  loading.value = true;
  error.value = null;
  const id = agentId.value;
  try {
    // 图表数据按当前 chartRange 拉取；写入组件内 sparkRows，不用全局 state.sparklines
    //（会被首页 5s 轮询清空，见 sparkRows 注释）。
    await loadSpark(chartRange.value);
    // 磁盘耗尽预测固定用 30d 长窗口，避免短窗口噪声导致 ETA 剧烈抖动
    //（komari 仅 1d 留存，diting 有完整历史）。切 range 时不重拉这份。
    const sl30 = await publicApi.sparklines(id, '30d');
    if (!alive || id !== agentId.value) return;
    sparkRows30d.value = sl30?.[id] || [];
    // 对齐 Komari：初始拉当前 range，后端按 max_points 降采样返回。
    await loadProbes(currentRange.value);
    // 在线时段独立于图表 range（固定 30 天）；失败不阻断整页
    const oh = await publicApi.onlineHistory(id, 30).catch(() => null);
    if (!alive || id !== agentId.value) return;
    online.value = oh;
  } catch (e) {
    if (!alive || id !== agentId.value) return;
    error.value = (e as Error).message || t('common.error');
  } finally {
    loading.value = false;
  }
}

// 六图范围切换：实时/4h/1d/7d/30d + 自定义；只重拉图表数据，不影响磁盘预测的 30d 基线。
async function switchChartRange(range: string) {
  if (range === 'custom') { openCustom('chart'); return; }
  if (range === chartRange.value) return;
  const id = agentId.value;
  chartRange.value = range;
  loading.value = true;
  try {
    await loadSpark(range);
  } catch (e) {
    if (!alive || id !== agentId.value) return;
    error.value = (e as Error).message || t('common.error');
  } finally {
    loading.value = false;
  }
}

// 对齐 Komari 的 se()/me(R,()=>{b.value=[];se()})：切 range 即打后端，后端按 max_points 降采样返回，
// 每段 range 各自保证点数合适（1h→600, 6h→1000, 12h→1200, 24h→1500, 7d→2000）。
async function loadProbes(range: string) {
  const id = agentId.value;
  const mp = RANGE_MAX_POINTS[range] ?? 3000;
  // custom 复用已选窗口；'custom' 不是后端合法 range，不能直接透传。
  const win = range === 'custom' ? customProbes.value : null;
  const data = await publicApi.probesDetailed(id, win ? undefined : range, mp, win || undefined);
  if (!alive || id !== agentId.value) return;
  probes.value = data?.series || {};
  availability.value = data?.availability || {};
}

// 切范围：对齐 Komari，置 loading → 打后端 → 取消 loading（loading 反馈掩盖网络延迟，体验丝滑）
function switchRange(range: string) {
  if (range === 'custom') { openCustom('probes'); return; }
  if (range === currentRange.value) return;
  const id = agentId.value;
  currentRange.value = range;
  loading.value = true;
  loadProbes(range).catch((e) => {
    if (!alive || id !== agentId.value) return;
    error.value = (e as Error).message || t('common.error');
  }).finally(() => {
    loading.value = false;
  });
}

// ---- 自定义时间范围（对齐 Glass 的「自定义」浮层）----
function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function openCustom(target: 'chart' | 'probes') {
  customTarget.value = target;
  // 重开浮层时回填该图上次选中的窗口，避免明明显示「自定义」却跳回最近 24h。
  const saved = target === 'chart' ? customChart.value : customProbes.value;
  const end = saved ? new Date(saved.end) : new Date();
  const start = saved ? new Date(saved.start) : new Date(end.getTime() - 24 * 3600 * 1000);
  customStart.value = toLocalInput(start);
  customEnd.value = toLocalInput(end);
  customOpen.value = true;
}
const CUSTOM_MAX_MS = 30 * 86400000;
async function applyCustom() {
  const start = new Date(customStart.value);
  const end = new Date(customEnd.value);
  const s = start.getTime();
  const e = end.getTime();
  if (!Number.isFinite(s) || !Number.isFinite(e) || !(e > s)) {
    error.value = t('node.custom.invalid');
    return;
  }
  // 后端上限 30 天，前端先拦，避免把 400 原始错误直接甩给用户。
  if (e - s > CUSTOM_MAX_MS) {
    error.value = t('node.custom.tooLarge');
    return;
  }
  const range = { start: start.toISOString(), end: end.toISOString() };
  loading.value = true;
  error.value = null;
  try {
    if (customTarget.value === 'chart') {
      customChart.value = range;
      chartRange.value = 'custom';
      await loadSpark('custom'); // 内部会 stopRealtime()
    } else {
      customProbes.value = range;
      currentRange.value = 'custom';
      await loadProbes('custom');
    }
    customOpen.value = false;
  } catch (err) {
    error.value = (err as Error).message || t('common.error');
  } finally {
    loading.value = false;
  }
}

// 磁盘耗尽预测：基于最近 sparkline 的 disk_used 真实字节增量线性外推
// 展示层（已用/总容量/占用率）与 ETA 的剩余空间统一用 diskAgg（所有物理盘聚合），避免只统计单盘
const diskPredict = computed(() => {
  // 用固定 30d 基线（sparkRows30d）的 disk_used（B）做首末点线性外推：
  // 与图表显示范围解耦，避免切到 1h/6h 等短 range 时 ETA 剧烈抖动。
  const sl = sparkRows30d.value.length ? sparkRows30d.value : sparkline.value;
  // diskAgg 为所有物理盘聚合值（无 disks 时回退单盘），保证进度条/百分比/已用容量均为整机口径
  const agg = diskAgg.value;
  const total = agg.total;
  const used = agg.used;
  const pct = agg.pct;
  if (!total) return null;
  if (!sl || sl.length < 2) {
    return { eta: null as string | null, pct, days: null as number | null, total, used, stable: true };
  }
  const dayMs = 86400000;
  const first = sl[0], last = sl[sl.length - 1];
  const spanDays = Math.max((last.ts - first.ts) / dayMs, 0.01);
  // 历史增量取自 sparkline 单盘 disk_used 序列（metrics 仅存单盘口径），作为增速近似
  const delta = (last.disk_used ?? 0) - (first.disk_used ?? 0);
  const dailyGrowth = delta / spanDays; // 字节/天
  if (dailyGrowth <= 0) {
    return { eta: null as string | null, pct, days: null as number | null, total, used, stable: true };
  }
  // 剩余空间用整机聚合口径
  const remain = Math.max(total - used, 0);
  const days = remain / dailyGrowth;
  const eta = new Date(Date.now() + days * dayMs);
  return {
    eta: eta.toISOString().slice(0, 10),
    pct,
    days: Math.floor(days),
    total,
    used,
    stable: false,
  };
});

// /node/:id 是同一路由记录，App.vue 的 <RouterView /> 无 key ⇒ 组件实例会被复用。
// 头部「上一个/下一个/下拉切换」只改 params，不会重跑 onMounted；必须显式重载全部时序数据，
// 否则 URL 变了但六图/延迟/在线率仍是上一个节点的，实时模式还会把新节点快照混进旧历史。
watch(agentId, () => {
  if (!alive) return;
  stopRealtime();
  sparkRows.value = [];
  rtRows.value = [];
  sparkRows30d.value = [];
  probes.value = {};
  availability.value = {};
  online.value = null;
  load();
});

onMounted(load);
onUnmounted(() => {
  alive = false;
  stopRealtime();
});
</script>

<template>
  <div class="min-h-screen">
    <AppHeader :meta="state.meta" />
    <main class="mx-auto max-w-7xl px-6 pt-4">
      <div class="mb-4 flex flex-wrap items-center gap-2">
        <RouterLink
          to="/"
          class="glass flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-sky-400 transition-colors hover:text-sky-300"
        >← {{ t('node.backHome') }}</RouterLink>
        <button
          class="glass flex h-8 w-8 items-center justify-center rounded-lg"
          :title="favorite ? t('node.unfavorite') : t('node.favorite')"
          @click="toggleFavoriteNode(agentId)"
        >
          <Star :size="16" :fill="favorite ? 'currentColor' : 'none'" :class="favorite ? 'text-amber-300' : 'text-slate-400'" />
        </button>
        <div class="glass ml-auto flex items-center gap-1 rounded-lg p-1">
          <button
            class="flex h-7 w-7 items-center justify-center rounded-md text-slate-400 transition-colors hover:text-sky-300 disabled:opacity-30"
            :disabled="!prevNode"
            :title="t('node.prevNode')"
            @click="prevNode && goNode(prevNode.id)"
          >
            <ArrowLeft :size="15" />
          </button>
          <select
            :value="agentId"
            class="max-w-40 cursor-pointer rounded-md border-none bg-transparent px-1 py-0.5 text-sm text-content outline-none"
            :title="t('node.switchNode')"
            @change="goNode(($event.target as HTMLSelectElement).value)"
          >
            <option v-for="n in nodeList" :key="n.id" :value="n.id" class="bg-slate-800 text-content">{{ n.name }}</option>
          </select>
          <button
            class="flex h-7 w-7 items-center justify-center rounded-md text-slate-400 transition-colors hover:text-sky-300 disabled:opacity-30"
            :disabled="!nextNode"
            :title="t('node.nextNode')"
            @click="nextNode && goNode(nextNode.id)"
          >
            <ArrowRight :size="15" />
          </button>
        </div>
      </div>
      <ErrorMessage v-if="error" class="mb-6" :message="error" />
      <Loading v-if="loading && !agent" />
      <EmptyState v-else-if="!agent" />
      <div v-else class="space-y-6">
        <!-- 标题区（状态点 + 国旗 + 名称 + 版本） -->
        <div class="glass p-5">
          <div class="flex flex-wrap items-center gap-3">
            <img v-if="agent.country || agent.country_code" :src="`/flags/${(agent.country_code || agent.country || '').toLowerCase()}.svg`" class="h-6 w-8 rounded-sm" :alt="agent.country" />
            <h1 class="text-2xl font-bold">{{ agent.name }}</h1>
            <span class="status-dot" :class="agent.online ? 'status-online' : 'status-offline'" />
            <span
              class="rounded-full px-3 py-1 text-xs"
              :class="agent.online ? 'bg-emerald-500/15 text-emerald-400' : 'bg-rose-500/15 text-rose-400'"
            >{{ agent.online ? t('common.online') : t('common.offline') }}</span>
            <div class="ml-auto flex items-center gap-2">
              <span v-if="agent.version" class="rounded-full bg-surface px-3 py-1 text-xs text-secondary">v{{ agent.version }}</span>
              <button
                class="rounded-lg bg-sky-600 px-3 py-1 text-xs font-medium text-white hover:bg-sky-500"
                @click="showAiDialog = true"
              >{{ t('ai.analyzeNode') }}</button>
            </div>
          </div>
          <p class="mt-2 text-sm text-muted">{{ agent.os }} · {{ agent.id }}</p>
        </div>

        <div class="space-y-6">
          <!-- 顶部信息条：对齐 glassmorphism 节点页顶部水平指标条 -->
          <div class="flex flex-wrap gap-3">
            <div class="glass pill-card inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium leading-5 whitespace-nowrap">
              <svg class="h-4 w-4 text-cyan-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12h4l3 8 4-16 3 8h4"/></svg>
              <span class="text-xs text-muted">{{ t('node.metric.traffic') }}</span>
              <span class="text-sm font-semibold text-cyan-700">{{ formatBytes((agent.net_rx_month || 0) + (agent.net_tx_month || 0)) }}</span>
            </div>
            <div class="glass pill-card inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium leading-5 whitespace-nowrap">
              <svg class="h-4 w-4 text-emerald-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v18M3 12h18"/><circle cx="12" cy="12" r="9"/></svg>
              <span class="text-xs text-muted">{{ t('node.metric.quota') }}</span>
              <span class="text-sm font-semibold text-emerald-700">{{ agent.monthly_quota_gb != null ? formatBytes(agent.monthly_quota_gb * 1024 ** 3) : '∞' }}</span>
            </div>
            <div class="glass pill-card inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium leading-5 whitespace-nowrap">
              <svg class="h-4 w-4 text-indigo-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
              <span class="text-xs text-muted">{{ t('node.metric.uptime') }}</span>
              <span class="text-sm font-semibold text-indigo-700">{{ formatDuration(agent.uptime) }}</span>
            </div>
          </div>

          <!-- 顶部计费四卡：节点价格 / 月均支出 / 剩余时间 / 剩余价值（对齐 Komari 顶部统计卡，统一毛玻璃） -->
          <div v-if="agent.price != null || agent.expire_at" class="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div
              v-for="card in billingCards"
              :key="card.key"
              class="glass group flex flex-col gap-1 rounded-md border-none p-3 transition-all"
            >
              <div class="flex items-center gap-1.5 text-xs text-secondary">
                <component :is="card.icon" :size="14" />
                <span>{{ card.label }}</span>
              </div>
              <span
                class="text-lg font-semibold"
                :class="card.key === 'remainingTime' ? remainingStatusClass[card.status] : 'text-content'"
              >{{ card.value }}</span>
            </div>
          </div>

          <!-- 顶部四卡：严格对齐 Komari Glassmorphism 节点详情页（lg 以上 2 列，不强制等高） -->
          <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <!-- 硬件信息：glass 毛玻璃卡 + 纵向条目 -->
            <div class="glass group flex flex-col rounded-md border-none p-3 transition-all">
              <h3 class="mb-2 text-xs font-medium tracking-wider text-secondary">{{ t('node.sec.hardware') }}</h3>
              <!-- CPU 型号块（对齐 Komari 硬件卡顶部大块） -->
              <div class="mb-3 flex flex-col gap-1 rounded-sm bg-slate-500/5 p-2">
                <div class="flex items-center gap-1 text-xs text-muted-foreground">
                  <Cpu :size="14" />
                  <span>{{ t('node.cpuModel') }}</span>
                </div>
                <span class="text-xs sm:text-sm text-content">
                  {{ agent.cpu_name || t('node.unknown') }}<template v-if="(agent.cores || 0) > 0"> ({{ agent.cores }} vCPU)</template>
                </span>
              </div>
              <!-- 架构/虚拟化/GPU 三项并排；无 GPU 数据只有两项时铺满两列 -->
              <div class="grid gap-1" :class="hwDynamic.length >= 3 ? 'grid-cols-3' : 'grid-cols-2'">
                <div v-for="item in hwDynamic" :key="item.label" class="flex min-w-0 flex-col gap-1 rounded-sm bg-slate-500/5 px-2 py-1.5">
                  <span class="flex items-center gap-1 text-xs text-muted-foreground">
                    <component :is="item.icon" :size="14" class="shrink-0" />
                    <span class="truncate">{{ item.label }}</span>
                  </span>
                  <span class="truncate text-xs sm:text-sm text-content" :title="item.value">{{ item.value }}</span>
                </div>
              </div>
            </div>

            <!-- 系统信息 -->
            <div class="glass group flex flex-col rounded-md border-none p-3 transition-all">
              <h3 class="mb-2 text-xs font-medium tracking-wider text-secondary">{{ t('node.sec.system') }}</h3>
              <div class="grid grid-cols-2 gap-1">
                <div class="flex min-w-0 flex-col gap-1 rounded-sm bg-slate-500/5 p-2">
                  <span class="flex gap-1 items-center text-xs text-muted-foreground"><Computer :size="14" /><span>{{ t('node.os') }}</span></span>
                  <span class="truncate text-xs sm:text-sm text-content">{{ agent.os || '—' }}</span>
                </div>
                <div class="flex min-w-0 flex-col gap-1 rounded-sm bg-slate-500/5 p-2">
                  <span class="flex gap-1 items-center text-xs text-muted-foreground"><Code :size="14" /><span>{{ t('node.kernel') }}</span></span>
                  <span class="truncate text-xs sm:text-sm text-content">{{ agent.kernel_version || '—' }}</span>
                </div>
                <div class="flex min-w-0 flex-col gap-1 rounded-sm bg-slate-500/5 p-2">
                  <span class="flex gap-1 items-center text-xs text-muted-foreground"><Timer :size="14" /><span>{{ t('node.metric.uptime') }}</span></span>
                  <span class="truncate text-xs sm:text-sm text-content">{{ formatDuration(agent.uptime) || '—' }}</span>
                </div>
                <div class="flex min-w-0 flex-col gap-1 rounded-sm bg-slate-500/5 p-2">
                  <span class="flex gap-1 items-center text-xs text-muted-foreground"><Server :size="14" /><span>{{ t('node.merchant') }}</span></span>
                  <span class="truncate text-xs sm:text-sm text-content">{{ agent.merchant || '—' }}</span>
                </div>
              </div>
            </div>

            <!-- 存储信息：glass 毛玻璃卡 + 纵向紧凑条目 -->
            <div class="glass group flex flex-col rounded-md border-none p-3 transition-all">
              <h3 class="mb-2 text-xs font-medium tracking-wider text-secondary">{{ t('node.sec.storage') }}</h3>
              <div class="grid grid-cols-3 gap-1">
                <!-- 内存 -->
                <div class="relative flex min-w-0 flex-col gap-1 overflow-hidden rounded-sm bg-slate-500/5 p-2">
                  <div
                    v-if="agent.mem_pct != null && agent.mem_pct > 0"
                    class="pointer-events-none absolute inset-y-0 left-0 rounded-sm transition-[width,background-color] duration-300 ease-out"
                    :class="agent.mem_pct >= 80 ? 'bg-red-500/28' : agent.mem_pct >= 60 ? 'bg-amber-500/22' : 'bg-emerald-500/18'"
                    :style="{ width: Math.min(agent.mem_pct, 100) + '%' }"
                  ></div>
                  <span class="relative z-10 flex gap-1 items-center text-xs text-muted-foreground"><Memory :size="14" /><span>{{ t('node.storage.mem') }}</span></span>
                  <span class="relative z-10 truncate text-xs sm:text-sm text-content">{{ formatBytes(agent.mem_total, 1) }} <span class="text-muted">{{ formatPercent(agent.mem_pct) }}</span></span>
                </div>
                <!-- 交换 -->
                <div class="relative flex min-w-0 flex-col gap-1 overflow-hidden rounded-sm bg-slate-500/5 p-2">
                  <div
                    v-if="agent.swap_pct != null && agent.swap_pct > 0"
                    class="pointer-events-none absolute inset-y-0 left-0 rounded-sm transition-[width,background-color] duration-300 ease-out"
                    :class="agent.swap_pct >= 80 ? 'bg-red-500/28' : agent.swap_pct >= 60 ? 'bg-amber-500/22' : 'bg-emerald-500/18'"
                    :style="{ width: Math.min(agent.swap_pct, 100) + '%' }"
                  ></div>
                  <span class="relative z-10 flex gap-1 items-center text-xs text-muted-foreground"><Switch :size="14" /><span>{{ t('node.storage.swap') }}</span></span>
                  <span class="relative z-10 truncate text-xs sm:text-sm text-content">{{ formatPercent(agent.swap_pct) }}</span>
                </div>
                <!-- 硬盘（所有物理盘总和） -->
                <div class="relative flex min-w-0 flex-col gap-1 overflow-hidden rounded-sm bg-slate-500/5 p-2">
                  <div
                    v-if="diskAgg.pct > 0"
                    class="pointer-events-none absolute inset-y-0 left-0 rounded-sm transition-[width,background-color] duration-300 ease-out"
                    :class="diskAgg.pct >= 80 ? 'bg-red-500/28' : diskAgg.pct >= 60 ? 'bg-amber-500/22' : 'bg-emerald-500/18'"
                    :style="{ width: Math.min(diskAgg.pct, 100) + '%' }"
                  ></div>
                  <span class="relative z-10 flex gap-1 items-center text-xs text-muted-foreground"><HardDisk :size="14" /><span>{{ t('node.storage.disk') }}</span></span>
                  <span class="relative z-10 truncate text-xs sm:text-sm text-content">{{ formatBytes(diskAgg.total, 1) }} <span class="text-muted">{{ formatPercent(diskAgg.pct) }}</span></span>
                </div>
              </div>
            </div>

            <!-- 网络信息：glass 毛玻璃卡 + 横排两块 -->
            <div class="glass group flex flex-col rounded-md border-none p-3 transition-all">
              <h3 class="mb-2 text-xs font-medium tracking-wider text-secondary">{{ t('node.sec.network') }}</h3>
              <div class="grid grid-cols-2 gap-1">
                <!-- 总流量块（进度条铺在本块内部背景） -->
                <div class="relative flex min-w-0 flex-col gap-1 overflow-hidden rounded-sm bg-slate-500/5 p-2">
                  <div
                    v-if="agent.monthly_quota_gb != null && netUsagePct > 0"
                    class="pointer-events-none absolute inset-y-0 left-0 rounded-sm transition-[width,background-color] duration-300 ease-out"
                    :class="netUsagePct >= 80 ? 'bg-red-500/28' : netUsagePct >= 60 ? 'bg-amber-500/22' : 'bg-emerald-500/18'"
                    :style="{ width: Math.min(netUsagePct, 100) + '%' }"
                  ></div>
                  <span class="relative z-10 flex gap-1 items-center text-xs text-muted-foreground"><TransferData :size="14" /><span>{{ t('node.netTotal') }}</span></span>
                  <span v-if="agent.monthly_quota_gb != null" class="relative z-10 truncate text-xs sm:text-sm text-content">{{ formatBytes((agent.net_rx_month || 0) + (agent.net_tx_month || 0), 1) }} / {{ formatBytes(agent.monthly_quota_gb * 1024 ** 3, 1) }} <span class="text-muted">{{ formatPercent(netUsagePct) }}</span></span>
                  <span v-else class="relative z-10 truncate text-xs sm:text-sm text-content">{{ t('node.unlimitedTraffic') }}</span>
                </div>
                <!-- 网络速率块 -->
                <div class="flex min-w-0 flex-col gap-1 rounded-sm bg-slate-500/5 p-2">
                  <span class="flex gap-1 items-center text-xs text-muted-foreground"><DashboardOne :size="14" /><span>{{ t('node.netRate') }}</span></span>
                  <span class="truncate whitespace-nowrap text-xs sm:text-sm text-content">↑ {{ formatBitsPerSecond(agent.net_tx_rate) }} ↓ {{ formatBitsPerSecond(agent.net_rx_rate) }}</span>
                </div>
              </div>
            </div>
          </div>

          <!-- 六图时间范围切换：只影响 CPU/内存/磁盘IO/负载/温度/swap 的显示范围；
               磁盘耗尽预测固定用 30d 基线，不随此切换变化，避免 ETA 抖动。 -->
          <div class="mb-2 flex flex-wrap items-center gap-2">
            <span class="glass pill-card inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium leading-5 whitespace-nowrap"><Time :size="16" />{{ t('node.chart.range') }}</span>
            <button
              v-for="r in CHART_RANGES"
              :key="r"
              type="button"
              @click="switchChartRange(r)"
              class="glass pill-card inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium leading-5 whitespace-nowrap"
              :class="{ 'is-active': chartRange === r }"
              :disabled="loading"
            ><Time :size="16" />{{ t('node.range.' + r) }}</button>
            <button
              type="button"
              class="glass pill-card inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium leading-5 whitespace-nowrap"
              :class="{ 'is-active': chartRange === 'custom' }"
              :disabled="loading"
              @click="openCustom('chart')"
            ><Time :size="16" />{{ t('node.range.custom') }}</button>
          </div>

          <div class="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          <ChartLatency :title="t('node.chart.cpu')" :data="cpuSeries" color="#38bdf8" :current="cpuCurrent" />
          <ChartLatency :title="t('node.chart.mem')" :data="memSeries" color="#a78bfa" :current="memCurrent" />
          <ChartLatencyDual
            :title="t('node.chart.diskIo')"
            :series="[
              { name: t('node.read'), data: diskReadSeries, color: '#22d3ee' },
              { name: t('node.write'), data: diskWriteSeries, color: '#c084fc' },
            ]"
            :current="diskIoCurrent"
          />
          <ChartLatency
            :title="isWindows ? t('node.chart.process') : t('node.chart.load')"
            :data="isWindows ? processSeries : loadSeries"
            color="#fb923c"
            :current="loadCurrent"
          />
          <ChartLatency :title="t('node.chart.temp')" :data="tempSeries" color="#f87171" :current="tempCurrent" />
          <ChartLatency :title="t('node.chart.swap')" :data="swapSeries" color="#fbbf24" :current="swapCurrent" />
        </div>
        </div>

        <!-- F7：在线率（30 天热力条 + 最近停机） -->
        <div v-if="online" class="glass p-5">
          <div class="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h3 class="flex items-center gap-2 text-base font-semibold text-content">
              <svg class="h-4 w-4 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12h4l3 8 4-16 3 8h4"/></svg>
              {{ t('node.onlineTitle') }}
            </h3>
            <span v-if="online.uptime_pct != null" class="text-sm text-muted">
              {{ t('node.online30d') }}
              <span class="ml-1 text-lg font-semibold" :class="onlinePctClass(online.uptime_pct)">{{ online.uptime_pct.toFixed(1) }}%</span>
            </span>
          </div>

          <div class="mb-4 flex h-10 items-end gap-[3px]">
            <div
              v-for="d in online.daily"
              :key="d.date"
              class="group relative flex-1 rounded-sm"
              :class="onlineDayClass(d.pct)"
              :style="{ height: `${onlineBarHeight(d.pct)}%` }"
            >
              <span class="pointer-events-none absolute -top-7 left-1/2 z-10 hidden -translate-x-1/2 whitespace-nowrap rounded bg-black/80 px-2 py-0.5 text-[10px] text-white group-hover:block">
                {{ d.date }} · {{ d.pct == null ? '—' : `${d.pct.toFixed(1)}%` }}
              </span>
            </div>
          </div>

          <div class="text-xs">
            <div class="mb-1 text-muted">{{ t('node.outages') }}</div>
            <div v-if="!online.outages.length" class="text-emerald-400/80">{{ t('node.noOutages') }}</div>
            <div v-else class="space-y-1">
              <div
                v-for="o in online.outages.slice(0, 5)"
                :key="o.started_at"
                class="flex items-center justify-between gap-3 rounded-lg bg-surface/60 px-3 py-1.5"
              >
                <span class="text-secondary">{{ fmtDateTime(o.started_at) }}</span>
                <span :class="o.ended_at == null ? 'text-rose-400' : 'text-muted'">
                  {{ o.ended_at == null ? t('node.outageOngoing') : formatDuration(o.duration_sec) }}
                </span>
              </div>
            </div>
          </div>
        </div>

        <div v-if="(agent.note || agent.expire_at || agent.monthly_quota_gb != null || agent.price != null || agent.hostname || agent.group) || diskPredict" class="grid grid-cols-1 gap-6 md:grid-cols-2">
          <div v-if="agent.note || agent.expire_at || agent.monthly_quota_gb != null || agent.price != null || agent.hostname || agent.group" class="glass p-5">
            <h3 class="mb-4 flex items-center gap-2 text-base font-semibold text-content">
              <svg class="h-4 w-4 text-sky-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 5h16v14H4z"/><path d="M8 9h8M8 13h5"/></svg>
              {{ t('node.notePlan') }}
            </h3>
            <div v-if="agent.note" class="mb-4 rounded-xl border-l-2 border-sky-400/70 bg-surface/60 px-4 py-3 text-sm leading-relaxed text-content">{{ agent.note }}</div>
            <div class="flex flex-wrap gap-2">
              <span v-if="agent.hostname" class="inline-flex items-center gap-1.5 rounded-full border border-slate-400/30 bg-slate-400/10 px-3 py-1.5 text-xs">
                <span class="text-muted">{{ t('node.hostname') }}</span>
                <span class="font-semibold text-slate-200">{{ agent.hostname }}</span>
              </span>
              <span v-if="agent.group" class="inline-flex items-center gap-1.5 rounded-full border border-slate-400/30 bg-slate-400/10 px-3 py-1.5 text-xs">
                <span class="text-muted">{{ t('node.group') }}</span>
                <span class="font-semibold text-slate-200">{{ agent.group }}</span>
              </span>
              <span v-if="agent.monthly_quota_gb != null" class="inline-flex items-center gap-1.5 rounded-full border border-sky-400/30 bg-sky-400/10 px-3 py-1.5 text-xs">
                <svg class="h-3.5 w-3.5 text-sky-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l8 4v6c0 5-4 7-8 8-4-1-8-3-8-8V7z"/></svg>
                <span class="text-muted">{{ t('node.quotaMonthly') }}</span>
                <span class="font-semibold text-sky-300">{{ formatBytes(agent.monthly_quota_gb * 1024 ** 3) }}</span>
              </span>
              <span v-if="agent.expire_at" class="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1.5 text-xs">
                <svg class="h-3.5 w-3.5 text-emerald-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/></svg>
                <span class="text-muted">{{ t('node.expireAt') }}</span>
                <span class="font-semibold text-emerald-300">{{ formatDate(agent.expire_at) }}</span>
              </span>
              <span v-if="agent.price != null" class="inline-flex items-center gap-1.5 rounded-full border border-amber-400/30 bg-amber-400/10 px-3 py-1.5 text-xs">
                <svg class="h-3.5 w-3.5 text-amber-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v10M9 10h4.5a2 2 0 0 1 0 4H9"/></svg>
                <span class="text-muted">{{ t('node.price') }}</span>
                <span class="font-semibold text-amber-300">{{ agent.currency || '' }} {{ formatNumber(agent.price, 2) }}<span v-if="agent.billing_cycle"> / {{ t('node.daysCycle', { n: agent.billing_cycle }) }}</span></span>
              </span>
            </div>
          </div>

          <div v-if="diskPredict" class="glass p-5">
            <div class="mb-4 flex items-center justify-between">
              <h3 class="flex items-center gap-2 text-base font-semibold text-content">
                <svg class="h-4 w-4 text-sky-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"/><path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/></svg>
                {{ t('node.diskEta') }}
              </h3>
              <span
                class="rounded-full px-2.5 py-0.5 text-xs font-medium"
                :class="diskPredict.pct >= 80 ? 'bg-rose-400/15 text-rose-300' : diskPredict.pct >= 50 ? 'bg-amber-400/15 text-amber-300' : 'bg-sky-400/15 text-sky-300'"
              >{{ formatPercent(diskPredict.pct) }}</span>
            </div>
            <!-- 占用率进度条：铺满「已用/总容量」内层胶囊的高度（背景层，半透明实色，宽度=占用率） -->
            <div class="relative mb-4 flex items-baseline justify-between overflow-hidden rounded-xl bg-surface/40 px-4 py-3">
              <div
                class="pointer-events-none absolute inset-y-0 left-0 rounded-xl transition-[width,background-color] duration-300 ease-out"
                :class="diskPredict.pct >= 80 ? 'bg-red-500/28' : diskPredict.pct >= 60 ? 'bg-amber-500/22' : 'bg-emerald-500/18'"
                :style="{ width: Math.min(diskPredict.pct, 100) + '%' }"
              ></div>
              <span class="relative z-10 text-2xl font-bold text-content">{{ formatBytes(diskPredict.used) }}</span>
              <span class="relative z-10 text-sm text-muted">/ {{ formatBytes(diskPredict.total) }}</span>
            </div>
            <div class="flex items-center justify-between rounded-xl bg-surface/60 px-4 py-3">
              <span class="flex items-center gap-2 text-sm text-muted">
                <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
                {{ t('node.etaLabel') }}
              </span>
              <span v-if="diskPredict.eta" class="text-sm font-semibold text-sky-300">{{ t('node.etaIn', { eta: diskPredict.eta, days: diskPredict.days ?? 0 }) }}</span>
              <span v-else class="rounded-full bg-emerald-400/15 px-2.5 py-0.5 text-xs font-medium text-emerald-300">{{ t('node.growthFlat') }}</span>
            </div>
          </div>
        </div>

        <div class="glass p-4">
          <h3 class="mb-3 text-lg font-semibold">{{ t('node.netQuality') }}</h3>
          <div class="mb-3 flex flex-wrap items-center gap-2">
            <button
              v-for="r in RANGES"
              :key="r"
              type="button"
              @click="switchRange(r)"
              class="glass pill-card inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium leading-5 whitespace-nowrap"
              :class="{ 'is-active': currentRange === r }"
            ><Time :size="16" />{{ t('node.range.' + r) }}</button>
            <button
              type="button"
              @click="openCustom('probes')"
              class="glass pill-card inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium leading-5 whitespace-nowrap"
              :class="{ 'is-active': currentRange === 'custom' }"
            ><Time :size="16" />{{ t('node.range.custom') }}</button>
          </div>
          <!-- 探测目标横排精简卡：只保留「名称 + 平均延迟」，hover / 键盘聚焦展开完整统计 -->
          <div class="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div
              v-for="(points, target, i) in probes"
              :key="`stat-${target}`"
              class="probe-chip relative cursor-default rounded-lg bg-surface px-2.5 py-1.5 text-xs"
              tabindex="0"
            >
              <div class="flex min-w-0 items-center gap-1.5">
                <span class="inline-block h-2 w-2 shrink-0 rounded-full" :style="{ backgroundColor: PALETTE[i % PALETTE.length] }"></span>
                <span class="truncate" :style="{ color: PALETTE[i % PALETTE.length] }">{{ target }}</span>
                <span class="ml-auto shrink-0 font-medium tabular-nums" :class="avgProbe(points) != null ? 'text-emerald-400' : 'text-rose-400'">
                  {{ avgProbe(points) != null ? `${avgProbe(points)?.toFixed(1)} ms` : t('card.timeout') }}
                </span>
              </div>
              <!-- 固定深底浮层：亮色主题会覆盖 text-white 类，故颜色一律内联写死 -->
              <div
                class="probe-tip pointer-events-none absolute top-full z-30 mt-1 w-52 rounded-lg p-2.5 opacity-0 shadow-xl transition-opacity"
                :class="i >= 2 ? 'right-0' : 'left-0'"
                style="background: rgba(15, 23, 42, 0.96); color: #e2e8f0; border: 1px solid rgba(148, 163, 184, 0.28);"
              >
                <div class="mb-1.5 flex items-center gap-1.5 border-b border-slate-600/50 pb-1.5">
                  <span class="inline-block h-2 w-2 rounded-full" :style="{ backgroundColor: PALETTE[i % PALETTE.length] }"></span>
                  <span class="font-medium" style="color: #f8fafc;">{{ target }}</span>
                </div>
                <div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                  <span style="color: #94a3b8;">{{ t('node.probeAvg') }}</span>
                  <span class="text-right" style="color: #6ee7b7;">{{ avgProbe(points) != null ? `${avgProbe(points)?.toFixed(1)} ms` : '—' }}</span>
                  <span style="color: #94a3b8;">{{ t('node.probeP95') }}</span>
                  <span class="text-right" style="color: #7dd3fc;">{{ p95Probe(points) != null ? `${p95Probe(points)?.toFixed(1)} ms` : '—' }}</span>
                  <span style="color: #94a3b8;">{{ t('node.lossRate') }}</span>
                  <span class="text-right" style="color: #f8fafc;">{{ formatNumber(lossPercent(points), 1) }}%</span>
                  <!-- F4：窗口可用率；全失败显示「不可达」而不是 0% -->
                  <span style="color: #94a3b8;">{{ t('node.availability') }}</span>
                  <span class="text-right" :style="{ color: probeUpColor(target) }">{{ probeUpLabel(target) }}</span>
                  <!-- F4：证书倒计时（仅 https 目标有 cert_days） -->
                  <template v-if="probeCertLeft(target) != null">
                    <span style="color: #94a3b8;">{{ t('node.cert') }}</span>
                    <span class="text-right" :style="{ color: probeCertColor(target) }">
                      {{ probeCertLeft(target) === 0 ? t('node.certExpired') : t('node.certDays', { days: probeCertLeft(target) ?? 0 }) }}
                    </span>
                  </template>
                  <template v-else-if="availability[target]?.type === 'http'">
                    <span style="color: #94a3b8;">HTTP</span>
                    <span class="text-right" style="color: #7dd3fc;">{{ availability[target]?.code ?? '—' }}</span>
                  </template>
                </div>
              </div>
            </div>
          </div>
          <ChartLatencyMulti :title="t('node.chart.latency')" :series="probeSeriesList" />
        </div>
      </div>
      <AiNodeAnalysisDialog
        v-if="showAiDialog && agent"
        :agent-id="agent.id"
        :agent-name="agent.name"
        guard-auth
        @close="showAiDialog = false"
      />

      <!-- 自定义时间范围（对齐 Glass 的自定义浮层） -->
      <div
        v-if="customOpen"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
        @click.self="customOpen = false"
      >
        <div class="glass w-full max-w-md rounded-xl p-5">
          <h3 class="mb-4 text-lg font-semibold">{{ t('node.custom.title') }}</h3>
          <label class="mb-3 block text-xs text-secondary">
            {{ t('node.custom.start') }}
            <input
              v-model="customStart"
              type="datetime-local"
              class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-white outline-none focus:border-sky-500"
            />
          </label>
          <label class="mb-4 block text-xs text-secondary">
            {{ t('node.custom.end') }}
            <input
              v-model="customEnd"
              type="datetime-local"
              class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-white outline-none focus:border-sky-500"
            />
          </label>
          <div class="flex justify-end gap-2">
            <button class="rounded-lg px-3 py-1.5 text-sm text-secondary hover:text-white" @click="customOpen = false">
              {{ t('common.cancel') }}
            </button>
            <button class="rounded-lg bg-sky-500 px-3 py-1.5 text-sm text-white hover:bg-sky-400" @click="applyCustom">
              {{ t('node.custom.apply') }}
            </button>
          </div>
        </div>
      </div>
    </main>
  </div>
</template>
