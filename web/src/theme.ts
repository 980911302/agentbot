import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';
export type ThemePreference = Theme | 'system';

const STORAGE_KEY = 'agentbot.theme';

function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function stored(): ThemePreference {
  const value = window.localStorage.getItem(STORAGE_KEY);
  return value === 'light' || value === 'dark' ? value : 'light';
}

export function useTheme(): {
  theme: Theme;
  preference: ThemePreference;
  setPreference: (next: ThemePreference) => void;
  cycle: () => void;
} {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => stored());
  const [theme, setTheme] = useState<Theme>(() =>
    stored() === 'system' ? systemTheme() : (stored() as Theme),
  );


  useEffect(() => {
    const apply = (next: Theme) => {
      setTheme(next);
      document.documentElement.dataset.theme = next;
      document.documentElement.style.colorScheme = next;
    };

    if (preference === 'system') {
      const query = window.matchMedia('(prefers-color-scheme: dark)');
      apply(query.matches ? 'dark' : 'light');
      const listener = (event: MediaQueryListEvent) => apply(event.matches ? 'dark' : 'light');
      query.addEventListener('change', listener);
      return () => query.removeEventListener('change', listener);
    }

    apply(preference);
    return undefined;
  }, [preference]);

  const setPreference = useCallback((next: ThemePreference) => {
    if (next === 'system') window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, next);
    setPreferenceState(next);
  }, []);

  const cycle = useCallback(() => {
    setPreference(theme === 'dark' ? 'light' : 'dark');
  }, [setPreference, theme]);

  return { theme, preference, setPreference, cycle };
}
