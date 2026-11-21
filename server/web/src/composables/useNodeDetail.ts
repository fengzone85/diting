// 节点详情页数据层：时序历史（六图/实时模式）、延迟探测、在线时段、自定义时间窗。
// 从 NodeDetailView 原样抽出，行为保持不变；组件只负责渲染。
//
// 关键不变量（历史事故，勿改）：
// 1. 详情页刻意不复用 useApp 的全局 state.sparklines——首页 5s 轮询会刷新/清空它，
//    会把本页补拉的数据覆盖掉，六张图全空白。这里用独立 ref 彻底解耦。
// 2. 所有 await 之后都要做「存活 + 节点未变」双重校验，防止卸载/切节点后写旧数据
//    或留下孤儿轮询定时器。
// 3. 外部停止信号（stopRealtime）必须被尊重：await 期间被停掉后不得再启动定时器。
import { computed, onMounted, onUnmounted, ref, watch, type ComputedRef, type Ref } from 'vue';
import { publicApi } from '../services/publicApi';
import { t } from './useI18n';
import type { Agent, OnlineHistory, ProbeAvailability, Probes, SparklinePoint } from '../services/types';

// 网络质量（延迟）图范围：对齐玻璃拟态设计 PingChart 的 1h/6h/12h/1d/7d + 自定义
export const RANGES = ['1h', '6h', '12h', '24h', '7d'];
// 上方六图（CPU/内存/磁盘IO/负载/温度/swap）范围：实时/4h/1d/7d/30d + 自定义。
// 磁盘耗尽预测不走这里，固定用 sparkRows30d。
export const CHART_RANGES = ['realtime', '4h', '24h', '7d', '30d'];
// 每段 range 各自的降采样点数（对齐参考面板：短 range 也保持点数合适，不互相挤占）
const RANGE_MAX_POINTS: Record<string, number> = {
  '1h': 600, '4h': 800, '6h': 1000, '12h': 1200, '24h': 1500, '7d': 2000, '30d': 3000,
};
// 后端自定义窗口上限 30 天，前端先拦，避免把 400 原始错误直接甩给用户。
const CUSTOM_MAX_MS = 30 * 86400000;

export interface NodeDetailOptions {
  agentId: Ref<string>;
  agent: ComputedRef<Agent | undefined>;
}

export function useNodeDetail({ agentId, agent }: NodeDetailOptions) {
  const probes = ref<Probes>({});
  // F4：可用率/证书元信息（与 probes 同一次请求返回，窗口 = currentRange）
  const availability = ref<Record<string, ProbeAvailability>>({});
  // F7：30 天在线时段（daily 热力条 + 最近停机）
  const online = ref<OnlineHistory | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  // 本节点时序历史（CPU/内存/磁盘 IO/负载/温度/swap 六图），与全局 sparklines 解耦（见文件头）。
  const sparkRows = ref<SparklinePoint[]>([]);
  // 磁盘耗尽预测专用：固定 30d。切 range 时图表数据会变，但 ETA 必须基于 30d 长窗口，
  // 否则短窗口噪声会让「剩余天数」剧烈抖动，故与图表数据分开维护。
  const sparkRows30d = ref<SparklinePoint[]>([]);

  const currentRange = ref('1h');
  const chartRange = ref('realtime');

  // 实时模式：先用 1h 历史垫底，再每 10s 把 agent 快照追加到滚动窗口（保留 60 点）。
  const rtRows = ref<SparklinePoint[]>([]);
  let rtTimer: ReturnType<typeof setInterval> | null = null;
  // 实时启动的世代号：stopRealtime 自增，await 归来的旧启动必须放弃（防孤儿定时器）。
  let rtSeq = 0;

  // 自定义时间窗（浮层）
  const customOpen = ref(false);
  const customTarget = ref<'chart' | 'probes'>('chart');
  const customStart = ref('');
  const customEnd = ref('');
  const customChart = ref<{ start: string; end: string } | null>(null);
  const customProbes = ref<{ start: string; end: string } | null>(null);

  // 组件存活标志：startRealtime 的 await 期间可能已卸载/切换节点。
  let alive = true;

  function stopRealtime() {
    rtSeq += 1;
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
    const seq = rtSeq;
    const id = agentId.value;
    const sl = await publicApi.sparklines(id, '1h');
    // 垫底请求返回时可能已停轮询/切节点/切范围/卸载：不得写旧数据，更不得留下孤儿定时器。
    if (!alive || seq !== rtSeq || id !== agentId.value || chartRange.value !== 'realtime') return;
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
      // 图表数据按当前 chartRange 拉取；写入组件内 sparkRows，不用全局 state.sparklines。
      await loadSpark(chartRange.value);
      // 磁盘耗尽预测固定用 30d 长窗口，避免短窗口噪声导致 ETA 剧烈抖动。
      // 切 range 时不重拉这份。
      const sl30 = await publicApi.sparklines(id, '30d');
      if (!alive || id !== agentId.value) return;
      sparkRows30d.value = sl30?.[id] || [];
      // 对齐参考面板：初始拉当前 range，后端按 max_points 降采样返回。
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

  // 对齐参考面板：切 range 即打后端，后端按 max_points 降采样返回，每段 range 各自保证点数合适。
  // 范围切换竞态——请求序号丢弃过期响应（旧响应不得覆盖新范围数据）。
  let probesSeq = 0;

  async function loadProbes(range: string) {
    const id = agentId.value;
    const seq = ++probesSeq;
    const mp = RANGE_MAX_POINTS[range] ?? 3000;
    // custom 复用已选窗口；'custom' 不是后端合法 range，不能直接透传。
    const win = range === 'custom' ? customProbes.value : null;
    const data = await publicApi.probesDetailed(id, win ? undefined : range, mp, win || undefined);
    if (!alive || id !== agentId.value || seq !== probesSeq) return;
    probes.value = data?.series || {};
    availability.value = data?.availability || {};
  }

  // 切范围：置 loading → 打后端 → 取消 loading（loading 反馈掩盖网络延迟）
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

  async function applyCustom() {
    const start = new Date(customStart.value);
    const end = new Date(customEnd.value);
    const s = start.getTime();
    const e = end.getTime();
    if (!Number.isFinite(s) || !Number.isFinite(e) || !(e > s)) {
      error.value = t('node.custom.invalid');
      return;
    }
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

  // 图表/实时模式取数口径：实时模式用滚动窗口，其余用历史时序。
  const sparkline = computed(() => (chartRange.value === 'realtime' ? rtRows.value : sparkRows.value));

  return {
    RANGES,
    CHART_RANGES,
    probes,
    availability,
    online,
    loading,
    error,
    sparkRows,
    sparkRows30d,
    rtRows,
    sparkline,
    currentRange,
    chartRange,
    customOpen,
    customTarget,
    customStart,
    customEnd,
    customChart,
    customProbes,
    load,
    loadSpark,
    loadProbes,
    startRealtime,
    stopRealtime,
    appendRealtime,
    switchChartRange,
    switchRange,
    openCustom,
    applyCustom,
  };
}
