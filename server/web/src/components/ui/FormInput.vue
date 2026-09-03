<script setup lang="ts">
interface Props {
  label: string;
  modelValue?: string | number | boolean;
  type?: 'text' | 'password' | 'number' | 'textarea' | 'checkbox';
  placeholder?: string;
}

defineProps<Props>();
const emit = defineEmits<{
  (e: 'update:modelValue', value: string | number | boolean | undefined): void;
}>();

function onInput(e: Event) {
  const target = e.target as HTMLInputElement | HTMLTextAreaElement;
  if (target.type === 'checkbox') {
    emit('update:modelValue', (target as HTMLInputElement).checked);
  } else if (target.type === 'number') {
    emit('update:modelValue', target.value === '' ? '' : Number(target.value));
  } else {
    emit('update:modelValue', target.value);
  }
}
</script>

<template>
  <div class="mb-4">
    <label class="mb-1 block text-sm text-slate-400">{{ label }}</label>
    <textarea
      v-if="type === 'textarea'"
      :value="modelValue as string"
      rows="3"
      class="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-2 text-sm text-white outline-none focus:border-sky-500"
      :placeholder="placeholder"
      @input="onInput"
    />
    <input
      v-else-if="type === 'checkbox'"
      :checked="modelValue as boolean"
      type="checkbox"
      class="h-4 w-4 rounded border-slate-700 bg-slate-900/50 text-sky-500 focus:ring-sky-500"
      @change="onInput"
    />
    <input
      v-else
      :value="modelValue"
      :type="type || 'text'"
      class="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-2 text-sm text-white outline-none focus:border-sky-500"
      :placeholder="placeholder"
      @input="onInput"
    />
  </div>
</template>
