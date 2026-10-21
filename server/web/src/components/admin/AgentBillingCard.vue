<script setup lang="ts">
// 服务器列表里的「账单」图标 + 弹出账单卡片（对齐 Komari 后台服务器列表的账单弹卡）：
// 价格（0 不显示 / -1 免费）、货币（9 种）、计费周期（-1 一次性 / 0 白嫖 / >0 天数）、
// 到期时间、自动续费（附续费规则提示）。卡片内直接可编辑并保存。
import { nextTick, onBeforeUnmount, reactive, ref } from 'vue';
import { Ticket } from '@icon-park/vue-next';
import type { Agent } from '../../services/types';
import { adminApi } from '../../services/adminApi';
import { apiErrorMessage } from '../../utils/apiError';
import { useI18n } from '../../composables/useI18n';
import { BILLING_CYCLES, CURRENCIES, DEFAULT_CURRENCY, DEFAULT_CYCLE } from '../../utils/billing';

const props = defineProps<{ agent: Agent }>();
const emit = defineEmits<{ (e: 'saved'): void }>();

const { t } = useI18n();

const open = ref(false);
const saving = ref(false);
const err = ref('');
const trigger = ref<HTMLElement | null>(null);
const pop = ref<HTMLElement | null>(null);
const pos = ref({ top: 0, left: 0 });
const CARD_W = 312;

type Currency = NonNullable<Agent['currency']>;

const form = reactive({
  price: 0,
  currency: DEFAULT_CURRENCY as Currency,
  billing_cycle: DEFAULT_CYCLE as number,
  expire_at: '',
  /** 长期：无到期日（对齐 Komari：到期时间可设为「长期」，即不设过期时间） */
  long_term: false,
  auto_renewal: true,
});

function reset() {
  form.price = props.agent.price ?? 0;
  form.currency = props.agent.currency || (DEFAULT_CURRENCY as Currency);
  form.billing_cycle = props.agent.billing_cycle ?? DEFAULT_CYCLE;
  form.expire_at = (props.agent.expire_at || '').slice(0, 10);
  form.long_term = !form.expire_at;
  form.auto_renewal = props.agent.auto_renewal !== false;
}

function measure() {
  const r = trigger.value?.getBoundingClientRect();
  if (!r) return;
  const h = pop.value?.offsetHeight || 380;
  let left = r.right - CARD_W;
  left = Math.max(8, Math.min(left, window.innerWidth - CARD_W - 8));
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 8) top = Math.max(8, window.innerHeight - h - 8);
  pos.value = { top, left };
}

async function toggle() {
  if (!open.value) { reset(); err.value = ''; }
  open.value = !open.value;
  if (open.value) { await nextTick(); measure(); }
}

async function save() {
  saving.value = true;
  err.value = '';
  try {
    // PUT /api/agents/:id 是「整份覆盖」：未携带的字段会被写成空值，
    // 因此必须把该节点的其余元数据一并回传。
    await adminApi.updateAgent(props.agent.id, {
      name: props.agent.name,
      merchant: props.agent.merchant || '',
      note: props.agent.note || '',
      expire_at: form.long_term ? '' : (form.expire_at || ''),
      monthly_quota_gb: props.agent.monthly_quota_gb ?? 0,
      group: props.agent.group || props.agent.grp || '',
      country: props.agent.country || '',
      probe_targets: props.agent.probe_targets || '',
      price: Number(form.price),
      currency: form.currency,
      billing_cycle: Number(form.billing_cycle),
      auto_renewal: form.auto_renewal,
    });
    open.value = false;
    emit('saved');
  } catch (e) {
    err.value = apiErrorMessage(e);
  } finally {
    saving.value = false;
  }
}

function onDocPointerDown(e: PointerEvent) {
  if (!open.value) return;
  const el = e.target as Node | null;
  if (el && (trigger.value?.contains(el) || pop.value?.contains(el))) return;
  open.value = false;
}

function onDocKeydown(e: KeyboardEvent) {
  if (open.value && e.key === 'Escape') open.value = false;
}

function onViewportChange() {
  if (open.value) measure();
}

document.addEventListener('pointerdown', onDocPointerDown, true);
document.addEventListener('keydown', onDocKeydown);
window.addEventListener('scroll', onViewportChange, true);
window.addEventListener('resize', onViewportChange);

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointerDown, true);
  document.removeEventListener('keydown', onDocKeydown);
  window.removeEventListener('scroll', onViewportChange, true);
  window.removeEventListener('resize', onViewportChange);
});
</script>

<template>
  <button
    ref="trigger"
    type="button"
    class="flex h-7 w-7 items-center justify-center rounded-lg text-orange-300 hover:bg-orange-500/10"
    :title="t('billing.card')"
    :aria-label="t('billing.card')"
    :aria-expanded="open"
    @click.stop="toggle"
  >
    <Ticket :size="16" theme="outline" />
  </button>

  <Teleport to="body">
    <div
      v-if="open"
      ref="pop"
      class="billing-pop fixed z-[90] rounded-xl p-4 text-sm"
      :style="{ top: `${pos.top}px`, left: `${pos.left}px`, width: `${CARD_W}px` }"
      @click.stop
    >
      <div class="mb-3 flex items-center justify-between">
        <span class="font-semibold text-slate-100">{{ t('billing.card') }}</span>
        <span class="truncate pl-2 text-xs text-slate-500">{{ agent.name }}</span>
      </div>

      <label class="mb-3 block text-xs text-slate-400">
        {{ t('agent.price') }}
        <input
          v-model.number="form.price"
          type="number"
          step="0.01"
          class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-white outline-none focus:border-sky-500"
        />
        <span class="mt-1 block text-[11px] text-slate-500">{{ t('agent.priceHint') }}</span>
      </label>

      <label class="mb-3 block text-xs text-slate-400">
        {{ t('agent.currency') }}
        <select
          v-model="form.currency"
          class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-white outline-none focus:border-sky-500"
        >
          <option v-for="c in CURRENCIES" :key="c.symbol" :value="c.symbol">
            {{ c.symbol }} {{ t('agent.currency.' + c.key) }}
          </option>
        </select>
      </label>

      <label class="mb-3 block text-xs text-slate-400">
        {{ t('agent.billingCycle') }}
        <select
          v-model.number="form.billing_cycle"
          class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-white outline-none focus:border-sky-500"
        >
          <option v-for="o in BILLING_CYCLES" :key="o.value" :value="o.value">
            {{ o.value === -1 ? '-1 ' : '' }}{{ t('agent.cycle.' + o.key) }}{{ o.value > 0 ? ` (${o.value}d)` : '' }}
          </option>
        </select>
      </label>

      <div class="mb-3 text-xs text-slate-400">
        <div class="mb-1 flex items-center justify-between">
          <span>{{ t('agent.expireDate') }}</span>
          <label class="flex cursor-pointer items-center gap-1 text-slate-300">
            <input
              v-model="form.long_term"
              type="checkbox"
              class="h-3.5 w-3.5 rounded border-slate-600 bg-slate-800 text-sky-500"
            />
            {{ t('agent.longTerm') }}
          </label>
        </div>
        <input
          v-model="form.expire_at"
          type="date"
          :disabled="form.long_term"
          class="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-white outline-none focus:border-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
        />
        <span v-if="form.long_term" class="mt-1 block text-[11px] text-slate-500">{{ t('agent.longTermHint') }}</span>
      </div>

      <label class="flex items-center gap-2 text-xs text-slate-300">
        <input
          v-model="form.auto_renewal"
          type="checkbox"
          class="h-4 w-4 rounded border-slate-600 bg-slate-800 text-sky-500"
        />
        {{ t('agent.autoRenew') }}
      </label>
      <p class="mt-1 text-[11px] leading-relaxed text-slate-500">{{ t('agent.autoRenewHint') }}</p>

      <p v-if="err" class="mt-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-200">{{ err }}</p>

      <div class="mt-4 flex justify-end gap-2">
        <button class="rounded-lg border border-slate-600 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800" @click="open = false">
          {{ t('common.cancel') }}
        </button>
        <button
          class="rounded-lg bg-sky-500 px-4 py-1.5 text-xs text-white hover:bg-sky-400 disabled:opacity-50"
          :disabled="saving"
          @click="save"
        >
          {{ saving ? t('agent.saving') : t('common.save') }}
        </button>
      </div>
    </div>
  </Teleport>
</template>
