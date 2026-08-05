<script setup lang="ts">
import AppHeader from '../components/AppHeader.vue';
import AppFooter from '../components/AppFooter.vue';
import NodeCard from '../components/NodeCard.vue';
import StatCard from '../components/ui/StatCard.vue';
import { useApp } from '../composables/useApp';

const { state } = useApp();
</script>

<template>
  <div class="min-h-screen">
    <AppHeader :title="state.meta?.site_title" />
    <main class="mx-auto max-w-7xl px-6">
      <div v-if="state.error" class="mb-6 rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-rose-200">
        {{ state.error }}
      </div>
      <div class="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="受控端总数" :value="state.overview?.total ?? '-'" variant="default" />
        <StatCard label="在线" :value="state.overview?.online ?? '-'" variant="success" />
        <StatCard label="离线" :value="state.overview?.offline ?? '-'" variant="danger" />
        <StatCard label="平均 CPU" :value="state.overview?.cpu_avg != null ? `${state.overview.cpu_avg.toFixed(1)}%` : '-'" variant="warning" />
      </div>
      <div class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        <NodeCard v-for="agent in state.agents" :key="agent.id" :agent="agent" />
      </div>
    </main>
    <AppFooter />
  </div>
</template>
