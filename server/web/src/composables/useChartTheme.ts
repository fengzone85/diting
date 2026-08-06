import { ref, computed, onMounted, onUnmounted } from 'vue';

export interface ChartThemeColors {
  text: string;
  splitLine: string;
  axisLine: string;
  tooltipBg: string;
  tooltipBorder: string;
}

function isLight(): boolean {
  return document.documentElement.getAttribute('data-theme') === 'light';
}

export function useChartTheme() {
  const light = ref(isLight());

  function update() {
    light.value = isLight();
  }

  let observer: MutationObserver | null = null;
  onMounted(() => {
    observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  });
  onUnmounted(() => observer?.disconnect());

  const colors = computed<ChartThemeColors>(() => {
    if (light.value) {
      return {
        text: '#475569',
        splitLine: 'rgba(15, 23, 42, 0.08)',
        axisLine: 'rgba(15, 23, 42, 0.2)',
        tooltipBg: 'rgba(255, 255, 255, 0.95)',
        tooltipBorder: 'rgba(15, 23, 42, 0.12)',
      };
    }
    return {
      text: '#94a3b8',
      splitLine: '#334155',
      axisLine: '#475569',
      tooltipBg: 'rgba(15, 23, 42, 0.95)',
      tooltipBorder: 'rgba(148, 163, 184, 0.2)',
    };
  });

  return { light, colors };
}
