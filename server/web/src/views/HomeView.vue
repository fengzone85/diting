<script setup lang="ts">
import { ref, watch } from 'vue';
import AppHeader from '../components/AppHeader.vue';
import AppFooter from '../components/AppFooter.vue';
import NodeCard from '../components/NodeCard.vue';
import NodeRow from '../components/NodeRow.vue';
import StatCard from '../components/ui/StatCard.vue';
import { useApp } from '../composables/useApp';
import type { Agent } from '../services/types';

const { state, visibleAgents, groupedAgents, setLayout, setTemplate, setSearch, reorderAgents } = useApp();

const searchInput = ref(state.search);
watch(searchInput, (v) => setSearch(v));

const dragId = ref<string | null>(null);
const dragOverId = ref<string | null>(null);

function onDragStart(agent: Agent, e: DragEvent) {
  dragId.value = agent.id;
  (e.dataTransfer as DataTransfer).effectAllowed = 'move';
  try {
    (e.dataTransfer as DataTransfer).setData('text/plain', agent.id);
  } catch {}
}
function onDragEnd() {
  dragId.value = null;
  dragOverId.value = null;
}
function onDragOver(agent: Agent, e: DragEvent) {
  e.preventDefault();
  if (!dragId.value || dragId.value === agent.id) return;
  dragOverId.value = agent.id;
}
function onDrop(target: Agent, e: DragEvent) {
  e.preventDefault();
  if (!dragId.value || dragId.value === target.id) return;
  const ids = visibleAgents.value.map((a) => a.id);
  const from = ids.indexOf(dragId.value);
  const to = ids.indexOf(target.id);
  if (from < 0 || to < 0) return;
  ids.splice(from, 1);
  ids.splice(to, 0, dragId.value);
  reorderAgents(ids);
  dragId.value = null;
  dragOverId.value = null;
}

function groupOrder(groups: Record<string, Agent[]>) {
  return Object.keys(groups).sort((a, b) => a.localeCompare(b));
}
</script>

<template>
  <div class="min-h-screen">
    <AppHeader :title="state.meta?.site_title" :meta="state.meta" />
    <main class="mx-auto max-w-7xl px-4 sm:px-6">
      <div v-if="state.error" class="mb-6 rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-rose-200">
        {{ state.error }}
      </div>

      <div class="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="受控端总数" :value="state.overview?.total ?? '-'" variant="default" />
        <StatCard label="在线" :value="state.overview?.online ?? '-'" variant="success" />
        <StatCard label="离线" :value="state.overview?.offline ?? '-'" variant="danger" />
        <StatCard label="平均 CPU" :value="state.overview?.cpu_avg != null ? `${state.overview.cpu_avg.toFixed(1)}%` : '-'" variant="warning" />
      </div>

      <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div class="flex items-center gap-2">
          <input
            v-model="searchInput"
            placeholder="搜索节点 / 分组 / 商家..."
            class="w-48 rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-white outline-none focus:border-sky-500 sm:w-64"
          />
          <span class="text-xs text-slate-500">{{ visibleAgents.length }} 个节点</span>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-xs text-slate-500">布局</span>
          <button
            v-for="l in ['grid', 'list', 'compact'] as const"
            :key="l"
            class="rounded-lg border px-2 py-1 text-xs"
            :class="state.layout === l ? 'border-sky-500 bg-sky-500/20 text-sky-300' : 'border-slate-700 text-slate-400 hover:border-slate-500'"
            @click="setLayout(l)"
          >
            {{ l === 'grid' ? '网格' : l === 'list' ? '列表' : '紧凑' }}
          </button>
          <span class="ml-2 text-xs text-slate-500">卡片</span>
          <button
            v-for="t in ['simple', 'visual'] as const"
            :key="t"
            class="rounded-lg border px-2 py-1 text-xs"
            :class="state.template === t ? 'border-sky-500 bg-sky-500/20 text-sky-300' : 'border-slate-700 text-slate-400 hover:border-slate-500'"
            @click="setTemplate(t)"
          >
            {{ t === 'simple' ? '简约' : '完整' }}
          </button>
        </div>
      </div>

      <div v-if="!state.initialized && state.loading" class="py-12 text-center text-slate-400">加载中...</div>
      <div v-else-if="visibleAgents.length === 0" class="py-12 text-center text-slate-500">暂无数据</div>

      <template v-else>
        <div v-if="state.layout === 'list'" class="space-y-2">
          <NodeRow v-for="agent in visibleAgents" :key="agent.id" :agent="agent" />
        </div>

        <template v-else>
          <div v-for="group in groupOrder(groupedAgents)" :key="group" class="mb-6">
            <h3 class="mb-3 text-sm font-semibold text-slate-400">{{ group }}</h3>
            <div
              class="grid gap-4"
              :class="{
                'grid-cols-1 md:grid-cols-2 xl:grid-cols-3': state.layout === 'grid',
                'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5': state.layout === 'compact',
              }"
            >
              <NodeCard
                v-for="agent in groupedAgents[group]"
                :key="agent.id"
                :agent="agent"
                :template="state.template"
                :draggable="true"
                :class="{ 'opacity-50': dragOverId === agent.id && dragId !== agent.id }"
                @dragstart="onDragStart(agent, $event)"
                @dragend="onDragEnd"
                @dragover="onDragOver(agent, $event)"
                @drop="onDrop(agent, $event)"
              />
            </div>
          </div>
        </template>
      </template>
    </main>
    <AppFooter :meta="state.meta" />
  </div>
</template>
