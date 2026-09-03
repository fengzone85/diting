<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { adminApi } from '../../services/adminApi';
import { t } from '../../composables/useI18n';
import type { Billing } from '../../services/types';
import Loading from '../../components/ui/Loading.vue';
import ErrorMessage from '../../components/ui/ErrorMessage.vue';

const data = ref<Billing | null>(null);
const loading = ref(true);
const error = ref('');

onMounted(async () => {
  loading.value = true;
  try {
    data.value = await adminApi.billingOverview();
  } catch (e) {
    error.value = (e as Error).message || t('billing.loadFailed');
  } finally {
    loading.value = false;
  }
});

function formatDate(days: number) {
  if (days <= 0) return t('billing.expired');
  if (days === 1) return t('billing.expireTomorrow');
  return t('billing.expireInDays', { n: days });
}
</script>

<template>
  <div>
    <h1 class="mb-6 text-2xl font-bold">{{ t('billing.title') }}</h1>
    <Loading v-if="loading" />
    <ErrorMessage v-else-if="error" :message="error" />
    <div v-else-if="data" class="grid gap-6">
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div class="glass p-5">
          <p class="text-sm text-slate-400">{{ t('billing.monthlyTotal') }}</p>
          <p class="mt-1 text-3xl font-bold text-emerald-400">{{ data.currency }}{{ data.monthly_total.toFixed(2) }}</p>
        </div>
        <div class="glass p-5">
          <p class="text-sm text-slate-400">{{ t('billing.agentCount') }}</p>
          <p class="mt-1 text-3xl font-bold text-sky-400">{{ data.agent_count }}</p>
        </div>
        <div class="glass p-5">
          <p class="text-sm text-slate-400">{{ t('billing.expire7d') }}</p>
          <p class="mt-1 text-3xl font-bold" :class="data.expiring_soon.length ? 'text-amber-400' : 'text-slate-200'">{{ data.expiring_soon.length }}</p>
        </div>
      </div>

      <div class="glass p-6">
        <h2 class="mb-4 text-lg font-semibold">{{ t('billing.perGroupMonthly') }}</h2>
        <div v-if="!data.per_group.length" class="py-8 text-center text-sm text-slate-500">{{ t('billing.noGroupData') }}</div>
        <div v-else class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-slate-700 text-left text-slate-400">
                <th class="py-2 font-medium">{{ t('billing.group') }}</th>
                <th class="py-2 font-medium text-right">{{ t('billing.monthlyAvg') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="g in data.per_group" :key="g.name" class="border-b border-slate-800">
                <td class="py-3">{{ g.name || t('billing.ungrouped') }}</td>
                <td class="py-3 text-right font-mono">{{ data.currency }}{{ g.cost.toFixed(2) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="glass p-6">
        <h2 class="mb-4 text-lg font-semibold">{{ t('billing.expiringSoon') }}</h2>
        <div v-if="!data.expiring_soon.length" class="py-8 text-center text-sm text-slate-500">{{ t('billing.noExpiring') }}</div>
        <div v-else class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-slate-700 text-left text-slate-400">
                <th class="py-2 font-medium">{{ t('billing.machine') }}</th>
                <th class="py-2 font-medium">{{ t('billing.timeLeft') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="a in data.expiring_soon" :key="a.id" class="border-b border-slate-800">
                <td class="py-3">
                  <router-link :to="`/admin/agents/${encodeURIComponent(a.id)}`" class="text-sky-400 hover:underline">{{ a.name }}</router-link>
                </td>
                <td class="py-3">
                  <span :class="a.days_left <= 3 ? 'text-rose-400' : 'text-amber-400'">{{ formatDate(a.days_left) }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>