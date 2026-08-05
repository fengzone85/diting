<script setup lang="ts">
import { RouterLink, useRoute, useRouter } from 'vue-router';

defineProps<{
  open?: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const route = useRoute();
const router = useRouter();

const links = [
  { to: '/admin', label: '总览' },
  { to: '/admin/agents', label: '受控端' },
  { to: '/admin/billing', label: '账单概览' },
  { to: '/admin/ai', label: 'AI 分析' },
  { to: '/admin/settings', label: '设置' },
];

async function logout() {
  try {
    await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
  } finally {
    router.push('/login');
  }
}

function isActive(to: string) {
  return route.path === to || route.path.startsWith(to + '/');
}
</script>

<template>
  <!-- mobile overlay -->
  <div
    v-if="open"
    class="fixed inset-0 z-40 bg-black/50 lg:hidden"
    @click="emit('close')"
  />
  <aside
    class="sidebar glass z-50 flex-shrink-0 p-4 transition-transform duration-200 lg:static lg:w-60 lg:translate-x-0"
    :class="open ? 'sidebar-open' : 'sidebar-closed'"
  >
    <div class="mb-4 flex items-center justify-between lg:hidden">
      <span class="text-lg font-bold text-sky-400">Diting</span>
      <button class="text-slate-400 hover:text-white" @click="emit('close')">✕</button>
    </div>
    <nav class="space-y-2">
      <RouterLink
        v-for="link in links"
        :key="link.to"
        :to="link.to"
        class="block rounded-lg px-4 py-2 text-sm transition-colors"
        :class="isActive(link.to) ? 'bg-sky-500/20 text-sky-300' : 'text-slate-300 hover:bg-slate-700/30'"
        @click="emit('close')"
      >
        {{ link.label }}
      </RouterLink>
      <button
        class="mt-4 block w-full rounded-lg px-4 py-2 text-left text-sm text-slate-400 hover:bg-rose-500/10 hover:text-rose-300"
        @click="logout"
      >
        退出
      </button>
    </nav>
  </aside>
</template>

<style scoped>
.sidebar {
  position: fixed;
  top: 0;
  bottom: 0;
  left: 0;
  width: 15rem;
}
.sidebar-closed {
  transform: translateX(-100%);
}
.sidebar-open {
  transform: translateX(0);
}
@media (min-width: 1024px) {
  .sidebar {
    position: static;
  }
  .sidebar-closed,
  .sidebar-open {
    transform: translateX(0);
  }
}
</style>
