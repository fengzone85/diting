<script setup lang="ts">
// 资产与汇率：首页/看板的「剩余价值 / 总价值」按标准货币汇总。
// - 标准货币（ISO 主键）+ 每币种「1 单位该币 = ? 标准币」手工汇率；
// - 汇率来源可切「自动」：由服务端 fx.js 每日拉取（固定域名公开源），失败保留旧快照；
// - 缺汇率的币种不计入总额，首页会标注「N 种币种未折算」，绝不隐式按 1:1。
import { computed, onMounted, ref } from 'vue';
import { t } from '../../composables/useI18n';
import { adminApi } from '../../services/adminApi';
import { CURRENCY_OPTIONS } from '../../utils/billing';
import type { FxApiSnapshot } from '../../services/types';

export interface BillingSettings {
  base_currency: string;
  rates: Record<string, number>;
  updated_at: number;
  source?: 'manual' | 'api';
  api?: FxApiSnapshot;
}

const props = defineProps<{ billing: BillingSettings }>();
const emit = defineEmits<{ (e: 'update:billing', v: BillingSettings): void }>();

// 不可变更新：不直接改 props（vue/no-mutating-props），由父组件 v-model:billing 接收新对象
function patch(p: Partial<BillingSettings>) {
  emit('update:billing', { ...props.billing, ...p });
}

const FX_SOURCES = [
  { value: 'manual' as const, label: 'settings.fxSourceManual' },
  { value: 'api' as const, label: 'settings.fxSourceApi' },
];

const fxBusy = ref(false);
const fxError = ref('');
const fxInfo = ref<FxApiSnapshot | null>(null);

const base = computed(() => props.billing.base_currency || 'CNY');
const otherCurrencies = computed(() => CURRENCY_OPTIONS.filter((c) => c.code !== base.value));

const fxStatusText = computed(() => {
  const a = fxInfo.value;
  if (!a) return '';
  if (a.status === 'ok') {
    return t('settings.fxLastOk', { time: new Date(a.updated_at).toLocaleString(), provider: a.provider });
  }
  if (a.status === 'failed') return t('settings.fxLastFail', { msg: a.error || '?' });
  return t('settings.fxNever');
});

// 换标准货币必须清空汇率表：现有数值都是「其他币 → 旧标准币」，直接沿用会算错
function setBaseCurrency(code: string) {
  if (props.billing.base_currency === code) return;
  patch({ base_currency: code, rates: {} });
}

// 汇率输入：留空 = 删除该币种（不参与折算）；非法值不改动已有输入
function setRate(code: string, raw: string) {
  const v = String(raw || '').trim();
  const rates = { ...props.billing.rates };
  if (!v) {
    delete rates[code];
  } else {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return;
    rates[code] = n;
  }
  patch({ rates });
}

async function loadFxStatus() {
  try {
    const s = await adminApi.fxStatus();
    fxInfo.value = s.api;
  } catch { /* 状态是辅助信息，失败不打断设置页 */ }
}

async function refreshFx() {
  fxBusy.value = true;
  fxError.value = '';
  try {
    const r = await adminApi.fxRefresh();
    fxInfo.value = r.api;
    if (!r.ok) fxError.value = r.api?.error || t('settings.fxRefreshFailed');
  } catch (e) {
    fxError.value = e instanceof Error ? e.message : String(e);
  } finally {
    fxBusy.value = false;
  }
}

onMounted(() => { void loadFxStatus(); });
</script>

<template>
  <div>
    <h2 class="mb-1 text-lg font-semibold">{{ t('settings.billingTitle') }}</h2>
    <p class="mb-4 text-xs text-secondary">{{ t('settings.billingHint') }}</p>

    <!-- 汇率来源：manual 零外呼；api 由服务端每日拉取（切换后先保存，再点「立即刷新」） -->
    <div class="mb-3 flex flex-wrap items-center gap-2">
      <button
        v-for="o in FX_SOURCES"
        :key="o.value"
        class="h-8 rounded-lg border px-3 text-xs"
        :class="props.billing.source === o.value ? 'border-sky-500 bg-sky-500/20 text-content' : 'border-slate-700 text-secondary hover:border-slate-500'"
        @click="patch({ source: o.value })"
      >{{ t(o.label) }}</button>
      <!-- 只有切到「自动」并保存后服务端才会真正外呼；manual 下禁用避免误报失败 -->
      <button
        class="h-8 rounded-lg border border-slate-700 px-3 text-xs text-secondary hover:border-sky-500 disabled:opacity-50"
        :disabled="fxBusy || props.billing.source !== 'api'"
        @click="refreshFx"
      >{{ fxBusy ? t('settings.fxRefreshing') : t('settings.fxRefreshNow') }}</button>
    </div>
    <p v-if="fxError" class="mb-3 text-xs text-rose-400">{{ fxError }}</p>
    <p v-else-if="fxStatusText" class="mb-3 text-xs text-secondary">{{ fxStatusText }}</p>

    <label class="mb-1 block text-sm text-secondary">{{ t('settings.billingBase') }}</label>
    <select
      :value="base"
      class="field-control mb-4 h-9 w-full"
      @change="setBaseCurrency(($event.target as HTMLSelectElement).value)"
    >
      <option v-for="c in CURRENCY_OPTIONS" :key="c.code" :value="c.code">{{ c.symbol }} {{ c.code }} · {{ t('billing.cur.' + c.code) }}</option>
    </select>

    <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <div v-for="c in otherCurrencies" :key="c.code">
        <label class="mb-1 block text-xs text-secondary">1 {{ c.code }} ({{ c.symbol }}) = ? {{ base }}</label>
        <input
          :value="props.billing.rates[c.code] ?? ''"
          type="number"
          min="0"
          step="0.0001"
          :placeholder="t('settings.billingRateEmpty')"
          class="field-control h-9 w-full"
          @input="setRate(c.code, ($event.target as HTMLInputElement).value)"
        />
      </div>
    </div>

    <p v-if="props.billing.updated_at" class="mt-3 text-xs text-secondary">
      {{ t('settings.billingUpdatedAt', { time: new Date(props.billing.updated_at).toLocaleString() }) }}
    </p>
  </div>
</template>
