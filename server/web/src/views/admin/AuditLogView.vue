<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { adminApi, type AuditLogEntry } from '../../services/adminApi';
import { t } from '../../composables/useI18n';
import Loading from '../../components/ui/Loading.vue';
import EmptyState from '../../components/ui/EmptyState.vue';
import ErrorMessage from '../../components/ui/ErrorMessage.vue';

const logs = ref<AuditLogEntry[]>([]);
const total = ref(0);
const loading = ref(false);
const error = ref<string | null>(null);
const page = ref(0);
const pageSize = 50;

// action 枚举 → i18n key（未知 action 原样显示）
const ACTION_KEYS: Record<string, string> = {
  create_agent: 'audit.action.create_agent',
  update_agent: 'audit.action.update_agent',
  delete_agent: 'audit.action.delete_agent',
  reset_token: 'audit.action.reset_token',
  renew_agent: 'audit.action.renew_agent',
  update_settings: 'audit.action.update_settings',
  update_ai_config: 'audit.action.update_ai_config',
  ai_run: 'audit.action.ai_run',
  '2fa_enable': 'audit.action.2fa_enable',
  '2fa_disable': 'audit.action.2fa_disable',
};

async function load() {
  loading.value = true;
  error.value = null;
  try {
    const res = await adminApi.auditLogs(pageSize, page.value * pageSize);
    logs.value = res.logs;
    total.value = res.total;
  } catch (e) {
    error.value = (e as Error).message || t('common.error');
  } finally {
    loading.value = false;
  }
}

function fmtTime(ts: number) {
  const d = new Date(ts);
  return d.toLocaleString();
}

onMounted(load);
</script>

<template>
  <div>
    <h2 class="mb-4 text-xl font-semibold text-content">{{ t('audit.title') }}</h2>
    <ErrorMessage v-if="error" class="mb-4" :message="error" />
    <Loading v-if="loading && !logs.length" />
    <EmptyState v-else-if="!logs.length" />
    <div v-else class="space-y-3">
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-divider text-left text-muted">
              <th class="px-3 py-2">{{ t('audit.time') }}</th>
              <th class="px-3 py-2">{{ t('audit.actor') }}</th>
              <th class="px-3 py-2">IP</th>
              <th class="px-3 py-2">{{ t('audit.action') }}</th>
              <th class="px-3 py-2">{{ t('audit.detail') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="log in logs" :key="log.id" class="border-b border-divider hover:bg-surface">
              <td class="px-3 py-2 text-content whitespace-nowrap">{{ fmtTime(log.ts) }}</td>
              <td class="px-3 py-2 text-content">{{ log.admin }}</td>
              <td class="px-3 py-2 text-muted">{{ log.ip }}</td>
              <td class="px-3 py-2 text-content">{{ t(ACTION_KEYS[log.action] || log.action) }}</td>
              <td class="px-3 py-2 text-muted max-w-64 truncate">{{ log.detail }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="flex items-center justify-between text-sm text-muted">
        <span>{{ t('audit.total', { n: total }) }}</span>
        <div class="flex gap-2">
          <button
            class="rounded border border-divider px-3 py-1 hover:border-sky-500"
            :disabled="page === 0"
            @click="page--; load()"
          >{{ t('common.prevPage') }}</button>
          <button
            class="rounded border border-divider px-3 py-1 hover:border-sky-500"
            :disabled="(page + 1) * pageSize >= total"
            @click="page++; load()"
          >{{ t('common.nextPage') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>
