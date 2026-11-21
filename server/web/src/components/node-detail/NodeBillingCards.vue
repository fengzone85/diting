<script setup lang="ts">
// 顶部计费四卡：节点价格 / 月均支出 / 剩余时间 / 剩余价值（对齐参考面板顶部统计卡）。
import { computed, markRaw } from 'vue';
import { Ticket, ShoppingBag, Time, Wallet } from '@icon-park/vue-next';
import { t } from '../../composables/useI18n';
import { formatCurrency, formatRemaining } from '../../utils/format';
import type { Agent } from '../../services/types';

const props = defineProps<{ agent: Agent }>();

const billingCards = computed(() => {
  const a = props.agent;
  const price = typeof a.price === 'number' ? a.price : null;
  const cycle = typeof a.billing_cycle === 'number' && a.billing_cycle > 0 ? a.billing_cycle : null;
  const currency = a.currency || '¥';
  const monthly = price != null && cycle != null ? price / cycle : null;
  const rem = formatRemaining(a.expire_at);
  // 剩余价值：优先用服务端计算结果（server/src/billing.js，参考面板口径
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

// 剩余时间状态对应的文字颜色（对齐参考面板：过期/紧急红、警告橙、长期灰、正常绿）
const remainingStatusClass: Record<string, string> = {
  expired: 'text-rose-400',
  critical: 'text-rose-400',
  warning: 'text-orange-400',
  long_term: 'text-muted-foreground',
  normal: 'text-emerald-400',
};
</script>

<template>
  <!-- 顶部计费四卡：节点价格 / 月均支出 / 剩余时间 / 剩余价值（对齐参考面板顶部统计卡，统一毛玻璃） -->
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
</template>
