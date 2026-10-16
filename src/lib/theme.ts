export const THEME_STORAGE_KEY = '__app_theme__';
export const THEME_CHANGE_EVENT = 'app-theme-change';

/** What the user picked in the UI. */
export type ThemePreference = 'light' | 'dark' | 'system';
/** What is actually painted on screen. */
export type ResolvedTheme = 'light' | 'dark';

export function readStoredPreference(): ThemePreference {
  if (typeof window === 'undefined') return 'system';
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system';
  }
}

export function readResolvedTheme(): ResolvedTheme {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

/**
 * Notifies when the painted theme changes — either because the OS flipped
 * (broadcast by the boot script) or because the toggle swapped the attribute.
 */
export function subscribeToTheme(onChange: () => void): () => void {
  window.addEventListener(THEME_CHANGE_EVENT, onChange);
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => {
    window.removeEventListener(THEME_CHANGE_EVENT, onChange);
    observer.disconnect();
  };
}

/**
 * Runs before first paint so the correct `data-theme` is on <html> and no
 * light-to-dark flash is visible. `system` keeps tracking the OS setting
 * live: when the OS flips, the page follows unless the user chose explicitly.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{var k='${THEME_STORAGE_KEY}',e='${THEME_CHANGE_EVENT}',r=document.documentElement,m=window.matchMedia('(prefers-color-scheme: dark)'),a=function(t){r.setAttribute('data-theme',t);r.style.colorScheme=t;},s=localStorage.getItem(k);a((s==='light'||s==='dark')?s:(m.matches?'dark':'light'));var h=function(v){var c=localStorage.getItem(k);if(c==='light'||c==='dark')return;var n=v.matches?'dark':'light';a(n);window.dispatchEvent(new CustomEvent(e,{detail:{theme:n}}));};if(m.addEventListener)m.addEventListener('change',h);else if(m.addListener)m.addListener(h);}catch(x){}})();`;
