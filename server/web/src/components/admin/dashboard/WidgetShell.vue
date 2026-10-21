<script setup lang="ts">
// 仪表盘卡片外壳：统一的标题栏 + 内容区，保证不同卡片的留白与字号一致
import type { Component } from 'vue';

defineProps<{
  title: string;
  icon?: Component;
}>();
</script>

<template>
  <div class="glass flex h-full flex-col overflow-hidden p-4">
    <div class="mb-2.5 flex shrink-0 items-center gap-2">
      <component :is="icon" v-if="icon" :size="16" class="text-slate-400" />
      <span class="truncate text-sm font-semibold text-slate-200">{{ title }}</span>
      <slot name="extra" />
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto pr-0.5">
      <slot />
    </div>
  </div>
</template>
