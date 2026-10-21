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
// sm 档所有卡片主值统一 16px（此前紧凑卡降到 12px，和相邻卡片明显不一致）；
// 只有「subBig」这一个历史场景保留一档差异。
const valueClass = isSm
  ? (props.subBig ? 'text-sm' : 'text-base')
  : (props.compact ? (props.subBig ? 'text-xs' : 'text-base') : 'text-2xl font-semibold');
// sm 档数值不加粗，用 align 后的常规字重保证「↓1.2M/s ↑340K/s」这类横排不被撑满
const valueWeight = isSm ? 'font-normal' : '';
const subClass = isSm
  ? (props.subBig ? 'text-sm' : 'text-xs')
  : (props.subBig ? 'text-base' : 'text-xs');
</script>

<template>
  <div class="glass card-hover" :class="[padClass, variantClass]">
    <p :class="labelClass" class="text-secondary">{{ label }}</p>
    <p class="mt-1.5 text-content" :class="[valueClass, valueWeight]">{{ value }}</p>
    <p v-if="sub" class="mt-1 text-secondary" :class="subClass">{{ sub }}</p>
  </div>
</template>
