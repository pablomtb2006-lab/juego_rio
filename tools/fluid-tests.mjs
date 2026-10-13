// Río Vivo validation runner (headless Chromium + WebGL2).
//   node tools/fluid-tests.mjs                 → every test
//   node tools/fluid-tests.mjs rest dambreak   → a subset
// Results are written to docs/validation/results.json (merged per test) and printed.
import { chromium } from 'playwright';
import { createServer } from 'vite';
import fs from 'node:fs';

const ALL = ['freefall', 'rest', 'flow', 'control', 'dambreak', 'timestep', 'resolution'];
const names = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const todo = names.length ? names : ALL;

const server = await createServer({ server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
page.on('console', (m) => {
  const t = m.text();
  if ((m.type() === 'error' || m.type() === 'warning') && !t.includes('GPU stall due to ReadPixels')) console.log(`[${m.type()}]`, t.slice(0, 2000));
});
await page.goto(`${server.resolvedUrls.local[0]}lab/agua/tests.html`);
await page.waitForFunction(() => window.__READY, null, { timeout: 120000 });
const renderer = await page.evaluate(() => {
  const gl = document.createElement('canvas').getContext('webgl2');
  const d = gl.getExtension('WEBGL_debug_renderer_info');
  return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown';
});

const file = 'docs/validation/results.json';
const results = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
let failed = 0;
for (const name of todo) {
  process.stdout.write(`▶ ${name} … `);
  const r = await page.evaluate((n) => window.__fluid.run(n), name);
  if (!r.pass) failed++;
  console.log(`${r.pass ? 'PASA' : 'FALLA'}  (${r.wallSeconds.toFixed(1)} s de reloj)`);
  console.log(JSON.stringify(r.metrics, (k, v) => (typeof v === 'number' ? +v.toPrecision(5) : v)));
  results[name] = { ...r, date: new Date().toISOString(), renderer };
}
fs.mkdirSync('docs/validation', { recursive: true });
fs.writeFileSync(file, JSON.stringify(results, null, 1));
console.log(`\n${todo.length - failed}/${todo.length} pasan · resultados en ${file} · GPU: ${renderer}`);
await browser.close();
await server.close();
process.exit(failed ? 1 : 0);
