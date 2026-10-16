'use client';

import { useSyncExternalStore } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import {
  THEME_STORAGE_KEY,
  readStoredPreference,
  subscribeToTheme,
  type ThemePreference,
} from '@/lib/theme';

type Locale = 'en' | 'zh';

/** system → light → dark → system */
const CYCLE: Record<ThemePreference, ThemePreference> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
};

const LABELS: Record<ThemePreference, Record<Locale, string>> = {
  system: { en: 'Theme: follow system', zh: '主题：跟随系统' },
  light: { en: 'Theme: light', zh: '主题：亮色' },
  dark: { en: 'Theme: dark', zh: '主题：暗色' },
};

export default function ThemeToggle({
  locale = 'en',
  className = '',
}: {
  locale?: Locale;
  className?: string;
}) {
  // Read straight from the external source (localStorage + the boot script's
  // attribute) so the button reflects reality without an extra render pass.
  const preference = useSyncExternalStore(
    subscribeToTheme,
    readStoredPreference,
    () => 'system' as ThemePreference,
  );

  const apply = (next: ThemePreference) => {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const resolved = next === 'system' ? (prefersDark ? 'dark' : 'light') : next;
    try {
      if (next === 'system') window.localStorage.removeItem(THEME_STORAGE_KEY);
      else window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* storage may be unavailable; the theme still applies for this session */
    }
    document.documentElement.setAttribute('data-theme', resolved);
    document.documentElement.style.colorScheme = resolved;
  };

  const Icon = preference === 'light' ? Sun : preference === 'dark' ? Moon : Monitor;

  return (
    <button
      type="button"
      onClick={() => apply(CYCLE[preference])}
      aria-label={LABELS[preference][locale]}
      title={LABELS[preference][locale]}
      className={`inline-flex h-9 w-9 items-center justify-center rounded-lg border border-gray-200 text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-900 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-gray-100 ${className}`}
    >
      <Icon className="h-[18px] w-[18px]" />
    </button>
  );
}
