// Light / dark / follow-the-system. index.html applies the stored choice before first
// paint; this module keeps it in sync afterwards.

const KEY = 'abc-dates:theme';
const mq = matchMedia('(prefers-color-scheme: dark)');
const META = { light: '#F6F0E6', dark: '#1B1820' };

export function getTheme() {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(pref = getTheme()) {
  const mode = pref === 'dark' || (pref === 'system' && mq.matches) ? 'dark' : 'light';
  document.documentElement.dataset.theme = mode;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', META[mode]);
}

export function setTheme(pref) {
  try {
    if (pref === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch { /* storage unavailable — still apply for this visit */ }
  applyTheme(pref);
}

mq.addEventListener('change', () => applyTheme());
applyTheme();
