// Load one scenario headless, evaluate JS against window.__engine, optionally screenshot.
//
//   node tools/inspect.mjs --scene=stream --eval="(e)=>({cam:e.ctx.camera.position.toArray()})"
//   node tools/inspect.mjs --scene=stream --eval="(e)=>{e.ctx.scene.fog=null}" --shot=captures/x.png
//
// The eval string must be a function expression receiving the Engine; its return value is printed as JSON.
import { chromium } from 'playwright';
import { createServer } from 'vite';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const i = a.indexOf('=');
    return i < 0 ? [a.replace(/^--/, ''), '1'] : [a.slice(2, i), a.slice(i + 1)];
  }),
);
const [w, h] = (args.size ?? '1280x720').split('x').map(Number);

const server = await createServer({ server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: w, height: h } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
if (args.console) page.on('console', (m) => console.log(`[${m.type()}]`, m.text().slice(0, 400)));
const extra = args.params ? `&${args.params}` : '';
await page.goto(`${server.resolvedUrls.local[0]}?capture=1&mute=1&scene=${args.scene ?? 'menu'}&quality=${args.quality ?? 'high'}${extra}`);
await page.waitForFunction(() => window.__READY || window.__BOOT_ERROR, null, { timeout: 300000, polling: 250 });
if (args.eval) {
  const out = await page.evaluate(`(${args.eval})(window.__engine)`);
  console.log(JSON.stringify(out, null, 1));
}
if (args.shot) {
  await page.evaluate((n) => {
    for (let i = 0; i < n; i++) window.__engine.step(1);
  }, Number(args.frames ?? 2));
  await page.waitForTimeout(600);
  await page.screenshot({ path: args.shot, timeout: 120000 });
  console.log('shot', args.shot);
}
await browser.close();
await server.close();
