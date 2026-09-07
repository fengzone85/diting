<script setup lang="ts">
// 404 页：服务端 SPA fallback（server.js app.get('*')）对所有无后缀路径返回 index.html + 200，
// 前端无法从 HTTP 状态判断，只能靠这条 catch-all 路由兜底，否则表现为白屏。
import { useI18n } from '../composables/useI18n';
const { t } = useI18n();
</script>

<template>
  <div class="mx-auto max-w-xl py-20 text-center">
    <div class="mb-4 text-6xl font-bold text-slate-400">404</div>
    <p class="mb-8 text-slate-500">{{ t('notfound.title') }}</p>
    <div class="flex justify-center gap-3">
      <RouterLink
        to="/"
        class="rounded-lg bg-slate-700 px-4 py-2 text-sm text-white transition-colors hover:bg-slate-600"
      >{{ t('notfound.backHome') }}</RouterLink>
      <RouterLink
        to="/admin"
        class="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-300 transition-colors hover:bg-slate-800"
      >{{ t('notfound.toAdmin') }}</RouterLink>
    </div>
  </div>
</template>
