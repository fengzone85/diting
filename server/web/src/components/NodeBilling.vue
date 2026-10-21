<script setup lang="ts">
// 服务端列表里的「账单」入口：卡片上一个账单图标/价格胶囊，点击弹出账单卡片。
// 字段口径与节点详情页顶部计费卡（NodeDetailView.billingCards，对齐 Komari）一致：
// 价格 / 月均支出 / 剩余时间 / 剩余价值，另加计费周期与到期时间。
import { computed, nextTick, onBeforeUnmount, ref } from 'vue';
import { Ticket } from '@icon-park/vue-next';
import type { Agent } from '../services/types';
import { formatCurrency, formatRemaining } from '../utils/format';
import { useI18n } from '../composables/useI18n';

const { t } = useI18n();

const props = defineProps<{
  agent: Agent;
  /** 紧凑形态（列表行）：只显示图标按钮，保证行内网格不被挤压 */
  compact?: boolean;
}>();

const price = computed(() => (typeof props.agent.price === 'number' ? props.agent.price : null));
// 0 元与未填写在数据层无法区分，统一按「免费」呈现（与总览「月度费用」口径一致）
const isFree = computed(() => price.value == null || price.value <= 0);
const cycle = computed(() => {
  const c = props.agent.billing_cycle;
  return typeof c === 'number' && c > 0 ? c : null;
});
const currency = computed(() => props.agent.currency || '¥');
const monthly = computed(() => (price.value != null && cycle.value ? price.value / cycle.value : null));
const remaining = computed(() => formatRemaining(props.agent.expire_at));
// 剩余价值 = 剩余月数 × 月均支出（与详情页同口径）
const remainingValue = computed(() => {
  if (monthly.value == null || !props.agent.expire_at) return null;
  const exp = new Date(props.agent.expire_at).getTime();
  if (Number.isNaN(exp)) return null;
  const months = (exp - Date.now()) / (86400000 * 30);
  return months > 0 ? monthly.value * months : null;
});
const remainingClass = computed(() => {
  switch (remaining.value.status) {
    case 'expired':
    case 'critical':
      return 'text-rose-400';
    case 'warning':
      return 'text-amber-400';
    case 'long_term':
      return 'text-slate-400';
    default:
      return 'text-emerald-400';
  }
});
const priceText = computed(() => (isFree.value ? t('public.free') : formatCurrency(price.value!, currency.value)));
const monthlyText = computed(() => {
  if (isFree.value) return t('public.free');
  return monthly.value != null ? `${formatCurrency(monthly.value, currency.value)} ${t('billing.perMonth')}` : '—';
});
const rows = computed(() => [
  { key: 'price', label: t('node.billing.nodePrice'), value: priceText.value, cls: isFree.value ? 'text-emerald-400' : 'text-content' },
  { key: 'cycle', label: t('agent.billingCycle'), value: cycle.value != null ? t('node.daysCycle', { n: cycle.value }) : '—', cls: 'text-content' },
  { key: 'monthly', label: t('node.billing.monthlyCost'), value: monthlyText.value, cls: 'text-content' },
  { key: 'expire', label: t('node.expireAt'), value: props.agent.expire_at || '—', cls: 'text-content' },
  { key: 'remaining', label: t('node.billing.remainingTime'), value: remaining.value.text, cls: remainingClass.value },
  { key: 'value', label: t('node.billing.remainingValue'), value: remainingValue.value != null ? formatCurrency(remainingValue.value, currency.value) : '—', cls: 'text-content' },
]);

const open = ref(false);
const trigger = ref<HTMLElement | null>(null);
const pop = ref<HTMLElement | null>(null);
const pos = ref({ top: 0, left: 0 });
const CARD_W = 232;

function measure() {
  const r = trigger.value?.getBoundingClientRect();
  if (!r) return;
  const h = pop.value?.offsetHeight || 210;
  let left = r.right - CARD_W;
  left = Math.max(8, Math.min(left, window.innerWidth - CARD_W - 8));
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
  pos.value = { top, left };
}

async function toggle() {
  open.value = !open.value;
  if (open.value) {
    await nextTick();
    measure();
  }
}

function onDocPointerDown(e: PointerEvent) {
  if (!open.value) return;
  const el = e.target as Node | null;
  if (el && (trigger.value?.contains(el) || pop.value?.contains(el))) return;
  open.value = false;
}

function onDocKeydown(e: KeyboardEvent) {
  if (open.value && e.key === 'Escape') open.value = false;
}

function onViewportChange() {
  if (open.value) measure();
}

// 弹层 Teleport 到 body：卡片本身 overflow:hidden，内联渲染会被裁掉
document.addEventListener('pointerdown', onDocPointerDown, true);
document.addEventListener('keydown', onDocKeydown);
window.addEventListener('scroll', onViewportChange, true);
window.addEventListener('resize', onViewportChange);

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointerDown, true);
  document.removeEventListener('keydown', onDocKeydown);
  window.removeEventListener('scroll', onViewportChange, true);
  window.removeEventListener('resize', onViewportChange);
});
</script>

<template>
  <!-- 外层通常是 RouterLink：必须 stop + prevent，避免点账单图标时跳到节点详情 -->
  <button
    ref="trigger"
    type="button"
    class="inline-flex items-center gap-1 rounded-full bg-slate-500/10 leading-tight text-muted-foreground transition-colors hover:bg-slate-500/20"
    :class="compact ? 'h-5 w-5 justify-center p-0' : 'shrink-0 px-2 py-0.5 text-[11px]'"
    :aria-expanded="open"
    :aria-label="t('billing.title')"
    @click.stop.prevent="toggle"
  >
    <Ticket :size="compact ? 12 : 11" theme="outline" />
    <span v-if="!compact">{{ priceText }}</span>
  </button>

  <Teleport to="body">
    <div
      v-if="open"
      ref="pop"
      class="billing-pop fixed z-[90] rounded-xl p-3 text-xs"
      :style="{ top: `${pos.top}px`, left: `${pos.left}px`, width: `${CARD_W}px` }"
      @click.stop.prevent
    >
      <div class="mb-2 flex items-center gap-1.5 text-[11px] font-semibold text-secondary">
        <Ticket :size="12" theme="outline" />
        {{ t('billing.title') }}
      </div>
      <div
        v-for="row in rows"
        :key="row.key"
        class="flex items-center justify-between gap-3 py-[3px]"
      >
        <span class="shrink-0 text-muted">{{ row.label }}</span>
        <span class="truncate font-medium tabular-nums" :class="row.cls">{{ row.value }}</span>
      </div>
    </div>
  </Teleport>
</template>
