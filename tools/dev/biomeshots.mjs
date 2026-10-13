// One screenshot per biome from the same spot, so "the same island, another world" is checkable.
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto(`${server.resolvedUrls.local[0]}?capture=1&mute=1&scene=stream&quality=high`);
await page.waitForFunction(() => window.__READY || window.__BOOT_ERROR, null, { timeout: 300000, polling: 250 });

const ids = await page.evaluate(async () => Object.keys((await import('/src/game/biomes.js')).BIOMES));
for (const id of ids) {
  await page.evaluate(async (id) => {
    const e = window.__engine;
    const { BIOMES, applyBiomeUniforms } = await import('/src/game/biomes.js');
    e.ctx.game.biome = BIOMES[id];
    applyBiomeUniforms(BIOMES[id]);
    e.ctx.atmosphere.setTimeOfDay(BIOMES[id].tod, 0);
    for (let i = 0; i < 4; i++) e.step(1);
  }, id);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `captures/biome_${id}.png`, timeout: 120000 });
  console.log('shot', id);
}
await browser.close();
await server.close();
