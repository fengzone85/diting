<script setup lang="ts">
// 后台页面统一外壳：
//   ① sticky 标题栏：页标题 + 右侧主操作（保存），滚到任何位置都能保存；
//   ② 与其它后台栏目共用同一条内容列宽（AdminLayout 的 1280 居中列），
//      标题卡与内容卡天然同宽——配置页不再单独限宽，避免「配置列比其它栏目窄、
//      标题卡又比内容卡宽」的两层错位（参考面板全站后台单列等宽）。
// 分节导航已下沉到侧栏二级菜单（对齐参考面板）：每个分节是独立子路由，
// 本页不再承载页内锚点/滚动联动。
// 宽卡内表单可读性由各视图的多列网格保证：短字段分列、长文本/代码/表格占满。
defineProps<{
  title: string;
}>();
</script>

<template>
  <div class="mx-auto w-full">
    <!-- ① 吸顶标题 + 主操作（top-0：贴滚动口顶，顶栏在滚动容器之外） -->
    <div class="glass sticky top-0 z-30 mb-5 flex flex-wrap items-center gap-3 px-4 py-3">
      <h1 class="text-xl font-bold lg:text-2xl">{{ title }}</h1>
      <div class="ml-auto flex items-center gap-2">
        <slot name="actions" />
      </div>
      <div v-if="$slots.banner" class="w-full">
        <slot name="banner" />
      </div>
    </div>

    <!-- ② 内容：与标题栏同列宽（整列即后台统一内容列，不再单独限宽） -->
    <div class="min-w-0">
      <slot />
    </div>
  </div>
</template>