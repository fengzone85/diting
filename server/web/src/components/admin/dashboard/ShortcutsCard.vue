<script setup lang="ts">
// 快捷操作卡（对齐 Komari 的 shortcuts 卡）：常用后台页面直达
import { ChartLine, FileText, Link, Remind, Server, SettingTwo } from '@icon-park/vue-next';
import WidgetShell from './WidgetShell.vue';
import { useI18n } from '../../../composables/useI18n';

defineProps<{ title: string }>();

const { t } = useI18n();

const links = [
  { to: '/admin/agents', icon: Server, label: 'nav.agents' },
  { to: '/admin/billing', icon: ChartLine, label: 'nav.billing' },
  { to: '/admin/ai', icon: Remind, label: 'nav.ai' },
  { to: '/admin/audit-logs', icon: FileText, label: 'nav.auditLogs' },
  { to: '/admin/api-tokens', icon: Link, label: 'nav.apiTokens' },
  { to: '/admin/settings', icon: SettingTwo, label: 'nav.settings' },
] as const;
</script>

<template>
  <WidgetShell :title="title" :icon="Link">
    <div class="space-y-0.5">
      <router-link
        v-for="l in links"
        :key="l.to"
        :to="l.to"
        class="flex items-center gap-2 rounded-lg px-1.5 py-1.5 text-xs text-slate-300 hover:bg-slate-700/40 hover:text-white"
      >
        <component :is="l.icon" :size="15" class="text-slate-400" />
        <span class="flex-1 truncate">{{ t(l.label) }}</span>
        <span class="text-slate-500">›</span>
      </router-link>
    </div>
  </WidgetShell>
</template>
