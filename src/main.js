import '@fontsource/luckiest-guy/latin-400.css';
import '@fontsource/inter/latin-800.css';
import { Storage } from './services/Storage.js';
import { setLang, t, loadLabel } from './ui/i18n.js';

// --- persisted preferences that must apply before the engine reads URL params ---------------
const store = new Storage('rioroyale');
const saved = store.get('settings', {}) ?? {};
setLang(saved.lang ?? 'auto');
try {
  const url = new URL(location.href);
  if (!url.searchParams.has('quality') && saved.quality && saved.quality !== 'auto') {
    url.searchParams.set('quality', saved.quality);
    history.replaceState(history.state, '', url);
  }
} catch {
  /* sandboxed iframe without history access: auto quality is fine */
}
const capture = new URLSearchParams(location.search).get('capture') === '1';

// --- loading screen -------------------------------------------------------------------------
const loading = document.getElementById('loading');
const fill = loading.querySelector('.fill');
const label = loading.querySelector('.label');
const pct = loading.querySelector('.pct');
const tipText = loading.querySelector('.tiptext');
const tip = loading.querySelector('.tip');
let tipIndex = Math.floor(Math.random() * 6);
const showTip = () => {
  tipText.textContent = t(`load.tip.${tipIndex % 6}`);
  tipIndex++;
};
showTip();
const tipTimer = setInterval(() => {
  tip.style.opacity = '0';
  setTimeout(() => {
    showTip();
    tip.style.opacity = '1';
  }, 300);
}, 3600);
label.textContent = loadLabel('Preparando el cielo');

let shown = 0;
const progress = (p, text) => {
  shown = Math.max(shown, p);
  fill.style.width = `calc(${(shown * 100).toFixed(1)}% - 6px)`;
  pct.textContent = `${Math.round(shown * 100)}%`;
  if (text) label.textContent = loadLabel(text);
};

// Block the browser context menu / pinch gestures that break the game on touch screens.
window.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('gesturestart', (e) => e.preventDefault());

async function boot() {
  progress(0.01);
  const { Engine } = await import('./core/Engine.js');
  const engine = new Engine(document.getElementById('app'));
  await engine.init(progress);
  clearInterval(tipTimer);
  if (capture) loading.remove();
  else {
    loading.classList.add('is-done');
    setTimeout(() => loading.remove(), 700);
  }
  engine.start();
  if (engine.params.capture) engine.step(1);
  engine.ctx.services?.ads?.loadingFinished?.();
  window.__BOOTED = true;
}

boot().catch((err) => {
  console.error(err);
  clearInterval(tipTimer);
  label.innerHTML = '';
  const e = document.createElement('span');
  e.className = 'err';
  e.textContent = `Error: ${err?.message ?? err}`;
  label.appendChild(e);
  window.__BOOT_ERROR = String(err?.stack ?? err);
});
