<script setup lang="ts">
// 硬件档案四字段编辑器（管理员手工录入；受控端不自动采集）。
// 状态由组件自持，父组件通过 defineExpose 的 reset()/value() 读写，避免 v-model 双向同步的回填环。
import { ref, watch } from 'vue';
import { t } from '../../composables/useI18n';
import type { HardwareFieldKey, HardwareOptions, HardwareProfile } from '../../services/types';

type HwSrc = '' | 'enum' | 'custom';
interface HwFieldState {
  src: HwSrc;
  hidden: boolean;
  vendor: string;
  tag: string;
  value: string;
  text: string;
}
type HwState = Record<HardwareFieldKey, HwFieldState>;

const HW_KEYS: HardwareFieldKey[] = ['cpu', 'arch', 'virt', 'gpu', 'kernel'];

interface Props {
  // 候选清单由服务端 GET /api/hardware-options 提供；缺失时下拉为空、仍可手填
  options?: HardwareOptions | null;
}
defineProps<Props>();
const emit = defineEmits<{ (e: 'change'): void }>();

function emptyField(): HwFieldState {
  return { src: '', hidden: false, vendor: '', tag: '', value: '', text: '' };
}
function emptyHw(): HwState {
  return { cpu: emptyField(), arch: emptyField(), virt: emptyField(), gpu: emptyField(), kernel: emptyField() };
}

// 档案对象 → 编辑态：保持四键齐全，模板无需处理 undefined。
function fromProfile(p?: HardwareProfile): HwState {
  const next = emptyHw();
  if (!p) return next;
  for (const key of HW_KEYS) {
    const f = p[key];
    if (!f) continue;
    next[key] = {
      src: f.src === 'custom' ? 'custom' : 'enum',
      hidden: !!f.hidden,
      vendor: f.vendor || '',
      tag: f.tag || '',
      value: f.value || '',
      text: f.text || ''
    };
  }
  return next;
}

// 编辑态 → 提交对象：只保留选了模式的字段；预设缺主值 / 手填为空 视为未填写。
function toProfile(s: HwState): HardwareProfile {
  const out: HardwareProfile = {};
  for (const key of HW_KEYS) {
    const f = s[key];
    if (!f.src) continue;
    if (key === 'cpu') {
      if (f.src === 'enum') {
        if (!f.vendor) continue;
        out.cpu = { src: 'enum', hidden: !!f.hidden, vendor: f.vendor, tag: f.tag || '' };
      } else {
        const text = f.text.trim();
        if (!text) continue;
        out.cpu = { src: 'custom', hidden: !!f.hidden, text };
      }
      continue;
    }
    if (f.src === 'enum') {
      if (!f.value) continue;
      out[key] = { src: 'enum', hidden: !!f.hidden, value: f.value };
    } else {
      const text = f.text.trim();
      if (!text) continue;
      out[key] = { src: 'custom', hidden: !!f.hidden, text };
    }
  }
  return out;
}

// 隐藏态即使没有值也要提交：服务端据此压住 arch 的 agent_platform 派生。
function toProfileWithHidden(s: HwState): HardwareProfile {
  const out = toProfile(s);
  for (const key of HW_KEYS) {
    const f = s[key];
    if (!f.src || !f.hidden || out[key]) continue;
    out[key] = { src: f.src, hidden: true };
  }
  return out;
}

const state = ref<HwState>(emptyHw());
let filling = false;

watch(state, () => {
  if (filling) return;
  emit('change');
}, { deep: true, flush: 'sync' });

// 父组件显式回填（避免 props 监听 + emit 的回填环）。
function reset(p?: HardwareProfile) {
  filling = true;
  state.value = fromProfile(p);
  filling = false;
}
function value(): HardwareProfile {
  return toProfileWithHidden(state.value);
}
defineExpose({ reset, value });

// 模式选择：不填写 / 预设 / 手填 / 隐藏（隐藏保留已填值，只压公开出口）
function hwMode(key: HardwareFieldKey): '' | 'enum' | 'custom' | 'hidden' {
  const f = state.value[key];
  if (!f.src) return '';
  return f.hidden ? 'hidden' : f.src;
}
function setHwMode(key: HardwareFieldKey, mode: string) {
  if (mode === '') { state.value[key] = emptyField(); return; }
  if (!state.value[key].src) state.value[key] = emptyField();
  const f = state.value[key];
  if (mode === 'hidden') {
    // 内核版本没有预设档位，空隐藏也要存成 custom，否则会被服务端判为非法枚举。
    if (!f.src) f.src = key === 'kernel' ? 'custom' : 'enum';
    f.hidden = true;
    return;
  }
  if (mode === 'enum' || mode === 'custom') {
    f.src = mode;
    f.hidden = false;
  }
}

const fieldCls = 'field-control w-full disabled:opacity-40';
</script>

<template>
  <div class="space-y-3">
    <!-- CPU：预设（厂商 + 代际）/ 手填 / 隐藏 -->
    <div class="grid grid-cols-1 items-center gap-2 md:grid-cols-[72px_120px_1fr]">
      <label class="text-sm text-secondary">{{ t('hw.cpu') }}</label>
      <select :value="hwMode('cpu')" :class="fieldCls" @change="setHwMode('cpu', ($event.target as HTMLSelectElement).value)">
        <option value="">{{ t('hw.mode.unset') }}</option>
        <option value="enum">{{ t('hw.mode.enum') }}</option>
        <option value="custom">{{ t('hw.mode.custom') }}</option>
        <option value="hidden">{{ t('hw.mode.hidden') }}</option>
      </select>
      <div>
        <span v-if="hwMode('cpu') === 'hidden'" class="text-xs text-muted">{{ t('hw.hiddenHint') }}</span>
        <div v-else-if="hwMode('cpu') === 'enum'" class="flex gap-2">
          <select v-model="state.cpu.vendor" :class="fieldCls" @change="state.cpu.tag = ''">
            <option value="">{{ t('hw.cpuVendor') }}</option>
            <option v-for="v in (options?.cpu_vendors || [])" :key="v" :value="v">{{ v }}</option>
          </select>
          <select v-model="state.cpu.tag" :class="fieldCls" :disabled="!state.cpu.vendor">
            <option value="">{{ t('hw.cpuTagOptional') }}</option>
            <option v-for="tg in (options?.cpu_tags_by_vendor?.[state.cpu.vendor] || [])" :key="tg" :value="tg">{{ tg }}</option>
          </select>
        </div>
        <input
          v-else-if="hwMode('cpu') === 'custom'"
          v-model="state.cpu.text"
          :maxlength="options?.max_text_length || 32"
          :placeholder="t('hw.customPlaceholder')"
          :class="fieldCls"
        />
        <span v-else class="text-xs text-muted">{{ t('hw.unset') }}</span>
      </div>
    </div>

    <!-- 架构：未填写时按受控端构建平台派生；隐藏可压住派生 -->
    <div class="grid grid-cols-1 items-center gap-2 md:grid-cols-[72px_120px_1fr]">
      <label class="text-sm text-secondary">{{ t('hw.arch') }}</label>
      <select :value="hwMode('arch')" :class="fieldCls" @change="setHwMode('arch', ($event.target as HTMLSelectElement).value)">
        <option value="">{{ t('hw.mode.unset') }}</option>
        <option value="enum">{{ t('hw.mode.enum') }}</option>
        <option value="custom">{{ t('hw.mode.custom') }}</option>
        <option value="hidden">{{ t('hw.mode.hidden') }}</option>
      </select>
      <div>
        <span v-if="hwMode('arch') === 'hidden'" class="text-xs text-muted">{{ t('hw.hiddenHint') }}</span>
        <select v-else-if="hwMode('arch') === 'enum'" v-model="state.arch.value" :class="fieldCls">
          <option value="">{{ t('hw.pick') }}</option>
          <option v-for="a in (options?.archs || [])" :key="a" :value="a">{{ a }}</option>
        </select>
        <input
          v-else-if="hwMode('arch') === 'custom'"
          v-model="state.arch.text"
          :maxlength="options?.max_text_length || 32"
          :placeholder="t('hw.customPlaceholder')"
          :class="fieldCls"
        />
        <span v-else class="text-xs text-muted">{{ t('hw.archDerived') }}</span>
      </div>
    </div>

    <!-- 虚拟化 -->
    <div class="grid grid-cols-1 items-center gap-2 md:grid-cols-[72px_120px_1fr]">
      <label class="text-sm text-secondary">{{ t('hw.virt') }}</label>
      <select :value="hwMode('virt')" :class="fieldCls" @change="setHwMode('virt', ($event.target as HTMLSelectElement).value)">
        <option value="">{{ t('hw.mode.unset') }}</option>
        <option value="enum">{{ t('hw.mode.enum') }}</option>
        <option value="custom">{{ t('hw.mode.custom') }}</option>
        <option value="hidden">{{ t('hw.mode.hidden') }}</option>
      </select>
      <div>
        <span v-if="hwMode('virt') === 'hidden'" class="text-xs text-muted">{{ t('hw.hiddenHint') }}</span>
        <select v-else-if="hwMode('virt') === 'enum'" v-model="state.virt.value" :class="fieldCls">
          <option value="">{{ t('hw.pick') }}</option>
          <option v-for="v in (options?.virtualizations || [])" :key="v" :value="v">{{ v }}</option>
        </select>
        <input
          v-else-if="hwMode('virt') === 'custom'"
          v-model="state.virt.text"
          :maxlength="options?.max_text_length || 32"
          :placeholder="t('hw.customPlaceholder')"
          :class="fieldCls"
        />
        <span v-else class="text-xs text-muted">{{ t('hw.unset') }}</span>
      </div>
    </div>

    <!-- GPU：预设只有「核显 / 独显」；无使用率数据源 -->
    <div class="grid grid-cols-1 items-center gap-2 md:grid-cols-[72px_120px_1fr]">
      <label class="text-sm text-secondary">{{ t('hw.gpu') }}</label>
      <select :value="hwMode('gpu')" :class="fieldCls" @change="setHwMode('gpu', ($event.target as HTMLSelectElement).value)">
        <option value="">{{ t('hw.mode.unset') }}</option>
        <option value="enum">{{ t('hw.mode.enum') }}</option>
        <option value="custom">{{ t('hw.mode.custom') }}</option>
        <option value="hidden">{{ t('hw.mode.hidden') }}</option>
      </select>
      <div>
        <span v-if="hwMode('gpu') === 'hidden'" class="text-xs text-muted">{{ t('hw.hiddenHint') }}</span>
        <select v-else-if="hwMode('gpu') === 'enum'" v-model="state.gpu.value" :class="fieldCls">
          <option value="">{{ t('hw.pick') }}</option>
          <option v-for="g in (options?.gpu_types || [])" :key="g" :value="g">{{ g }}</option>
        </select>
        <input
          v-else-if="hwMode('gpu') === 'custom'"
          v-model="state.gpu.text"
          :maxlength="options?.max_text_length || 32"
          :placeholder="t('hw.customPlaceholder')"
          :class="fieldCls"
        />
        <span v-else class="text-xs text-muted">{{ t('hw.unset') }}</span>
      </div>
    </div>

    <!-- 内核版本：没有「代际」粒度，只支持手填 / 隐藏；可直接匹配 CVE，属最高敏感项 -->
    <div class="grid grid-cols-1 items-center gap-2 md:grid-cols-[72px_120px_1fr]">
      <label class="text-sm text-secondary">{{ t('hw.kernel') }}</label>
      <select :value="hwMode('kernel')" :class="fieldCls" @change="setHwMode('kernel', ($event.target as HTMLSelectElement).value)">
        <option value="">{{ t('hw.mode.unset') }}</option>
        <option value="custom">{{ t('hw.mode.custom') }}</option>
        <option value="hidden">{{ t('hw.mode.hidden') }}</option>
      </select>
      <div>
        <span v-if="hwMode('kernel') === 'hidden'" class="text-xs text-muted">{{ t('hw.hiddenHint') }}</span>
        <input
          v-else-if="hwMode('kernel') === 'custom'"
          v-model="state.kernel.text"
          :maxlength="options?.max_text_length || 32"
          :placeholder="t('hw.kernelPlaceholder')"
          :class="fieldCls"
        />
        <span v-else class="text-xs text-muted">{{ t('hw.kernelHint') }}</span>
      </div>
    </div>
  </div>
</template>
