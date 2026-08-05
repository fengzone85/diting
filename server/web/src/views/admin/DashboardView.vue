<script setup lang="ts">
import StatCard from '../../components/ui/StatCard.vue';
import { useAdmin } from '../../composables/useAdmin';

const { state } = useAdmin();
</script>

<template>
  <div>
    <h1 class="mb-6 text-2xl font-bold">总览</h1>
    <div v-if="state.error" class="mb-6 rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-rose-200">
      {{ state.error }}
    </div>
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard label="受控端总数" :value="(state.overview?.total as number) ?? '-'" />
      <StatCard label="在线" :value="(state.overview?.online as number) ?? '-'" variant="success" />
      <StatCard label="离线" :value="(state.overview?.offline as number) ?? '-'" variant="danger" />
      <StatCard label="告警数" :value="state.alerts.length" variant="warning" />
    </div>
  </div>
</template>
