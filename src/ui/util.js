import { getLang } from './i18n.js';

/** HTML from a template string → first element. */
export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

/** Map of [data-ref] children: refs(el).play etc. */
export function refs(root) {
  const out = {};
  root.querySelectorAll('[data-ref]').forEach((e) => (out[e.dataset.ref] = e));
  return out;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Integer with grouping (en: 2,445,012 · es: 2.445.012 — always grouped, unlike es-ES Intl). */
export function fmtInt(n) {
  const sep = getLang() === 'es' ? '.' : ',';
  const s = String(Math.round(Math.abs(n)));
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i && (s.length - i) % 3 === 0) out += sep;
    out += s[i];
  }
  return (n < 0 ? '-' : '') + out;
}

/** 1.2M / 350K / 980 */
export function fmtCompact(n) {
  const a = Math.abs(n);
  const dec = getLang() === 'es' ? ',' : '.';
  let s;
  if (a >= 1e9) s = trim((a / 1e9).toFixed(1)) + 'B';
  else if (a >= 1e6) s = trim((a / 1e6).toFixed(a >= 1e7 ? 0 : 1)) + 'M';
  else if (a >= 1e4) s = Math.round(a / 1e3) + 'K';
  else s = fmtInt(a);
  return (n < 0 ? '-' : '') + s.replace('.', dec);
}
const trim = (s) => s.replace(/\.0$/, '');

/** Fixed decimals with the locale's decimal mark. */
export function fmtFixed(n, d = 2) {
  const s = n.toFixed(d);
  return getLang() === 'es' ? s.replace('.', ',') : s;
}

export function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

export const hex = (c) => `#${(c >>> 0).toString(16).padStart(6, '0').slice(-6)}`;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const damp = (a, b, k, dt) => b + (a - b) * Math.exp(-k * dt);
export const easeOutBack = (t) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};
export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

/** Mix a 0xRRGGBB colour towards white (k>0) or black (k<0). */
export function shade(c, k) {
  const r = (c >> 16) & 255;
  const g = (c >> 8) & 255;
  const b = c & 255;
  const f = (v) => Math.round(k >= 0 ? v + (255 - v) * k : v * (1 + k));
  return (f(r) << 16) | (f(g) << 8) | f(b);
}

/** '*word*' → highlighted span; '\n' → line break. Text is escaped first. */
export function markup(s) {
  return esc(s)
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\n/g, '<br>');
}

export const isTouch = () =>
  typeof window !== 'undefined' &&
  (window.matchMedia?.('(pointer: coarse)').matches || 'ontouchstart' in window || navigator.maxTouchPoints > 0);

/** Short haptic tick when allowed. */
export function vibrate(ctx, pattern) {
  if (!ctx.services?.settings?.get('haptics')) return;
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* ignore */
  }
}
