<script setup lang="ts">
interface Props {
  label: string;
  value: string | number;
  sub?: string;
  variant?: 'default' | 'success' | 'warning' | 'danger';
}

const props = withDefaults(defineProps<Props>(), { variant: 'default' });

const variantClass = {
  default: 'border-divider',
  success: 'border-emerald-500/30 shadow-emerald-500/10',
  warning: 'border-amber-500/30 shadow-amber-500/10',
  danger: 'border-rose-500/30 shadow-rose-500/10',
}[props.variant];
</script>

<template>
  <div class="glass card-hover p-5" :class="variantClass">
    <p class="text-sm text-secondary">{{ label }}</p>
    <p class="mt-2 text-2xl font-semibold text-content">{{ value }}</p>
    <p v-if="sub" class="mt-1 text-xs text-secondary">{{ sub }}</p>
  </div>
</template>
