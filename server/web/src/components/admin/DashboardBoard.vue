<script setup lang="ts">
// 后台仪表盘看板（对齐 Komari 的仪表盘布局编辑器）：
// - 浏览态：「自定义」入口，卡片按保存的布局渲染
// - 编辑态：每张卡带工具条（拖拽手柄、卡名、宽度三档、高度三档、隐藏），
//   顶部工具条提供「恢复默认布局 / 选择卡片 / 取消 / 保存」
// - 选择卡片：弹窗内勾选全部可选卡片
// - 布局写入服务端 ui.admin_dashboard_layout，全局生效
// 卡片本体由父组件以「id + label + 组件」注入，本组件只管布局与交互。
import { computed, ref, watch } from 'vue';
import { GridFour, Refresh } from '@icon-park/vue-next';
import { adminApi } from '../../services/adminApi';
import { useI18n } from '../../composables/useI18n';
import type { DashboardWidgetDef } from './dashboard/widgets';
import type { DashboardLayoutItem, DashboardWidgetHeight, DashboardWidgetWidth } from '../../services/types';

const props = defineProps<{
  /** 全部可选卡片 */
  widgets: DashboardWidgetDef[];
  /** 服务端已保存的布局；null / undefined = 从未配置 → 默认布局 */
  model: DashboardLayoutItem[] | null;
  /** 默认布局包含的卡片（缺省为全部卡片） */
  defaultIds?: string[];
}>();

const emit = defineEmits<{ (e: 'saved', layout: DashboardLayoutItem[]): void }>();

const { t } = useI18n();

const WIDTH_OPTIONS: { value: DashboardWidgetWidth; label: string }[] = [
  { value: 'compact', label: 'dashboard.widthCompact' },
  { value: 'wide', label: 'dashboard.widthWide' },
  { value: 'full', label: 'dashboard.widthFull' },
];
const HEIGHT_OPTIONS: { value: DashboardWidgetHeight; label: string }[] = [
  { value: 'short', label: 'dashboard.heightShort' },
  { value: 'normal', label: 'dashboard.heightNormal' },
  { value: 'tall', label: 'dashboard.heightTall' },
];

// 列跨度与最小高度：compact/wide/full 对应 1/2/4 列（sm 下 1/2/2）
const WIDTH_CLASS: Record<DashboardWidgetWidth, string> = {
  compact: 'col-span-1',
  wide: 'sm:col-span-2',
  full: 'sm:col-span-2 lg:col-span-4',
};
const HEIGHT_CLASS: Record<DashboardWidgetHeight, string> = {
  short: 'min-h-[92px]',
  normal: 'min-h-[132px]',
  tall: 'min-h-[196px]',
};

const widgetMap = computed(() => new Map(props.widgets.map((w) => [w.id, w])));
const labelOf = (id: string) => widgetMap.value.get(id)?.label ?? id;

function defaultLayout(): DashboardLayoutItem[] {
  const byId = widgetMap.value;
  const ids = (props.defaultIds?.length ? props.defaultIds : props.widgets.map((w) => w.id))
    .filter((id) => byId.has(id));
  return ids.map((id) => {
    const w = byId.get(id)!;
    return { id, width: w.defaultWidth ?? 'compact', height: w.defaultHeight ?? 'short' };
  });
}

/** 清洗服务端布局：丢未知 id / 重复 id，非法档位回退默认档；null → 默认布局 */
function normalize(raw: DashboardLayoutItem[] | null | undefined): DashboardLayoutItem[] {
  if (!Array.isArray(raw)) return defaultLayout();
  const seen = new Set<string>();
  const out: DashboardLayoutItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const id = (item as DashboardLayoutItem).id;
    if (typeof id !== 'string' || !widgetMap.value.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      width: WIDTH_OPTIONS.some((o) => o.value === item.width) ? item.width : 'compact',
      height: HEIGHT_OPTIONS.some((o) => o.value === item.height) ? item.height : 'short',
    });
  }
  // 与 Komari 的 parseDashboardLayout 一致：传了内容但一条都不合法 → 回退默认布局，
  // 避免脏数据把看板变成永久空白；真正的空数组仍表示「用户清空了全部卡片」
  return raw.length > 0 && out.length === 0 ? defaultLayout() : out;
}

const draft = ref<DashboardLayoutItem[]>(normalize(props.model));
const editing = ref(false);
const choosing = ref(false);
const saving = ref(false);
const savedMsg = ref('');
const errMsg = ref('');
const dragIndex = ref<number | null>(null);
const overIndex = ref<number | null>(null);

// 非编辑态跟随服务端布局（10s 轮询会刷新 settings）；编辑态避免覆盖用户未保存的改动
watch(
  () => props.model,
  (v) => {
    if (!editing.value) draft.value = normalize(v);
  },
  { deep: true },
);

function startEdit() {
  draft.value = normalize(props.model);
  errMsg.value = '';
  savedMsg.value = '';
  editing.value = true;
}

function cancel() {
  draft.value = normalize(props.model);
  editing.value = false;
  errMsg.value = '';
}

function resetLayout() {
  draft.value = defaultLayout();
}

function has(id: string) {
  return draft.value.some((w) => w.id === id);
}

function toggleCard(id: string) {
  if (has(id)) {
    draft.value = draft.value.filter((w) => w.id !== id);
  } else {
    const w = widgetMap.value.get(id);
    draft.value = [...draft.value, {
      id,
      width: w?.defaultWidth ?? 'compact',
      height: w?.defaultHeight ?? 'short',
    }];
  }
}

function removeCard(id: string) {
  draft.value = draft.value.filter((w) => w.id !== id);
}

// ---- 拖拽排序（HTML5 DnD：仅编辑态、由手柄发起）----
function onDragStart(i: number, e: DragEvent) {
  dragIndex.value = i;
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(i));
    // 拖影用整张卡片，而不是那个小手柄
    const section = (e.currentTarget as HTMLElement | null)?.closest('section');
    if (section) e.dataTransfer.setDragImage(section, 24, 16);
  }
}
function onDragOver(i: number) {
  if (dragIndex.value === null) return;
  overIndex.value = i;
}
function onDragLeave(i: number) {
  if (overIndex.value === i) overIndex.value = null;
}
function onDrop(i: number) {
  const from = dragIndex.value;
  if (from === null || from === i) return;
  const next = [...draft.value];
  const [moved] = next.splice(from, 1);
  next.splice(i, 0, moved);
  draft.value = next;
  onDragEnd();
}
function onDragEnd() {
  dragIndex.value = null;
  overIndex.value = null;
}

async function save() {
  saving.value = true;
  errMsg.value = '';
  try {
    const r = await adminApi.saveDashboardLayout(draft.value);
    draft.value = normalize(r.layout);
    editing.value = false;
    savedMsg.value = t('dashboard.layoutSaved');
    setTimeout(() => { savedMsg.value = ''; }, 2500);
    emit('saved', r.layout);
  } catch (e) {
    errMsg.value = t('dashboard.layoutSaveFailed', { msg: (e as Error).message || t('common.unknownError') });
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div>
    <!-- 工具条 -->
    <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div class="flex flex-wrap items-center gap-2">
        <GridFour :size="16" class="text-slate-400" />
        <span class="text-sm font-medium text-slate-200">
          {{ editing ? t('dashboard.editing') : t('dashboard.workspace') }}
        </span>
        <span class="rounded-full border border-slate-700 px-2 py-0.5 text-[11px] tabular-nums text-slate-400">
          {{ draft.length }} / {{ widgets.length }}
        </span>
        <span v-if="savedMsg" class="text-xs text-emerald-400">{{ savedMsg }}</span>
        <span v-if="errMsg" class="text-xs text-rose-300">{{ errMsg }}</span>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <template v-if="editing">
          <button
            class="flex h-8 items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 text-xs text-slate-300 hover:border-slate-500 disabled:opacity-50"
            :disabled="saving"
            :title="t('dashboard.resetLayout')"
            @click="resetLayout"
          >
            <Refresh :size="14" />
            <span class="hidden sm:inline">{{ t('dashboard.resetLayout') }}</span>
          </button>
          <button
            class="flex h-8 items-center gap-1 rounded-lg border border-slate-700 px-2.5 text-xs text-slate-300 hover:border-slate-500 disabled:opacity-50"
            :disabled="saving"
            @click="choosing = true"
          >
            <span class="text-sm leading-none">＋</span>{{ t('dashboard.chooseCards') }}
          </button>
          <button
            class="h-8 rounded-lg border border-slate-700 px-3 text-xs text-slate-300 hover:border-slate-500 disabled:opacity-50"
            :disabled="saving"
            @click="cancel"
          >
            {{ t('dashboard.cancel') }}
          </button>
          <button
            class="h-8 rounded-lg bg-sky-600 px-3 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
            :disabled="saving"
            @click="save"
          >
            {{ saving ? t('dashboard.saving') : t('dashboard.save') }}
          </button>
        </template>
        <button
          v-else
          class="h-8 rounded-lg border border-slate-700 bg-slate-800/50 px-3 text-xs text-slate-200 hover:bg-slate-800"
          @click="startEdit"
        >
          {{ t('dashboard.customize') }}
        </button>
      </div>
    </div>

    <!-- 看板网格 -->
    <div v-if="draft.length" class="grid grid-cols-1 items-start gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <section
        v-for="(w, i) in draft"
        :key="w.id"
        class="min-w-0"
        :class="[
          WIDTH_CLASS[w.width],
          dragIndex !== null && dragIndex === i ? 'opacity-40' : '',
          overIndex === i && dragIndex !== i ? 'rounded-xl ring-2 ring-sky-500/60' : '',
        ]"
        @dragover.prevent="onDragOver(i)"
        @dragleave="onDragLeave(i)"
        @drop.prevent="onDrop(i)"
      >
        <div
          class="flex h-full flex-col rounded-xl"
          :class="editing ? 'ring-1 ring-sky-500/25' : ''"
        >
          <!-- 编辑态：每卡工具条 -->
          <div
            v-if="editing"
            class="flex items-center gap-1.5 rounded-t-xl border-b border-slate-700/60 bg-slate-800/50 px-2 py-1.5"
          >
            <span
              class="cursor-grab select-none text-sm leading-none text-slate-500 active:cursor-grabbing"
              draggable="true"
              :title="t('dashboard.moveCard', { name: labelOf(w.id) })"
              @dragstart="onDragStart(i, $event)"
              @dragend="onDragEnd"
            >⠿</span>
            <span class="min-w-0 flex-1 truncate text-[11px] text-slate-300">{{ labelOf(w.id) }}</span>
            <select
              v-model="w.width"
              class="h-6 rounded border border-slate-700 bg-slate-900 px-1 text-[10px] text-slate-300 outline-none focus:border-sky-500"
              :title="t('dashboard.cardWidth')"
            >
              <option v-for="o in WIDTH_OPTIONS" :key="o.value" :value="o.value">{{ t(o.label) }}</option>
            </select>
            <select
              v-model="w.height"
              class="h-6 rounded border border-slate-700 bg-slate-900 px-1 text-[10px] text-slate-300 outline-none focus:border-sky-500"
              :title="t('dashboard.cardHeight')"
            >
              <option v-for="o in HEIGHT_OPTIONS" :key="o.value" :value="o.value">{{ t(o.label) }}</option>
            </select>
            <button
              class="rounded px-1 text-sm leading-none text-slate-500 hover:text-rose-300"
              :title="t('dashboard.hideCard', { name: labelOf(w.id) })"
              @click="removeCard(w.id)"
            >×</button>
          </div>

          <div class="flex-1" :class="HEIGHT_CLASS[w.height]">
            <component
              :is="widgetMap.get(w.id)?.component"
              v-if="widgetMap.get(w.id)"
              v-bind="widgetMap.get(w.id)?.props"
            />
          </div>
        </div>
      </section>
    </div>

    <!-- 空看板 -->
    <div
      v-else
      class="flex min-h-[220px] flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-slate-700 text-sm text-slate-500"
    >
      <GridFour :size="26" class="text-slate-600" />
      <span>{{ t('dashboard.layoutEmpty') }}</span>
      <button
        class="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-800"
        @click="startEdit(); choosing = true"
      >
        ＋ {{ t('dashboard.chooseCards') }}
      </button>
    </div>

    <!-- 选择卡片 -->
    <div
      v-if="choosing"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      @click.self="choosing = false"
    >
      <div class="w-full max-w-md rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
        <h3 class="text-base font-semibold text-slate-100">{{ t('dashboard.chooseCards') }}</h3>
        <p class="mt-1 text-xs text-slate-500">{{ t('dashboard.selectedCards', { n: draft.length }) }}</p>
        <div class="mt-3 max-h-[55vh] overflow-y-auto">
          <label
            v-for="w in widgets"
            :key="w.id"
            class="flex cursor-pointer items-center gap-3 border-b border-slate-800 px-1.5 py-2.5 last:border-0"
          >
            <input
              type="checkbox"
              class="h-4 w-4 accent-sky-500"
              :checked="has(w.id)"
              @change="toggleCard(w.id)"
            />
            <span class="text-sm text-slate-300">{{ w.label }}</span>
          </label>
        </div>
        <div class="mt-4 flex justify-end">
          <button
            class="rounded-lg bg-slate-800 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-700"
            @click="choosing = false"
          >
            {{ t('dashboard.done') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
