<script setup lang="ts">
interface Props {
  label: string;
  modelValue?: string | number | boolean;
  type?: 'text' | 'password' | 'number' | 'textarea' | 'checkbox';
  placeholder?: string;
  // 字段下方的灰色小字说明（用于配置项的注意事项/排障提示）
  hint?: string;
  // 只读展示（如 AI Key 由环境变量提供时禁止编辑）
  disabled?: boolean;
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
    <label v-if="type !== 'checkbox'" class="mb-1 block text-sm text-secondary">{{ label }}</label>
    <textarea
      v-if="type === 'textarea'"
      :value="modelValue as string"
      rows="3"
      class="field-control w-full"
      :placeholder="placeholder"
      :disabled="disabled"
      @input="onInput"
    />
    <label
      v-else-if="type === 'checkbox'"
      class="flex items-center gap-3"
      :class="disabled ? 'cursor-not-allowed' : 'cursor-pointer'"
    >
      <input
        :checked="modelValue as boolean"
        type="checkbox"
        class="switch"
        :disabled="disabled"
        @change="onInput"
      />
      <span class="text-sm text-secondary">{{ label }}</span>
    </label>
    <input
      v-else
      :value="modelValue"
      :type="type || 'text'"
      class="field-control w-full"
      :placeholder="placeholder"
      :disabled="disabled"
      @input="onInput"
    />
    <p v-if="hint" class="mt-1 whitespace-pre-line text-xs leading-relaxed text-muted">{{ hint }}</p>
  </div>
</template>
