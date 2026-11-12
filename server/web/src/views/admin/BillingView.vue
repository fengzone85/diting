<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { adminApi } from '../../services/adminApi';
import { t } from '../../composables/useI18n';
import { useSettingsForm } from '../../composables/useSettingsForm';
import type { Billing } from '../../services/types';
import Loading from '../../components/ui/Loading.vue';
import ErrorMessage from '../../components/ui/ErrorMessage.vue';
import PageShell from '../../components/admin/PageShell.vue';

const data = ref<Billing | null>(null);
const loading = ref(true);
const error = ref('');

// 资产汇率（管理员手工录入，不联网）：从原「设置」页迁入，与账单同域。
const { local, saving, message, ready, save } = useSettingsForm();

// 与 server/src/billing.js 的 CURRENCY_META 保持一致。
// ISO 码是存储/汇率主键，符号只用于展示（同一符号可能对应多个币种，如 $ 与 HK$）。
const CURRENCY_OPTIONS = ([
  ['CNY', '¥', '人民币'], ['USD', '$', '美元'], ['EUR', '€', '欧元'], ['GBP', '£', '英镑'],
  ['JPY', 'JP¥', '日元'], ['HKD', 'HK$', '港币'], ['KRW', '₩', '韩元'], ['RUB', '₽', '卢布'],
  ['THB', '฿', '泰铢'], ['VND', '₫', '越南盾'], ['INR', '₹', '卢比'], ['AUD', 'A$', '澳元'],
  ['CAD', 'C$', '加元'], ['SGD', 'S$', '新加坡元'], ['TWD', 'NT$', '新台币'], ['CHF', '₣', '法郎'],
  ['TRY', '₺', '里拉'], ['UAH', '₴', '格里夫纳'], ['BRL', 'R$', '雷亚尔'], ['MXN', 'Mex$', '墨西哥比索'],
] as const).map(([code, symbol, name]) => ({ code, symbol, name }));

// 汇率输入：留空 = 删除该币种（不参与折算）；非法值不改动已有输入
function setRate(symbol: string, raw: string) {
  const b = local.value.ui.billing;
  if (!b) return;
  const v = String(raw || '').trim();
  if (!v) {
    delete b.rates[symbol];
    return;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return;
  b.rates[symbol] = n;
}

// 换标准货币必须清空汇率表：现有数值都是「其他币 → 旧标准币」，直接沿用会算错
function setBaseCurrency(sym: string) {
  const b = local.value.ui.billing;
  if (!b || b.base_currency === sym) return;
  b.base_currency = sym;
  b.rates = {};
}

async function loadBilling() {
  loading.value = true;
  try {
    data.value = await adminApi.billingOverview();
  } catch (e) {
    error.value = (e as Error).message || t('billing.loadFailed');
  } finally {
    loading.value = false;
  }
}

// 汇率保存后重新拉账单：总额/分组费用依赖折算结果。
async function saveRates() {
  await save();
  await loadBilling();
}

onMounted(loadBilling);

function formatDate(days: number) {
  if (days <= 0) return t('billing.expired');
  if (days === 1) return t('billing.expireTomorrow');
  return t('billing.expireInDays', { n: days });
}
</script>

<template>
  <PageShell wide :title="t('billing.title')">
    <template #actions>
      <button
        :disabled="saving || !ready"
        class="rounded-lg bg-sky-500 px-5 py-2 text-sm font-medium text-white hover:bg-sky-400 disabled:opacity-50"
        @click="saveRates"
      >
        {{ saving ? t('settings.saving') : t('common.save') }}
      </button>
    </template>

    <template v-if="message" #banner>
      <div class="mt-3 rounded-lg border border-sky-500/30 bg-sky-500/10 p-2.5 text-sm text-sky-200">{{ message }}</div>
    </template>

    <Loading v-if="loading" />
    <ErrorMessage v-else-if="error" :message="error" />
    <div v-else-if="data" class="grid gap-6">
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div class="glass p-5">
          <p class="text-sm text-slate-400">{{ t('billing.monthlyTotal') }}</p>
          <p class="mt-1 text-2xl font-semibold text-emerald-400">{{ data.currency }}{{ data.monthly_total.toFixed(2) }}</p>
        </div>
        <div class="glass p-5">
          <p class="text-sm text-slate-400">{{ t('billing.agentCount') }}</p>
          <p class="mt-1 text-2xl font-semibold text-sky-400">{{ data.agent_count }}</p>
        </div>
        <div class="glass p-5">
          <p class="text-sm text-slate-400">{{ t('billing.expire7d') }}</p>
          <p class="mt-1 text-2xl font-semibold" :class="data.expiring_soon.length ? 'text-amber-400' : 'text-slate-200'">{{ data.expiring_soon.length }}</p>
        </div>
      </div>

      <div class="glass p-5">
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

      <div class="glass p-5">
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

    <!-- 资产汇率（管理员手工录入，不联网）：首页/看板的「剩余价值 / 总价值」按标准货币折算 -->
    <div class="glass mt-6 p-5">
      <h2 class="mb-1 text-lg font-semibold">{{ t('settings.billingTitle') }}</h2>
      <p class="mb-4 text-xs text-muted">{{ t('settings.billingHint') }}</p>
      <label class="mb-1 block text-sm text-secondary">{{ t('settings.billingBase') }}</label>
      <select
        :value="local.ui.billing!.base_currency"
        class="mb-4 h-9 w-full rounded-lg border border-slate-700 bg-slate-900/60 px-3 text-sm text-white outline-none focus:border-sky-500 sm:w-72"
        @change="setBaseCurrency(($event.target as HTMLSelectElement).value)"
      >
        <option v-for="c in CURRENCY_OPTIONS" :key="c.code" :value="c.code">{{ c.symbol }} {{ c.code }} · {{ c.name }}</option>
      </select>
      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div v-for="c in CURRENCY_OPTIONS.filter((x) => x.code !== local.ui.billing!.base_currency)" :key="c.code">
          <label class="mb-1 block text-xs text-muted">1 {{ c.code }} ({{ c.symbol }}) = ? {{ local.ui.billing!.base_currency }}</label>
          <input
            :value="local.ui.billing!.rates[c.code] ?? ''"
            type="number"
            min="0"
            step="0.0001"
            :placeholder="t('settings.billingRateEmpty')"
            class="h-9 w-full rounded-lg border border-slate-700 bg-slate-900/60 px-3 text-sm text-white outline-none focus:border-sky-500"
            @input="setRate(c.code, ($event.target as HTMLInputElement).value)"
          />
        </div>
      </div>
      <p v-if="local.ui.billing!.updated_at" class="mt-3 text-xs text-slate-500">
        {{ t('settings.billingUpdatedAt', { time: new Date(local.ui.billing!.updated_at).toLocaleString() }) }}
      </p>
    </div>
  </PageShell>
</template>