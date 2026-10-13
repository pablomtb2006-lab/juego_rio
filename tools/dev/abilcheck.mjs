// Fire each ability for real, assert its mechanics, and screenshot the moment it lands.
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 620 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 300)); });
await page.goto(`${server.resolvedUrls.local[0]}?capture=1&mute=1&scene=menu&quality=high`);
await page.waitForFunction(() => window.__READY || window.__BOOT_ERROR, null, { timeout: 300000, polling: 250 });

const shot = async (name) => {
  await page.waitForTimeout(500);
  await page.screenshot({ path: `captures/abil_${name}.png`, timeout: 120000 });
  console.log('shot', name);
};
const run = (fn, arg) => page.evaluate(fn, arg);

// a match, on autopilot until the field has spread out
await run(() => {
  const e = window.__engine; const g = e.ctx.game; g.init(); g.noSlowMo = true;
  g.startMatch({ seed: 777, intro: false, biome: 'templado' });
  g.player.controller.autopilot = true;
  while (g.time < 48 && g.state !== 'result') e.step(10, false);
  g.player.controller.autopilot = false; // from here on the "human" only does what we script
  window.__ev = [];
  for (const k of ['ability', 'wallBreak', 'wallBlocked', 'leechEnd', 'abilityDenied']) e.ctx.bus.on(k, (x) => window.__ev.push(k + ':' + (x.kind ?? '')));
});

// put a smaller rival right in front of the player, on its line
const stage = (vol = 0.5, dist = 150) => run(([vol, dist]) => {
  const g = window.__engine.ctx.game; const p = g.player; const R = g.streams.find((s) => s !== p && s.alive && s.phase === 'flow');
  p.volume = Math.max(p.volume, 400000); p.protectedFor = 0; p.leapCool = 99;
  R.pos.set(p.pos.x + p.heading.x * dist, p.pos.y, p.pos.z + p.heading.y * dist);
  R.pos.y = g.ctx.terrain.heightAt(R.pos.x, R.pos.z) + 1;
  R.heading.copy(p.heading); R.volume = p.volume * vol; R.landedAt = -100; R.protectedFor = 0;
  R.controller = null; // frozen puppet: we drive it
  R.input.steer = 0; R.flowSpeed = 20; R.fogT = 0; R.leechT = 0;
  for (const id of ['wall', 'leech', 'fog']) { p.abil[id] = 0; R.abil[id] = 99; }
  window.__R = R;
  return { rid: R.id, pv: Math.round(p.volume), rv: Math.round(R.volume) };
}, [vol, dist]);

console.log('staged', await stage());

// ---- WALL: telegraph, then the slam, then it blocks the puppet ----
console.log('cast wall', await run(() => window.__engine.ctx.game.abilities.cast(window.__engine.ctx.game.player, 'wall').ok));
await run(() => window.__engine.step(35, true)); await shot('wall_telegraph');
await run(() => window.__engine.step(40, true)); await shot('wall_landed');
const wallInfo = await run(() => {
  const e = window.__engine; const g = e.ctx.game; const R = window.__R; const w = g.abilities.walls[0];
  // drive the puppet straight into the wall and see whether it is stopped
  const out = { walls: g.abilities.walls.length, strength: Math.round(w.strength), rVol: Math.round(R.volume) };
  R.pos.set(w.x - w.dirx * 25, w.y + 1, w.z - w.dirz * 25); R.heading.set(w.dirx, w.dirz); R.vel.set(w.dirx * 20, 0, w.dirz * 20); R.flowSpeed = 20;
  for (let i = 0; i < 90; i++) { e.step(1, false); if (R.alive) { R.vel.set(w.dirx * 20, 0, w.dirz * 20); } }
  const along = (R.pos.x - w.x) * w.dirx + (R.pos.z - w.z) * w.dirz;
  out.puppetAlong = +along.toFixed(1); out.blockedBy = !!R.lastWall; out.broken = w.broken;
  return out;
});
console.log('wall', JSON.stringify(wallInfo));
await run(() => window.__engine.step(2, true)); await shot('wall_blocked');

// ---- a BIGGER river smashes it ----
console.log('staged', await stage(0.5, 150));
const smash = await run(() => {
  const e = window.__engine; const g = e.ctx.game; const R = window.__R; const p = g.player;
  g.abilities.walls.length = 0;
  R.volume = p.volume * 0.5; g.abilities.cast(p, 'wall'); const w = g.abilities.walls[0];
  e.step(80, false);
  R.volume = w.strength * 1.5; // now it is bigger than the wall
  R.pos.set(w.x - w.dirx * 12, w.y + 1, w.z - w.dirz * 12); R.vel.set(w.dirx * 20, 0, w.dirz * 20);
  for (let i = 0; i < 40; i++) e.step(1, false);
  return { broken: w.broken };
});
console.log('smash', JSON.stringify(smash));
await run(() => window.__engine.step(6, true)); await shot('wall_smash');

// ---- LEECH ----
console.log('staged', await stage(0.7, 90));
const leech = await run(() => {
  const e = window.__engine; const g = e.ctx.game; const p = g.player; const R = window.__R;
  g.abilities.walls.length = 0;
  const p0 = p.volume; const r0 = R.volume;
  const ok = g.abilities.cast(p, 'leech').ok;
  e.step(90, false);
  return { ok, drank: Math.round(p.volume - p0), drained: Math.round(R.volume - r0), leechT: +p.leechT.toFixed(2), tethered: !!p.leechTarget };
});
console.log('leech', JSON.stringify(leech));
await run(() => window.__engine.step(3, true)); await shot('leech');
// break the tether by leaping the target away
const brk = await run(() => { const e = window.__engine; const g = e.ctx.game; const R = window.__R; R.pos.x += g.player.heading.x * 400; R.pos.z += g.player.heading.y * 400; e.step(4, false); return { tetherGone: !g.player.leechTarget }; });
console.log('leech break', JSON.stringify(brk));

// ---- FOG ----
console.log('staged', await stage(0.7, 90));
const fog = await run(() => { const e = window.__engine; const g = e.ctx.game; const p = g.player; const R = window.__R; const ok = g.abilities.cast(p, 'fog').ok; e.step(40, true); return { ok, fogT: +R.fogT.toFixed(2) }; });
console.log('fog', JSON.stringify(fog));
await shot('fog');

// ---- the player is the target: the HUD must show it ----
const hit = await run(() => {
  const e = window.__engine; const g = e.ctx.game; const p = g.player; const R = window.__R;
  R.abil.fog = 0; R.volume = 500000; p.protectedFor = 0;
  R.pos.set(p.pos.x + p.heading.x * 60, p.pos.y, p.pos.z + p.heading.y * 60); R.heading.copy(p.heading); R.leaping = false;
  const ok = g.abilities.cast(R, 'fog', p).ok; e.step(30, true); return { ok, playerBlinded: +(p.blinded ?? 0).toFixed(2), fogT: +p.fogT.toFixed(2) };
});
console.log('target is player', JSON.stringify(hit));
await shot('player_fogged');
console.log('events', JSON.stringify(await run(() => window.__ev)));
await browser.close();
await server.close();
