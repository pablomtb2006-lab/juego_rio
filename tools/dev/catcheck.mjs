// Fire every catastrophe in turn and assert its effects actually land.
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto(`${server.resolvedUrls.local[0]}?capture=1&mute=1&scene=menu&quality=low`);
await page.waitForFunction(() => window.__READY || window.__BOOT_ERROR, null, { timeout: 300000, polling: 250 });

const out = await page.evaluate(async () => {
  const e = window.__engine;
  const g = e.ctx.game;
  g.init();
  g.noSlowMo = true;
  const kinds = Object.keys(await import('/src/game/Catastrophe.js').then((m) => m.CATASTROPHES));
  const rows = [];
  for (const kind of kinds) {
    g.startMatch({ seed: 4242, intro: false });
    g.player.controller.autopilot = true;
    while (g.time < 40 && g.state !== 'result') e.step(10, false);
    const c = g.catastrophe;
    c.kind = kind;
    c.def = (await import('/src/game/Catastrophe.js')).CATASTROPHES[kind];
    c.at = g.time + 1;
    c.phase = 'idle';
    const seen = { warn: false, start: false, end: false };
    e.ctx.bus.on('catWarn', () => (seen.warn = true));
    e.ctx.bus.on('catStart', () => (seen.start = true));
    e.ctx.bus.on('catEnd', () => (seen.end = true));
    const t0 = g.time;
    let peakEvap = 0;
    let frontSeen = 0;
    let dams = 0;
    while (g.time - t0 < c.def.warn + c.def.duration + 3 && g.state !== 'result') {
      e.step(10, false);
      if (c.phase === 'active') {
        peakEvap = Math.max(peakEvap, g.player.catEvap ?? 1);
        if (c.front) frontSeen = Math.max(frontSeen, 1);
        dams = Math.max(dams, (g.obstacles?.dams ?? []).filter((d) => d.broken).length);
      }
    }
    rows.push({ kind, ...seen, phase: c.phase, peakEvap: +peakEvap.toFixed(2), frontSeen, dams, alive: g.player.alive });
  }
  return rows;
});
console.log(out.map((r) => JSON.stringify(r)).join('\n'));
await browser.close();
await server.close();
