<script setup lang="ts">
import { computed, ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useApp } from './composables/useApp';
import { t } from './composables/useI18n';
import AppFooter from './components/AppFooter.vue';

const { state } = useApp();

// 首屏加载态：router.beforeEach 里 await getAuthStatus() 是异步的，慢网络下
// RouterView 会长时间空白；等路由就绪再渲染，避免「假死」观感。
const router = useRouter();
const ready = ref(false);
onMounted(async () => {
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
    <AppFooter :meta="state.meta" :ip="state.visitor?.ip" :browser="state.visitor?.browser" />

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
