<script setup lang="ts">
// 节点列表表格：显示名称 / 国旗 / 客户端版本 / 分组 / 私有备注 / 账单 + 操作。
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import AgentBillingCard from '../AgentBillingCard.vue';
import { Delete, FileText, Refresh, Remind, Time } from '@icon-park/vue-next';
import { useI18n } from '../../../composables/useI18n';
import { formatBytes, formatDuration } from '../../../utils/format';
import { isOlderVersion } from '../../../utils/version';
import type { Agent, AgentVersionStatus, AgentVersionSummary } from '../../../services/types';

const props = defineProps<{
  agents: Agent[];
  selected: Set<string>;
  search: string;
  agentLatest: string;
  versionSummary: AgentVersionSummary | null;
}>();

defineEmits<{
  (e: 'toggle-one', id: string): void;
  (e: 'alert', a: Agent): void;
  (e: 'reset', id: string): void;
  (e: 'renew', id: string): void;
  (e: 'remove', id: string): void;
  (e: 'refresh'): void;
}>();

const router = useRouter();
const { t, locale } = useI18n();

// 列表行附加信息：分组（group/grp 两种字段名兼容）、agent 版本
const agentGroup = (a: Agent) => a.group || a.grp || '';
const agentVersion = (a: Agent) => (a.version ? `v${String(a.version).replace(/^v/i, '')}` : '');

const versionNodeMap = computed(
  () => new Map((props.versionSummary?.nodes || []).map((n) => [n.id, n]))
);
// 状态点配色：绿=已是期望版本 / 琥珀=落后 / 紫=管理员标注的定制构建 / 灰=未知
const STATUS_DOT: Record<AgentVersionStatus, string> = {
  up_to_date: 'bg-emerald-400',
  outdated: 'bg-amber-400',
  custom: 'bg-violet-400',
  unknown: 'bg-slate-600',
};
const STATUS_LABEL: Record<AgentVersionStatus, string> = {
  up_to_date: 'agents.versionUpToDate',
  outdated: 'agents.versionOutdated',
  custom: 'agents.versionCustom',
  unknown: 'agents.versionUnknown',
};
const agentVersionStatus = (a: Agent): AgentVersionStatus =>
  versionNodeMap.value.get(a.id)?.status || 'unknown';
const statusDot = (a: Agent) => STATUS_DOT[agentVersionStatus(a)];
const statusLabel = (a: Agent) => t(STATUS_LABEL[agentVersionStatus(a)]);

// 只有**确实低于**线上最新发布版才提示「可升级」。
// 早先用 `latest !== cur`，本地自建构建（如 1.1.4 > 线上 1.1.3）会被误报。
const isOutdated = (a: Agent) => isOlderVersion(a.version || '', props.agentLatest);

// 「位置」列：库里只存 ISO 3166-1 alpha-2 国家码，用 Intl.DisplayNames 反查当前语言下的地区名
const regionName = (code?: string) => {
  const cc = (code || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return '';
  try {
    return new Intl.DisplayNames([locale.value], { type: 'region' }).of(cc) || cc;
  } catch {
    return cc;
  }
};
</script>

<template>
  <div v-if="!agents.length" class="glass p-8 text-center text-sm">
    <span class="text-muted">{{ search ? t('agents.noMatch') : t('agents.empty') }}</span>
  </div>
  <!-- 表格形态（对齐参考面板后台服务器列表的列）：
       显示名称 / 国旗 / 客户端版本 / 分组 / 私有备注 / 账单 + 操作 -->
  <div v-else class="glass overflow-hidden">
    <div class="overflow-x-auto">
      <table class="w-full min-w-[900px] text-sm">
        <thead>
          <tr class="border-b border-slate-700 text-left text-xs text-muted">
            <th class="w-10 px-4 py-3"></th>
            <th class="px-3 py-3 font-medium">{{ t('agents.colName') }}</th>
            <th class="w-32 px-3 py-3 font-medium">{{ t('agents.colLocation') }}</th>
            <th class="w-28 px-3 py-3 font-medium">{{ t('agents.colVersion') }}</th>
            <th class="w-28 px-3 py-3 font-medium">{{ t('agents.colGroup') }}</th>
            <th class="px-3 py-3 font-medium">{{ t('agents.colNote') }}</th>
            <th class="w-16 px-3 py-3 font-medium">{{ t('agents.colBilling') }}</th>
            <th class="px-4 py-3 text-right font-medium">{{ t('agents.colActions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="agent in agents"
            :key="agent.id"
            class="border-b border-slate-800/60 last:border-0 hover:bg-slate-800/40"
            :class="selected.has(agent.id) ? 'bg-sky-500/5' : ''"
          >
            <td class="px-4 py-3 align-middle">
              <input type="checkbox" :checked="selected.has(agent.id)" @change="$emit('toggle-one', agent.id)" class="switch" />
            </td>
            <td class="px-3 py-3 align-middle">
              <div class="flex min-w-0 items-center gap-2">
                <span class="truncate font-semibold">{{ agent.name }}</span>
                <span v-if="agent.alert?.muted" class="shrink-0 rounded bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-normal text-rose-300">{{ t('common.muted') }}</span>
                <span v-else-if="agent.alert?.overridden" class="shrink-0 rounded bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-normal text-violet-300">{{ t('common.custom') }}</span>
              </div>
              <p class="truncate text-xs text-muted">{{ agent.id }} · {{ formatBytes(agent.latest?.mem_used) }} / {{ formatBytes(agent.latest?.mem_total) }} · {{ formatDuration(agent.latest?.uptime) }}</p>
            </td>
            <td class="px-3 py-3 align-middle">
              <div v-if="agent.country" class="flex items-center gap-2">
                <img
                  :src="`/flags/${agent.country.toLowerCase()}.svg`"
                  :alt="agent.country"
                  :title="agent.country.toUpperCase()"
                  class="h-4 w-6 flex-shrink-0 rounded-sm object-cover"
                  @error="(e) => ((e.target as HTMLImageElement).style.visibility = 'hidden')"
                />
                <span class="truncate text-xs text-secondary">{{ regionName(agent.country) }}</span>
              </div>
              <span v-else class="text-muted">—</span>
            </td>
            <td class="px-3 py-3 align-middle">
              <div v-if="agentVersion(agent)" class="flex items-center gap-1.5">
                <span class="rounded bg-slate-700/50 px-1.5 py-0.5 text-[11px] text-slate-300">{{ agentVersion(agent) }}</span>
                <!-- V 阶段：版本状态点（绿=已是期望版本 / 琥珀=落后 / 紫=定制 / 灰=未知） -->
                <span class="h-1.5 w-1.5 rounded-full" :class="statusDot(agent)" :title="statusLabel(agent)"></span>
              </div>
              <span v-else class="text-muted">—</span>
              <!-- 落后于最新 Release：整卡描边 + 徽标（比颜色更易读，色弱友好） -->
              <span
                v-if="isOutdated(agent)"
                class="ml-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-300 ring-1 ring-amber-400/40"
                :title="t('agent.upgradeAvailable') + ' ' + agentLatest"
              >{{ t('agent.upgradeBadge') }}</span>
            </td>
            <td class="px-3 py-3 align-middle">
              <span v-if="agentGroup(agent)" class="rounded bg-sky-500/15 px-1.5 py-0.5 text-[11px] text-sky-300">{{ agentGroup(agent) }}</span>
              <span v-else class="text-muted">—</span>
            </td>
            <td class="max-w-[220px] px-3 py-3 align-middle">
              <span v-if="agent.note" class="block truncate text-xs text-secondary" :title="agent.note">{{ agent.note }}</span>
              <span v-else class="text-muted">—</span>
            </td>
            <td class="px-3 py-3 align-middle">
              <!-- 账单：图标 + 弹出账单卡片（价格/货币/周期/到期时间含「长期」/自动续费） -->
              <AgentBillingCard :agent="agent" @saved="$emit('refresh')" />
            </td>
            <td class="px-4 py-3 align-middle">
              <div class="flex items-center justify-end gap-1">
                <button class="flex h-7 w-7 items-center justify-center rounded-lg text-secondary hover:bg-violet-500/10" :title="t('agents.alert')" :aria-label="t('agents.alert')" @click="$emit('alert', agent)">
                  <Remind :size="16" theme="outline" />
                </button>
                <button class="flex h-7 w-7 items-center justify-center rounded-lg text-secondary hover:bg-sky-500/10" :title="t('common.detail')" :aria-label="t('common.detail')" @click="router.push(`/admin/agents/${agent.id}`)">
                  <FileText :size="16" theme="outline" />
                </button>
                <button class="flex h-7 w-7 items-center justify-center rounded-lg text-secondary hover:bg-amber-500/10" :title="t('common.reset')" :aria-label="t('common.reset')" @click="$emit('reset', agent.id)">
                  <Refresh :size="16" theme="outline" />
                </button>
                <button class="flex h-7 w-7 items-center justify-center rounded-lg text-secondary hover:bg-emerald-500/10" :title="t('common.renew')" :aria-label="t('common.renew')" @click="$emit('renew', agent.id)">
                  <Time :size="16" theme="outline" />
                </button>
                <button class="flex h-7 w-7 items-center justify-center rounded-lg text-secondary hover:bg-rose-500/10" :title="t('common.delete')" :aria-label="t('common.delete')" @click="$emit('remove', agent.id)">
                  <Delete :size="16" theme="outline" />
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
