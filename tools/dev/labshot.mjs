// Drive the water lab headless: node tools/dev/labshot.mjs <out.png> [frames] [query] [js-before-each-shot]
import { chromium } from 'playwright';
import { createServer } from 'vite';
const [out = 'captures/lab.png', frames = '60', query = 'profile=dev', setup = ''] = process.argv.slice(2);
const server = await createServer({ server: { port: 0, host: '127.0.0.1', hmr: false, watch: null }, logLevel: 'error' }); // no reload when sources change mid-run
await server.listen();
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
page.on('console', (m) => { const t = m.text(); if ((m.type() === 'error' || m.type() === 'warning') && !t.includes('GPU stall')) console.log(`[${m.type()}]`, t.slice(0, 3000)); });
await page.goto(`${server.resolvedUrls.local[0]}lab/agua/?manual&${query}`);
await page.waitForFunction(() => window.__READY || document.getElementById('err')?.style.display === 'grid', null, { timeout: 300000 });
const err = await page.evaluate(() => document.getElementById('err').textContent);
if (err) { console.log('LAB ERROR', err.slice(0, 3000)); process.exit(1); }
if (setup) await page.evaluate(setup);
const shots = out.split(',');
const per = Math.ceil(+frames / shots.length);
for (const s of shots) {
  const t0 = Date.now();
  await page.evaluate((n) => { for (let i = 0; i < n; i++) window.__lab.frame(); }, per);
  await page.waitForTimeout(300);
  await page.screenshot({ path: s, timeout: 120000 });
  const st = await page.evaluate(() => { const s = window.__lab.stats; return s && { t: +s.time.toFixed(2), active: s.active, relError: s.relError, lost: s.lost, inside: s.insideSolids, vmax: +s.speedMax.toFixed(2), rhoErr: +(s.densityErrorMean * 100).toFixed(3), foam: +(s.foamFraction * 100).toFixed(2) }; });
  console.log('shot', s, `${((Date.now() - t0) / 1000).toFixed(1)}s`, JSON.stringify(st));
}
await browser.close(); await server.close();
