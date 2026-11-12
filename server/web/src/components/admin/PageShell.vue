<script setup lang="ts">
// 后台配置页统一外壳（A + D 方案，对齐同类项目）：
//   ① sticky 标题栏：页标题 + 右侧主操作（保存），滚到任何位置都能保存；
//   ② 左目录（≥1280px）：锚点跳转 + 滚动联动高亮；
//   ③ 窄屏退化为标题下的横向锚点条；
//   ④ 内容列限宽，避免 1100px 宽的输入框。
import { onMounted, onUnmounted, ref } from 'vue';

interface Section {
  id: string;
  label: string;
}

const props = defineProps<{
  title: string;
  sections?: Section[];
  // 目录吸顶偏移：标题栏高度 + 余量
  navTop?: number;
  // 数据/表格页传 wide 跳过 860 限宽，占满内容区 1280 上限（配置表单页不传）
  wide?: boolean;
}>();

const activeId = ref(props.sections?.[0]?.id || '');
// 点击锚点后短暂关闭滚动联动，避免平滑滚动途中把高亮弹回上一个分节
let spyLock = false;
let lockTimer: ReturnType<typeof setTimeout> | null = null;

function onScroll() {
  const list = props.sections;
  if (spyLock || !list || !list.length) return;
  const line = 110;
  let current = list[0].id;
  for (const s of list) {
    const el = document.getElementById(s.id);
    if (el && el.getBoundingClientRect().top <= line) current = s.id;
  }
  activeId.value = current;
}

function go(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  activeId.value = id;
  spyLock = true;
  if (lockTimer) clearTimeout(lockTimer);
  lockTimer = setTimeout(() => { spyLock = false; }, 600);
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

onMounted(() => {
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
});
onUnmounted(() => {
  window.removeEventListener('scroll', onScroll);
  if (lockTimer) clearTimeout(lockTimer);
});
</script>

<template>
  <div class="mx-auto w-full">
    <!-- ① 吸顶标题 + 主操作（top-14 = 让出后台顶栏的 56px） -->
    <div
      class="glass sticky top-14 z-30 mb-5 flex flex-wrap items-center gap-3 px-4 py-3"
    >
      <h1 class="text-xl font-bold lg:text-2xl">{{ title }}</h1>
      <div class="ml-auto flex items-center gap-2">
        <slot name="actions" />
      </div>
      <div v-if="$slots.banner" class="w-full">
        <slot name="banner" />
      </div>
    </div>

    <div class="flex gap-6">
      <!-- ② 左目录 -->
      <nav
        v-if="sections && sections.length"
        class="hidden w-[172px] shrink-0 self-start xl:block"
        :style="{ position: 'sticky', top: (navTop ?? 84) + 'px' }"
      >
        <ul class="space-y-0.5">
          <li v-for="s in sections" :key="s.id">
            <button
              type="button"
              class="w-full rounded-lg px-3 py-1.5 text-left text-sm transition-colors"
              :class="activeId === s.id
                ? 'bg-sky-500/15 font-medium text-content'
                : 'text-slate-400 hover:bg-slate-700/30 hover:text-content'"
              @click="go(s.id)"
            >
              {{ s.label }}
            </button>
          </li>
        </ul>
      </nav>

      <!-- ④ 内容列限宽：配置表单页 860；数据/表格页传 wide 占满 1280 -->
      <div class="min-w-0 flex-1" :class="wide ? '' : 'xl:max-w-[860px]'">
        <!-- ③ 窄屏横向锚点条 -->
        <div
          v-if="sections && sections.length"
          class="mb-4 flex gap-2 overflow-x-auto pb-1 xl:hidden"
        >
          <button
            v-for="s in sections"
            :key="s.id"
            type="button"
            class="whitespace-nowrap rounded-full border px-3 py-1 text-xs transition-colors"
            :class="activeId === s.id
              ? 'border-sky-500/50 bg-sky-500/15 text-content'
              : 'border-slate-700 text-slate-400'"
            @click="go(s.id)"
          >
            {{ s.label }}
          </button>
        </div>
        <slot />
      </div>
    </div>
  </div>
</template>
