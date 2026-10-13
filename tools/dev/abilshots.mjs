// Clean beauty shots of each ability: bots do not interfere, the rival is a puppet 30 m ahead.
import { chromium } from 'playwright';
import { createServer } from 'vite';
const server = await createServer({ server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1100, height: 620 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto(`${server.resolvedUrls.local[0]}?capture=1&mute=1&scene=menu&quality=high`);
await page.waitForFunction(() => window.__READY || window.__BOOT_ERROR, null, { timeout: 300000, polling: 250 });
const cropShot = async (n, what = 'wall') => {
  await page.waitForTimeout(400);
  const c = await page.evaluate((what) => {
    const e = window.__engine; const g = e.ctx.game; const cam = e.ctx.camera;
    const w = g.abilities.walls[0]; const R = window.__R;
    const p = what === 'wall' && w ? { x: w.x, y: w.y + 6, z: w.z } : { x: (g.player.pos.x + R.pos.x) / 2, y: g.player.pos.y + 6, z: (g.player.pos.z + R.pos.z) / 2 };
    const v = new (cam.position.constructor)(p.x, p.y, p.z).project(cam);
    return { x: (v.x * 0.5 + 0.5) * innerWidth, y: (-v.y * 0.5 + 0.5) * innerHeight, front: v.z < 1 };
  }, what);
  console.log(n, 'screen', JSON.stringify(c));
  const x = Math.max(0, Math.min(1100 - 520, Math.round(c.x - 260)));
  const y = Math.max(0, Math.min(620 - 340, Math.round(c.y - 170)));
  await page.screenshot({ path: `captures/abil_${n}.png`, clip: { x, y, width: 520, height: 340 }, timeout: 120000 });
  console.log('crop', n);
};
const shot = async (n) => { await page.waitForTimeout(500); await page.screenshot({ path: `captures/abil_${n}.png`, timeout: 120000 }); console.log('shot', n); };
await page.evaluate(() => {
  const e = window.__engine; const g = e.ctx.game; g.init(); g.noSlowMo = true;
  g.startMatch({ seed: 777, intro: false, biome: 'templado' });
  g.difficulty = { ...g.difficulty, abilityAI: false }; // the bots stay out of the shot
  g.player.controller.autopilot = true;
  while (g.time < 40 && g.state !== 'result') e.step(10, false);
  g.player.controller.autopilot = false;
  g.abilities.walls.length = 0;
});
const stage = (dist) => page.evaluate((dist) => {
  const e = window.__engine; const g = e.ctx.game; const p = g.player;
  const R = g.streams.find((s) => s !== p && s.alive && s.phase === 'flow');
  R.controller = null; R.landedAt = -100; R.protectedFor = 0; p.protectedFor = 0;
  // follow the drainage from the player, so the puppet (and the wall in front of it) sit IN the valley
  const pts = [];
  g.hydro.traceRoute(p.pos.x, p.pos.z, 400, 10, pts);
  const i = Math.max(1, Math.min(pts.length - 2, Math.round(dist / 10)));
  const a = pts[i], b = pts[i + 1];
  const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1;
  R.volume = p.volume * 0.6; R.flowSpeed = 14; R.vel.set(0, 0, 0);
  R.heading.set(dx / l, dz / l);
  R.pos.set(a.x, g.ctx.terrain.heightAt(a.x, a.z) + 1, a.z);
  for (const id of ['wall', 'leech', 'fog']) { p.abil[id] = 0; R.abil[id] = 99; }
  window.__R = R;
}, dist);

await stage(10);
await page.evaluate(() => { const g = window.__engine.ctx.game; g.abilities.cast(g.player, 'wall', window.__R); window.__engine.step(40, true); });
await cropShot('A_telegraph');
await page.evaluate(() => window.__engine.step(32, true)); await cropShot('B_rising');
await page.evaluate(() => window.__engine.step(40, true)); await cropShot('C_standing');

await page.evaluate(() => { const g = window.__engine.ctx.game; g.abilities.walls.length = 0; });
await stage(60);
await page.evaluate(() => { const e = window.__engine; const g = e.ctx.game; g.abilities.cast(g.player, 'leech', window.__R); e.step(50, true); });
await cropShot('D_leech', 'mid');

await stage(40);
await page.evaluate(() => { const e = window.__engine; const g = e.ctx.game; g.abilities.cast(g.player, 'fog', window.__R); e.step(60, true); });
await cropShot('E_steam', 'mid');
await shot('F_full');
await browser.close(); await server.close();
