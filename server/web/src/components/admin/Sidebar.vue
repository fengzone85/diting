<script setup lang="ts">
import { RouterLink, useRoute, useRouter } from 'vue-router';

const route = useRoute();
const router = useRouter();

const links = [
  { to: '/admin', label: '总览' },
  { to: '/admin/agents', label: '受控端' },
  { to: '/admin/settings', label: '设置' },
];

async function logout() {
  try {
    await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
  } finally {
    router.push('/login');
  }
}
</script>

<template>
  <aside class="glass w-60 flex-shrink-0 p-4">
    <nav class="space-y-2">
      <RouterLink
        v-for="link in links"
        :key="link.to"
        :to="link.to"
        class="block rounded-lg px-4 py-2 text-sm transition-colors"
        :class="route.path === link.to || route.path.startsWith(link.to + '/') ? 'bg-sky-500/20 text-sky-300' : 'text-slate-300 hover:bg-slate-700/30'"
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
