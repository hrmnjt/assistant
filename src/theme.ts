export type Appearance = 'system' | 'light' | 'dark';

// Kept in step with public/theme.js, which applies the same choice before the first paint.
const key = 'appearance';
const colors = { light: '#f7f7f2', dark: '#151b18' };
const systemDark = () => window.matchMedia('(prefers-color-scheme: dark)');

/** This device's choice; storage can be unavailable (private mode), which means System. */
export function savedAppearance(): Appearance {
  try {
    const value = localStorage.getItem(key);
    if (value === 'light' || value === 'dark') return value;
  } catch {
    // Fall back to the system setting.
  }
  return 'system';
}

export function applyAppearance(choice = savedAppearance()) {
  const dark = choice === 'dark' || (choice === 'system' && systemDark().matches);
  document.documentElement.classList.toggle('dark', dark);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', dark ? colors.dark : colors.light);
}

export function saveAppearance(choice: Appearance) {
  try {
    if (choice === 'system') localStorage.removeItem(key);
    else localStorage.setItem(key, choice);
  } catch {
    // The choice still applies until the page reloads.
  }
  applyAppearance(choice);
}

/** Follow the device's light/dark switch while the choice is System. */
export function followSystemAppearance() {
  systemDark().addEventListener('change', () => applyAppearance());
}
