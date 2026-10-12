// Deterministic screenshots of every game-loop element for visual review.
//
//   node tools/capture.mjs                         # all scenes, landscape + portrait
//   node tools/capture.mjs --scenes=stream,lake    # subset
//   node tools/capture.mjs --size=portrait --quality=ultra --out=captures/round2
//   node tools/capture.mjs --frames=3              # extra rendered frames before the shot
//   node tools/capture.mjs --nohud                 # hide the DOM overlay (pure 3D comparison)
//
// Uses headless Chromium with SwiftShader (software WebGL2): slow but pixel-identical
// in look to a GPU render. Writes <out>/<scene>-<size>.png and <out>/console.log.
import { chromium } from 'playwright';
import { createServer } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? '1'];
  }),
);

const ALL = ['menu', 'drop', 'arch', 'landing', 'stream', 'lake', 'rival', 'forest', 'sea', 'map'];
const scenes = args.scenes ? args.scenes.split(',') : ALL;
const sizes = { landscape: { width: 1280, height: 720 }, portrait: { width: 390, height: 844 } };
const sizeList = args.size ? args.size.split(',') : ['landscape', 'portrait'];
const quality = args.quality ?? 'high';
const out = args.out ?? 'captures';
const extraFrames = Number(args.frames ?? 2);
const timeout = Number(args.timeout ?? 240000);

fs.mkdirSync(out, { recursive: true });
const log = fs.createWriteStream(path.join(out, 'console.log'), { flags: 'a' });

const server = await createServer({ server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const url = server.resolvedUrls.local[0];

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

let failures = 0;
for (const sizeName of sizeList) {
  const viewport = sizes[sizeName];
  for (const scene of scenes) {
    const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
    page.on('console', (m) => log.write(`[${scene}/${sizeName}] ${m.type()}: ${m.text()}\n`));
    page.on('pageerror', (e) => log.write(`[${scene}/${sizeName}] PAGEERROR: ${e.stack ?? e}\n`));
    const t0 = Date.now();
    try {
      const extra = args.nohud ? '&nohud=1' : '';
      await page.goto(`${url}?capture=1&mute=1&scene=${scene}&quality=${quality}${extra}`, { waitUntil: 'load' });
      await page.waitForFunction(() => window.__READY || window.__BOOT_ERROR, null, { timeout, polling: 250 });
      const err = await page.evaluate(() => window.__BOOT_ERROR);
      if (err) throw new Error(err);
      await page.evaluate((n) => {
        for (let i = 0; i < n; i++) window.__engine.step(1);
      }, extraFrames);
      // let DOM animations (callouts) settle into a visible state
      await page.waitForTimeout(400);
      const file = path.join(out, `${scene}-${sizeName}.png`);
      await page.screenshot({ path: file });
      console.log(`✔ ${file} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    } catch (e) {
      failures++;
      console.log(`✘ ${scene}/${sizeName}: ${String(e.message ?? e).split('\n')[0]}`);
      log.write(`[${scene}/${sizeName}] CAPTURE FAILED: ${e.stack ?? e}\n`);
    }
    await page.close();
  }
}

await browser.close();
await server.close();
log.end();
process.exit(failures ? 1 : 0);
