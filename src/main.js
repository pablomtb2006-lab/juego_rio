import { Engine } from './core/Engine.js';

const loading = document.getElementById('loading');
const fill = loading.querySelector('.fill');
const label = loading.querySelector('.label');

const engine = new Engine(document.getElementById('app'));
engine
  .init((p, text) => {
    fill.style.width = `${Math.round(p * 100)}%`;
    if (text) label.textContent = text;
  })
  .then(() => {
    loading.style.opacity = '0';
    setTimeout(() => loading.remove(), 600);
    engine.start();
    if (engine.params.capture) engine.step(1);
    window.__BOOTED = true;
  })
  .catch((err) => {
    console.error(err);
    label.textContent = `Error: ${err.message}`;
    window.__BOOT_ERROR = String(err?.stack ?? err);
  });
