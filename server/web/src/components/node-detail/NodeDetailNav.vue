<script setup lang="ts">
// 节点切换栏：返回首页 / 收藏 / 上一个 / 下拉 / 下一个。
import { computed } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import { Star, ArrowLeft, ArrowRight } from '@icon-park/vue-next';
import { t } from '../../composables/useI18n';
import { isFavoriteNode, toggleFavoriteNode } from '../../composables/useApp';
import type { Agent } from '../../services/types';

const props = defineProps<{
  nodes: Agent[];
  currentId: string;
  prev: Agent | null;
  next: Agent | null;
}>();

const router = useRouter();
const favorite = computed(() => isFavoriteNode(props.currentId));

function goNode(id: string) {
  if (id && id !== props.currentId) router.push(`/node/${id}`);
}
</script>

<template>
  <div class="mb-4 flex flex-wrap items-center gap-2">
    <RouterLink
      to="/"
      class="inner-panel flex items-center gap-1.5 px-3 py-1.5 text-sm text-secondary transition-colors hover:text-content"
    ><ArrowLeft :size="16" />{{ t('node.backHome') }}</RouterLink>
    <button
      class="glass flex h-8 w-8 items-center justify-center rounded-lg"
      :title="favorite ? t('node.unfavorite') : t('node.favorite')"
      @click="toggleFavoriteNode(currentId)"
    >
      <Star :size="16" :fill="favorite ? 'currentColor' : 'none'" :class="favorite ? 'text-content' : 'text-muted'" />
    </button>
    <!-- 方向指示统一使用 icon-park 绘制图标（与「返回首页」一致），不用 ← / → 文字字符 -->
    <div class="glass ml-auto flex items-center gap-1 rounded-lg p-1">
      <button
        class="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:text-content disabled:opacity-30"
        :disabled="!prev"
        :title="t('node.prevNode')"
        @click="prev && goNode(prev.id)"
      >
        <ArrowLeft :size="16" />
      </button>
      <select
        :value="currentId"
        class="max-w-40 cursor-pointer rounded-md border-none bg-transparent px-1 py-0.5 text-sm text-content outline-none"
        :title="t('node.switchNode')"
        @change="goNode(($event.target as HTMLSelectElement).value)"
      >
        <option v-for="n in nodes" :key="n.id" :value="n.id" style="color: var(--text-primary); background: var(--bg-primary)">{{ n.name }}</option>
      </select>
      <button
        class="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:text-content disabled:opacity-30"
        :disabled="!next"
        :title="t('node.nextNode')"
        @click="next && goNode(next.id)"
      >
        <ArrowRight :size="16" />
      </button>
    </div>
  </div>
</template>
