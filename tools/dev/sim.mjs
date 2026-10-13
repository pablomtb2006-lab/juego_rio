// Headless balance harness: run N matches with the player on autopilot, report outcomes.
import { chromium } from 'playwright';
import { createServer } from 'vite';

const N = Number(process.argv[2] ?? 12);
const server = await createServer({ server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto(`${server.resolvedUrls.local[0]}?capture=1&mute=1&scene=menu&quality=low`);
await page.waitForFunction(() => window.__READY || window.__BOOT_ERROR, null, { timeout: 300000, polling: 250 });

const out = await page.evaluate(async (N) => {
  const e = window.__engine;
  const g = e.ctx.game;
  g.init();
  g.noSlowMo = true;
  const res = [];
  const tally = { cast: 0, onPlayer: 0, byPlayer: 0, wall: 0, leech: 0, fog: 0, blockedPlayer: 0 };
  e.ctx.bus.on('ability', ({ kind, caster, target }) => {
    tally.cast++; tally[kind]++;
    if (target === g.player) tally.onPlayer++;
    if (caster === g.player) tally.byPlayer++;
  });
  e.ctx.bus.on('wallBlocked', ({ stream }) => { if (stream === g.player) tally.blockedPlayer++; });
  window.__tally = tally;
  for (let k = 0; k < N; k++) {
    g.startMatch({ seed: 1000 + k * 37, intro: false });
    const p = g.player;
    p.controller.autopilot = true;
    let t = 0;
    const MAX = 400;
    while (t < MAX && g.state !== 'result') {
      e.step(10, false); // no rendering: a balance sim, not a screenshot
      t = g.time;
    }
    res.push({
      seed: 1000 + k * 37,
      zone: Math.round(g.dropZone.x) + ',' + Math.round(g.dropZone.z),
      outcome: g.outcome ?? 'timeout',
      place: p.place ?? p.livePlace ?? null,
      cause: p.eliminatedReason ? p.eliminatedReason + ':' + p.eliminatedHow : null,
      t: +g.time.toFixed(1),
      vol: Math.round(p.peakVolume / 1000),
      alive: g.aliveCount,
      finished: g.finishCount,
    });
  }
  return { res, tally };
}, N);

const { res: outRes, tally } = out;
const wins = outRes.filter((o) => o.place === 1).length;
console.log(JSON.stringify(outRes, null, 0).replace(/},/g, '},\n'));
console.log(`\nWINS ${wins}/${outRes.length} = ${Math.round((wins / outRes.length) * 100)}%`);
const by = {};
for (const o of outRes) by[o.outcome] = (by[o.outcome] ?? 0) + 1;
console.log('outcomes', by);
console.log('avg place', (outRes.reduce((a, o) => a + (o.place ?? 24), 0) / outRes.length).toFixed(1));
console.log('reached the sea: player', outRes.filter((o) => o.outcome === 'win').length, '· anyone', outRes.filter((o) => o.finished > 0).length, '/', outRes.length);
console.log('abilities', JSON.stringify(tally));
console.log('avg match', (outRes.reduce((a, o) => a + o.t, 0) / outRes.length).toFixed(0), 's');
await browser.close();
await server.close();
