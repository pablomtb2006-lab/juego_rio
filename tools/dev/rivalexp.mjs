// Run a JS snippet against the fluid modules in headless Chromium (WebGL2 via SwiftShader).
//   node tools/dev/rivalexp.mjs <snippet.js>
// The snippet is the body of an async function with `gl` and `M` (loaded modules) in scope; it
// returns a JSON-able value that is printed.
import { chromium } from 'playwright';
import { createServer } from 'vite';
import fs from 'node:fs';
const code = fs.readFileSync(process.argv[2], 'utf8');
const server = await createServer({ server: { port: 0, host: '127.0.0.1', hmr: false, watch: null }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
page.on('console', (m) => { const t = m.text(); if (!t.includes('GPU stall')) console.log(`[${m.type()}]`, t.slice(0, 3000)); });
await page.goto(`${server.resolvedUrls.local[0]}lab/agua/tests.html`);
await page.waitForFunction(() => window.__READY, null, { timeout: 120000 });
const t0 = Date.now();
const r = await page.evaluate(async (src) => {
  const M = {
    ...(await import('/src/fluid/RiverSimulation.js')),
    ...(await import('/src/fluid/RiverEcosystem.js')),
    ...(await import('/src/fluid/AbsorptionSystem.js')),
  };
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2', { antialias: false, depth: false });
  const f = new Function('gl', 'M', `return (async () => { ${src} })()`);
  try { return await f(gl, M); } catch (e) { return { error: e.message, stack: e.stack }; }
}, code);
console.log(JSON.stringify(r, (k, v) => (typeof v === 'number' ? +v.toPrecision(5) : v), 1));
console.log(`(${((Date.now() - t0) / 1000).toFixed(1)} s)`);
await browser.close();
await server.close();
