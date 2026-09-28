/* Small helpers shared by every view. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ------------------------------------------------------------ formatting */
export const fmt = {
  km(metres) {
    if (metres == null) return '—';
    const km = metres / 1000;
    if (km < 1) return `${Math.round(metres)} m`;
    if (km < 10) return `${km.toFixed(1)} km`;
    return `${Math.round(km).toLocaleString()} km`;
  },
  duration(seconds) {
    if (seconds == null) return '—';
    const total = Math.max(0, Math.round(seconds));
    const h = Math.floor(total / 3600);
    const m = Math.round((total % 3600) / 60);
    if (h && m) return `${h}h ${m}m`;
    if (h) return `${h}h`;
    return `${m || 1} min`;
  },
  naira(value) {
    if (value == null) return '—';
    return `₦${Math.round(value).toLocaleString('en-NG')}`;
  },
  clock(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  },
  dayTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    const today = new Date().toDateString() === d.toDateString();
    return today
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  },
  ago(iso) {
    if (!iso) return '';
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    if (days < 30) return `${days}d ago`;
    return `${Math.round(days / 30)}mo ago`;
  },
  minutes(mins) {
    if (mins < 60) return `${mins} min`;
    const h = Math.floor(mins / 60);
    return `${h}h ${mins % 60}m`;
  },
};

/* ------------------------------------------------------------- iconography */
export const GLYPHS = {
  pothole: '🕳️',
  flood: '🌊',
  accident: '💥',
  traffic: '🚗',
  works: '🚧',
  obstruction: '⛔',
  checkpoint: '🛃',
  security: '⚠️',
  protest: '✊',
  'fuel-yes': '⛽',
  'fuel-no': '🚱',
  closed: '🔒',
  relocated: '📦',
  renamed: '🏷️',
  clear: '✅',
  pin: '📍',
};

export const glyph = (icon) => GLYPHS[icon] ?? GLYPHS.pin;

/* ------------------------------------------------------------------ toast */
let toastHost = null;
export function toast(message, { tone = '', detail = '', timeout = 5200 } = {}) {
  toastHost ??= document.getElementById('toasts');
  if (!toastHost) return null;
  const node = el('div', { class: `toast ${tone}` }, [
    el('div', {}, [el('div', { text: message }), detail ? el('small', { text: detail }) : null]),
  ]);
  node.addEventListener('click', () => node.remove());
  toastHost.append(node);
  if (timeout) setTimeout(() => node.remove(), timeout);
  return node;
}

/* ---------------------------------------------------------------- utility */
export function debounce(fn, wait = 220) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

export function toLocalInputValue(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}

export function scoreColour(score) {
  if (score >= 78) return 'var(--good)';
  if (score >= 52) return 'var(--warn)';
  return 'var(--bad)';
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = el('textarea', { style: { position: 'fixed', opacity: '0' } });
    area.value = text;
    document.body.append(area);
    area.select();
    const ok = document.execCommand?.('copy');
    area.remove();
    return Boolean(ok);
  }
}
