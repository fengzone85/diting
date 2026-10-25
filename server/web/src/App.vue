<script setup lang="ts">
import { computed, ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useApp } from './composables/useApp';
import { t } from './composables/useI18n';
import { publicApi } from './services/publicApi';
import AppFooter from './components/AppFooter.vue';

const { state } = useApp();

// 页脚版本 / 构建时间 / commit hash：公开展示（匿名与登录一致）
const version = ref('');
const buildTime = ref('');
const hash = ref('');
// S5.3-4：受控端最新 Release tag（服务端 6h 缓存，冷启动首帧可能为 null）
const agentLatest = ref('');
async function loadVersion() {
  try {
    const info = await publicApi.version();
    version.value = info.version || info.data?.version || '';
    buildTime.value = info.build_time || info.data?.build_time || '';
    hash.value = info.hash || info.data?.hash || '';
    agentLatest.value = info.agent_latest || info.data?.agent_latest || '';
  } catch {
    version.value = '';
    buildTime.value = '';
    hash.value = '';
    agentLatest.value = '';
  }
}

// 首屏加载态：router.beforeEach 里 await getAuthStatus() 是异步的，慢网络下
// RouterView 会长时间空白；等路由就绪再渲染，避免「假死」观感。
const router = useRouter();
const ready = ref(false);
onMounted(async () => {
  // 版本信息与路由就绪互不依赖，并行发起，不拖慢首屏
  void loadVersion();
  await router.isReady();
  ready.value = true;
});

const announcement = computed(() => {
  const a = state.meta?.announcement;
  if (a && a.enabled && (a.title || a.content)) return a;
  return null;
});

const colorVision = computed(() => state.meta?.color_vision || 'normal');
const cvLabel: Record<string, string> = {
  normal: '',
  protanopia: 'Protanopia',
  deuteranopia: 'Deuteranopia',
  tritanopia: 'Tritanopia',
};

</script>

<template>
  <!-- 路由未就绪时显示加载占位，替代纯白屏 -->
  <div v-if="!ready" class="py-24 text-center text-slate-500">
    <span class="animate-pulse">{{ t('common.loading') }}</span>
  </div>

  <template v-else>
    <RouterView />
    <AppFooter
      :meta="state.meta"
      :version="version"
      :build-time="buildTime"
      :hash="hash"
      :agent-latest="agentLatest"
      :ip="state.visitor?.ip"
      :browser="state.visitor?.browser"
    />

    <!-- 色觉辅助提示条 -->
    <div v-if="colorVision !== 'normal'" class="cv-banner glass text-muted">
      {{ t('theme.colorVision') }}: {{ cvLabel[colorVision] }}
    </div>

    <!-- 公告横幅 -->
    <div v-if="announcement" class="fixed inset-x-0 top-0 z-[70] px-4 pt-3 pointer-events-none">
      <div class="glass mx-auto max-w-3xl rounded-xl px-4 py-3 text-content shadow-lg pointer-events-auto">
        <div class="flex items-start gap-2">
          <span class="text-accent mt-0.5">📢</span>
          <div class="text-sm">
            <div v-if="announcement.title" class="font-semibold mb-0.5">{{ announcement.title }}</div>
            <div class="text-muted whitespace-pre-line">{{ announcement.content }}</div>
          </div>
        </div>
      </div>
    </div>
  </template>
</template>
