<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { adminApi, type AuditLogEntry } from '../../services/adminApi';
import Loading from '../../components/ui/Loading.vue';
import EmptyState from '../../components/ui/EmptyState.vue';
import ErrorMessage from '../../components/ui/ErrorMessage.vue';

const logs = ref<AuditLogEntry[]>([]);
const total = ref(0);
const loading = ref(false);
const error = ref<string | null>(null);
const page = ref(0);
const pageSize = 50;

const actionLabels: Record<string, string> = {
  create_agent: '创建受控端',
  update_agent: '编辑受控端',
  delete_agent: '删除受控端',
  reset_token: '重置 Token',
  renew_agent: '续期',
  update_settings: '修改设置',
  update_ai_config: '修改 AI 配置',
  ai_run: '执行 AI 分析',
  '2fa_enable': '启用 2FA',
  '2fa_disable': '停用 2FA',
};

async function load() {
  loading.value = true;
  error.value = null;
  try {
    const res = await adminApi.auditLogs(pageSize, page.value * pageSize);
    logs.value = res.logs;
    total.value = res.total;
  } catch (e) {
    error.value = (e as Error).message || '加载失败';
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
    <h2 class="mb-4 text-xl font-semibold text-content">操作审计日志</h2>
    <ErrorMessage v-if="error" class="mb-4" :message="error" />
    <Loading v-if="loading && !logs.length" />
    <EmptyState v-else-if="!logs.length" />
    <div v-else class="space-y-3">
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-divider text-left text-muted">
              <th class="px-3 py-2">时间</th>
              <th class="px-3 py-2">操作者</th>
              <th class="px-3 py-2">IP</th>
              <th class="px-3 py-2">操作</th>
              <th class="px-3 py-2">详情</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="log in logs" :key="log.id" class="border-b border-divider hover:bg-surface">
              <td class="px-3 py-2 text-content whitespace-nowrap">{{ fmtTime(log.ts) }}</td>
              <td class="px-3 py-2 text-content">{{ log.admin }}</td>
              <td class="px-3 py-2 text-muted">{{ log.ip }}</td>
              <td class="px-3 py-2 text-content">{{ actionLabels[log.action] || log.action }}</td>
              <td class="px-3 py-2 text-muted max-w-64 truncate">{{ log.detail }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="flex items-center justify-between text-sm text-muted">
        <span>共 {{ total }} 条</span>
        <div class="flex gap-2">
          <button
            class="rounded border border-divider px-3 py-1 hover:border-sky-500"
            :disabled="page === 0"
            @click="page--; load()"
          >上一页</button>
          <button
            class="rounded border border-divider px-3 py-1 hover:border-sky-500"
            :disabled="(page + 1) * pageSize >= total"
            @click="page++; load()"
          >下一页</button>
        </div>
      </div>
    </div>
  </div>
</template>
