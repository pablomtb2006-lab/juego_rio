// Scripted lab sequence: node tools/dev/labseq.mjs <query> '<json steps>'
// step: { frames, js?, shot? }
import { chromium } from 'playwright';
import { createServer } from 'vite';
const [query = 'profile=dev', stepsJson = '[]'] = process.argv.slice(2);
const steps = JSON.parse(stepsJson);
const server = await createServer({ server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
page.on('console', (m) => { const t = m.text(); if (m.type() === 'error' && !t.includes('GPU stall')) console.log('[error]', t.slice(0, 2000)); });
await page.goto(`${server.resolvedUrls.local[0]}lab/agua/?manual&${query}`);
await page.waitForFunction(() => window.__READY, null, { timeout: 300000 });
for (const st of steps) {
  if (st.js) await page.evaluate(st.js);
  if (st.frames) await page.evaluate((n) => { for (let i = 0; i < n; i++) window.__lab.frame(); }, st.frames);
  if (st.shot) {
    await page.waitForTimeout(300);
    await page.screenshot({ path: st.shot, timeout: 120000 });
    const s = await page.evaluate(() => { const s = window.__lab.stats; return s && { t: +s.time.toFixed(2), active: s.active, relError: s.relError, inside: s.insideSolids, vmax: +s.speedMax.toFixed(2), vortMax: +s.vorticityMax.toFixed(1) }; });
    console.log('shot', st.shot, JSON.stringify(s));
  }
}
await browser.close(); await server.close();
