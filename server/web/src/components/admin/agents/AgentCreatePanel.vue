<script setup lang="ts">
// 新建节点表单：名称 + 可选硬件档案；成功后展示一次性 token 与安装命令。
import { onMounted, ref } from 'vue';
import { adminApi } from '../../../services/adminApi';
import { loadAdmin } from '../../../composables/useAdmin';
import { useI18n } from '../../../composables/useI18n';
import { apiErrorMessage } from '../../../utils/apiError';
import HardwareProfileFields from '../HardwareProfileFields.vue';
import type { HardwareOptions, InstallCommands } from '../../../services/types';

const emit = defineEmits<{
  (e: 'error', message: string): void;
  (e: 'info', message: string): void;
}>();

const { t } = useI18n();

const newName = ref('');
const created = ref<{ id: string; token: string; install: InstallCommands } | null>(null);
const showToken = ref(false);
// 新建流程的硬件档案（可选、可折叠；与详情页共用同一个编辑器组件）
const hwOptions = ref<HardwareOptions | null>(null);
const hwFields = ref<InstanceType<typeof HardwareProfileFields> | null>(null);

onMounted(() => {
  // 新建表单的硬件档案候选（失败不阻塞创建：下拉为空仍可手填）
  adminApi.hardwareOptions()
    .then((o) => { hwOptions.value = o; })
    .catch(() => { hwOptions.value = null; });
});

async function add() {
  const name = newName.value.trim();
  if (!name) {
    emit('error', t('agents.nameRequired'));
    return;
  }
  try {
    const res = await adminApi.createAgent({
      name,
      // 硬件档案可选：未填写/手填为空的字段由服务端省略
      hardware: hwFields.value?.value() || {},
    });
    newName.value = '';
    hwFields.value?.reset(undefined);
    created.value = { id: res.id, token: res.token, install: res.install };
    await loadAdmin();
  } catch (e) {
    emit('error', apiErrorMessage(e, 'agents.addFailed'));
  }
}

// P2-5：成功提示走独立 info 通道（绿色），不再借用 error 通道显示「已复制」
function copy(text: string) {
  navigator.clipboard.writeText(text).then(() => {
    emit('info', t('common.copied'));
  });
}
</script>

<template>
  <div class="glass mb-6 p-4">
    <div class="flex gap-3">
      <input v-model="newName" :placeholder="t('common.name')" class="field-control flex-1" @keyup.enter="add" />
      <button class="rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-white hover:bg-sky-400" @click="add">{{ t('agents.add') }}</button>
    </div>
    <!-- 硬件档案（可选）：受控端不采集，建好后也可在详情页修改 -->
    <details class="mt-3">
      <summary class="cursor-pointer select-none text-sm text-secondary">
        {{ t('hw.title') }}
        <span class="ml-2 text-xs text-muted">{{ t('hw.createHint') }}</span>
      </summary>
      <div class="mt-3">
        <HardwareProfileFields ref="hwFields" :options="hwOptions" />
      </div>
    </details>
    <div v-if="created" class="mt-4 space-y-3 border-t border-divider pt-4">
      <div class="flex items-center gap-3">
        <span class="text-sm text-emerald-300">{{ t('agents.created', { id: created.id }) }}</span>
        <span class="text-xs text-muted">{{ t('agents.tokenOnce') }}</span>
      </div>
      <div class="flex gap-2">
        <input :type="showToken ? 'text' : 'password'" readonly class="field-control field-mono min-w-0 flex-1" :value="created.token" />
        <button class="btn-ghost px-3 py-2 text-xs" @click="showToken = !showToken">{{ showToken ? t('common.hide') : t('common.show') }}</button>
        <button class="btn-ghost px-3 py-2 text-xs" @click="copy(created.token)">{{ t('common.copy') }}</button>
      </div>
      <div>
        <div class="mb-1 flex items-center justify-between">
          <label class="text-xs text-secondary">{{ t('agents.linux') }}</label>
          <button class="text-xs text-sky-400 hover:text-sky-300" @click="copy(created.install.native_cmd)">{{ t('common.copy') }}</button>
        </div>
        <textarea readonly rows="3" class="field-control field-mono w-full" :value="created.install.native_cmd" />
      </div>
      <div>
        <div class="mb-1 flex items-center justify-between">
          <label class="text-xs text-secondary">{{ t('agents.docker') }}</label>
          <button class="text-xs text-sky-400 hover:text-sky-300" @click="copy(created.install.docker_cmd)">{{ t('common.copy') }}</button>
        </div>
        <textarea readonly rows="3" class="field-control field-mono w-full" :value="created.install.docker_cmd" />
      </div>
      <div>
        <div class="mb-1 flex items-center justify-between">
          <label class="text-xs text-secondary">{{ t('agents.windows') }}</label>
          <button class="text-xs text-sky-400 hover:text-sky-300" @click="copy(created.install.windows_cmd)">{{ t('common.copy') }}</button>
        </div>
        <textarea readonly rows="2" class="field-control field-mono w-full" :value="created.install.windows_cmd" />
      </div>
    </div>
  </div>
</template>
