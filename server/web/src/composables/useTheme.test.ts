import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('useTheme composable', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  it('defaults to auto when no localStorage value', async () => {
    const { useTheme, theme } = await import('./useTheme');
    useTheme();
    expect(theme.value).toBe('auto');
  });

  it('reads stored theme from localStorage', async () => {
    localStorage.setItem('diting-theme', 'light');
    const { useTheme, theme } = await import('./useTheme');
    useTheme();
    expect(theme.value).toBe('light');
  });

  it('toggle switches between dark and light', async () => {
    const { useTheme, theme } = await import('./useTheme');
    const { toggle } = useTheme();
    theme.value = 'light';
    toggle();
    expect(theme.value).toBe('dark');
    toggle();
    expect(theme.value).toBe('light');
  });
});
