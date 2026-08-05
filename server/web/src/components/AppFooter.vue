<script setup lang="ts">
defineProps<{
  version?: string;
}>();
</script>

<template>
  <footer class="mt-12 py-6 text-center text-xs text-slate-500">
    <p>Diting Monitor {{ version ? `v${version}` : '' }}</p>
  </footer>
</template>
