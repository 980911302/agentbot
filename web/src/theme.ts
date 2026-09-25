import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';
export type ThemePreference = Theme | 'system';

export const THEME_STORAGE_KEY = 'agentbot.theme';
/** 没有存过偏好（或存的值不认识）时的默认：浅色（docs/主题与CSS.md §1） */
export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'light';

/** 解析存下来的偏好：三种合法值原样返回，其余（没有键 / 旧值 / 损坏）回默认浅色 */
export function parseThemePreference(value: string | null | undefined): ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system' ? value : DEFAULT_THEME_PREFERENCE;
}

/** 偏好 → 真正画到屏幕上的主题：system 跟随 prefers-color-scheme */
export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): Theme {
  if (preference === 'system') return systemPrefersDark ? 'dark' : 'light';
  return preference;
}

const DARK_QUERY = '(prefers-color-scheme: dark)';

function systemPrefersDark(): boolean {
  return window.matchMedia(DARK_QUERY).matches;
}

/** localStorage 在隐私模式下可能读写即抛：读不到当没存，写不进只在本次会话有效 */
function stored(): ThemePreference {
  try {
    return parseThemePreference(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_THEME_PREFERENCE;
  }
}

function persist(next: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    // 存不下就不存
  }
}

export function useTheme(): {
  theme: Theme;
  preference: ThemePreference;
  setPreference: (next: ThemePreference) => void;
  cycle: () => void;
} {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => stored());
  const [theme, setTheme] = useState<Theme>(() => resolveTheme(preference, systemPrefersDark()));

  useEffect(() => {
    const apply = (next: Theme) => {
      setTheme(next);
      document.documentElement.dataset.theme = next;
      document.documentElement.style.colorScheme = next;
    };

    if (preference === 'system') {
      const query = window.matchMedia(DARK_QUERY);
      apply(resolveTheme('system', query.matches));
      const listener = (event: MediaQueryListEvent) => apply(resolveTheme('system', event.matches));
      query.addEventListener('change', listener);
      return () => query.removeEventListener('change', listener);
    }

    apply(preference);
    return undefined;
  }, [preference]);

  // 「跟随系统」也要作为一个值存下来：以前选 system 是删键，下次打开读到「没有键」就回了浅色
  const setPreference = useCallback((next: ThemePreference) => {
    persist(next);
    setPreferenceState(next);
  }, []);

  const cycle = useCallback(() => {
    setPreference(theme === 'dark' ? 'light' : 'dark');
  }, [setPreference, theme]);

  return { theme, preference, setPreference, cycle };
}
