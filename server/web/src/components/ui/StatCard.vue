<script setup lang="ts">
interface Props {
  label: string;
  value: string | number;
  sub?: string;
  /** 双行紧凑型卡片（如实时流量）：主值降档字号，避免长数值在窄卡中拥挤 */
  compact?: boolean;
  /** 「谁大谁大」场景：副行放大字、主值收小字——位置不变，仅字号随活跃方向切换 */
  subBig?: boolean;
  variant?: 'default' | 'success' | 'warning' | 'danger';
  /** sm：前台总览这类「一排多张」的场景用更小的字与内边距；md 为默认（后台卡片） */
  size?: 'sm' | 'md';
  /** 双行上下分布：主值贴标题、副行贴卡底（用于「上行/下行」这类成对指标） */
  spread?: boolean;
  /** spread 专用：副行数值更大时为 true——副行加粗、主行常规（两行字号始终一致） */
  boldSub?: boolean;
}

const props = withDefaults(defineProps<Props>(), { variant: 'default', size: 'md' });

const variantClass = {
  default: 'border-divider',
  success: 'border-emerald-500/30 shadow-emerald-500/10',
  warning: 'border-amber-500/30 shadow-amber-500/10',
  danger: 'border-rose-500/30 shadow-rose-500/10',
}[props.variant];

const isSm = props.size === 'sm';
const padClass = isSm ? 'p-4' : 'p-5';
// 前台总览：标题加粗、数值常规字重（后台卡片维持原样式）
const labelClass = isSm ? 'text-xs font-semibold' : 'text-sm';
// spread（上行/下行成对指标）：两行字号一致，数值大的一行加粗、小的一行常规；
// 非 spread 时 sm 档主值统一 16px（此前紧凑卡降到 12px，和相邻卡片明显不一致）。
const spreadOn = props.spread === true;
const valueClass = spreadOn
  ? 'text-base'
  : isSm
    ? 'text-base'
    : (props.compact ? (props.subBig ? 'text-xs' : 'text-base') : 'text-2xl font-semibold');
const valueWeight = spreadOn
  ? (props.boldSub ? 'font-normal' : 'font-semibold')
  : (isSm ? 'font-normal' : '');
const subClass = spreadOn ? 'text-base' : (isSm ? 'text-xs' : (props.subBig ? 'text-base' : 'text-xs'));
const subWeight = spreadOn ? (props.boldSub ? 'font-semibold' : 'font-normal') : '';
</script>

<template>
  <!-- spread 时根容器纵向弹性布局：标题/主值在上，副行被 mt-auto 推到卡底 -->
  <div class="glass card-hover flex flex-col" :class="[padClass, variantClass]">
    <p :class="labelClass" class="shrink-0 text-secondary">{{ label }}</p>
    <p class="mt-1.5 shrink-0 text-content" :class="[valueClass, valueWeight]">{{ value }}</p>
    <p
      v-if="sub"
      class="text-secondary"
      :class="[subClass, subWeight, spread ? 'mt-auto pt-1.5' : 'mt-1']"
    >{{ sub }}</p>
  </div>
</template>
