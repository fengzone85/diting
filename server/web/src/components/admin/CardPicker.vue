<script setup lang="ts">
// 后台仪表盘「可选择多卡片」选择器（对齐 Komari 后台仪表盘的多卡片做法）：
// 图标按钮 + 弹出面板，勾选要显示的卡片、↑↓ 调整顺序，应用后写入服务端 ui.admin_card_keys。
// 选择结果由父组件保存（全局配置，管理员配一次全站生效）。
import { ref, watch } from 'vue';
import { ArrowDown, ArrowUp, SettingTwo } from '@icon-park/vue-next';
import { useI18n } from '../../composables/useI18n';

interface Option {
  key: string;
  label: string;
}

const props = defineProps<{
  /** 当前生效的卡片键（顺序即渲染顺序） */
  model: string[];
  /** 全量可选项，顺序为面板中的固定展示顺序 */
  options: Option[];
  /** 保存中：禁用应用按钮，避免重复提交 */
  saving?: boolean;
}>();

const emit = defineEmits<{ (e: 'apply', keys: string[]): void }>();

const { t } = useI18n();
const open = ref(false);
// 草稿：面板打开时从 model 复制，关闭时丢弃未应用的改动
const draft = ref<string[]>([]);

watch(
  () => props.model,
  (v) => {
    if (!open.value) draft.value = [...v];
  },
  { immediate: true },
);

function toggleOpen() {
  open.value = !open.value;
  if (open.value) draft.value = [...props.model];
}

const isOn = (key: string) => draft.value.includes(key);
const orderNo = (key: string) => draft.value.indexOf(key) + 1;

function toggle(key: string) {
  if (isOn(key)) {
    // 至少保留一张：全不选会让仪表盘整块空白，且看不出是配置问题
    if (draft.value.length <= 1) return;
    draft.value = draft.value.filter((k) => k !== key);
  } else {
    draft.value = [...draft.value, key];
  }
}

function move(key: string, dir: -1 | 1) {
  const i = draft.value.indexOf(key);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= draft.value.length) return;
  const next = [...draft.value];
  next[i] = next[j];
  next[j] = key;
  draft.value = next;
}

function reset() {
  draft.value = props.options.map((o) => o.key);
}

function apply() {
  emit('apply', [...draft.value]);
  open.value = false;
}
</script>

<template>
  <div class="relative">
    <button
      class="flex h-8 items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 text-xs text-slate-400 hover:border-slate-500 hover:text-slate-200"
      :title="t('dashboard.cards')"
      @click="toggleOpen"
    >
      <SettingTwo :size="15" />
      <span class="hidden sm:inline">{{ t('dashboard.cards') }}</span>
    </button>

    <template v-if="open">
      <!-- 点击面板外关闭（未应用的改动直接丢弃） -->
      <div class="fixed inset-0 z-30" @click="open = false"></div>
      <div class="absolute right-0 z-40 mt-2 w-64 rounded-xl border border-slate-700 bg-slate-900 p-3 shadow-2xl">
        <p class="text-xs font-semibold text-slate-200">{{ t('dashboard.cardsTitle') }}</p>
        <p class="mt-1 text-[11px] leading-4 text-slate-500">{{ t('dashboard.cardsHint') }}</p>

        <div class="mt-2 max-h-72 space-y-0.5 overflow-auto">
          <div
            v-for="o in options"
            :key="o.key"
            class="flex items-center gap-2 rounded-lg px-1.5 py-1"
            :class="isOn(o.key) ? 'bg-slate-800/60' : ''"
          >
            <input
              type="checkbox"
              class="h-3.5 w-3.5 shrink-0 accent-sky-500"
              :checked="isOn(o.key)"
              @change="toggle(o.key)"
            />
            <span class="flex-1 truncate text-xs" :class="isOn(o.key) ? 'text-slate-200' : 'text-slate-500'">
              {{ o.label }}
            </span>
            <template v-if="isOn(o.key)">
              <span class="w-4 text-right text-[10px] tabular-nums text-slate-500">{{ orderNo(o.key) }}</span>
              <button
                class="rounded p-0.5 text-slate-500 hover:text-slate-200 disabled:opacity-30"
                :disabled="orderNo(o.key) === 1"
                :title="t('dashboard.cardsUp')"
                @click="move(o.key, -1)"
              >
                <ArrowUp :size="12" />
              </button>
              <button
                class="rounded p-0.5 text-slate-500 hover:text-slate-200 disabled:opacity-30"
                :disabled="orderNo(o.key) === draft.length"
                :title="t('dashboard.cardsDown')"
                @click="move(o.key, 1)"
              >
                <ArrowDown :size="12" />
              </button>
            </template>
          </div>
        </div>

        <div class="mt-3 flex items-center justify-between gap-2">
          <button class="text-[11px] text-slate-400 hover:text-slate-200" @click="reset">
            {{ t('dashboard.cardsReset') }}
          </button>
          <button
            class="rounded-lg bg-sky-600 px-3 py-1 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
            :disabled="saving"
            @click="apply"
          >
            {{ t('dashboard.cardsApply') }}
          </button>
        </div>
      </div>
    </template>
  </div>
</template>
