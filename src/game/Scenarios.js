import * as THREE from 'three';
import { archGate } from './arch.js';
import { PHYS } from './StreamPhysics.js';

/**
 * Deterministic set-ups for screenshots / visual review (tools/capture.mjs).
 * Load with ?capture=1&scene=<name>. Each scenario prepares the state by stepping
 * the simulation (fast-forward = sim + camera only; the last moments run full engine
 * ticks so every visual system is warm), then sets window.__READY = true.
 *
 * Set-ups search the world at runtime (no hard-coded coordinates), so they keep
 * working when the terrain changes. Every element of the game loop has a scenario.
 */
export const SCENARIOS = {
  menu: async (game) => {
    game.toMenu();
    advance(game, 90, null, true);
  },

  /** Skydiving among the clouds, rivals falling around, the island below. */
  drop: async (game) => {
    start(game);
    advance(game, 60 * 3.2);
    advance(game, 60 * 2.2, null, true);
  },

  /** The drop streaking through the summit arch, seen from below through the opening (ref_006). */
  arch: async (game) => {
    start(game);
    const arch = game.ctx.world.landmarks?.arch;
    const p = game.player;
    if (arch) {
      const { center: A, normal: n, radius: R } = archGate(arch);
      const h = 300;
      const glide = PHYS.dropHoriz[1] / PHYS.dropFall[1];
      p.pos.set(A.x + n.x * h * glide, A.y + h, A.z + n.z * h * glide);
      p.heading.set(-n.x, -n.z).normalize();
      p.vel.set(p.heading.x * PHYS.dropHoriz[1], -PHYS.dropFall[1], p.heading.y * PHYS.dropHoriz[1]);
      p.controller.autopilot = false; // hands off: fall straight through
      game.input.steer = 0;
      game.cameraDirector.setMode('drop', { target: p, snap: true });
      advance(game, 60 * 4, () => p.pos.y < A.y + R * 0.3, true);
    } else {
      advance(game, 60 * 20, () => p.pos.y < 1800, true);
    }
  },

  /** The impact: a giant drop smashing into the mountain and bursting into a torrent. */
  landing: async (game) => {
    start(game);
    const p = game.player;
    const zone = game.dropZone;
    const spot = findRiverSpot(game, { yMin: 350, routeMin: 1800, minChannel: 0.3, within: zone });
    if (spot) p.controller.ai.dropTarget = spot;
    advance(game, 60 * 60, () => p.pos.y - game.ctx.terrain.heightAt(p.pos.x, p.pos.z) < 260);
    advance(game, 60 * 10, () => p.phase === 'flow', true);
    advance(game, 16, null, true);
  },

  /** Low chase camera mid-race, a rival in view. */
  stream: async (game) => {
    start(game);
    const p = game.player;
    land(game);
    const spot = findRiverSpot(game, { yMin: 250, routeMin: 1800 }) ?? findRiverSpot(game, { yMin: 120, routeMin: 1000 });
    if (spot) approach(game, p, spot);
    // a smaller rival a little further down the same river (name tag in shot)
    const rival = game.streams.find((s) => s !== p && s.alive && s.personality === 'sprinter') ?? game.streams.find((s) => s !== p && s.alive);
    if (rival) {
      const route = game.hydro.traceRoute(p.pos.x, p.pos.z, 170, 4);
      if (route.length > 30) {
        teleport(game, rival, route[route.length - 1].x, route[route.length - 1].z, { volume: p.volume * 0.55, speed: 24, keep: true });
        rival.trail.clear();
        for (let i = Math.floor(route.length * 0.45); i < route.length; i++) rival.trail.push(route[i].x, route[i].y, route[i].z, rival.radius);
      }
    }
    advance(game, 50, null, true);
  },

  /** Mid-swallow of a big lake (the counter racing up by millions). */
  lake: async (game) => {
    start(game);
    const p = game.player;
    land(game);
    // prefer lakes whose surface agrees with the drainage (a real basin), biggest first
    const fit = (b) => Math.abs(game.hydro.surfaceAt(b.x, b.z) - b.y) < 8;
    const lakes = (game.ctx.world.lakes?.bodies ?? [])
      .filter((b) => b.kind === 'lake')
      .sort((a, b) => (fit(b) - fit(a)) * 1e12 + b.maxVolume - a.maxVolume);
    let placed = false;
    for (const lake of lakes) {
      const from = upstreamOf(game, lake.x, lake.z, lake.radius * 0.6, lake.radius + 140, lake.radius + 420);
      if (!from) continue;
      teleport(game, p, from.x, from.z, { volume: 2.2e6, speed: 30 });
      placed = true;
      break;
    }
    const target = () => p.absorbBody?.kind === 'lake' && p.absorbBody.volume < p.absorbBody.maxVolume * 0.62;
    advance(game, 60 * (placed ? 30 : 120), () => target() || !p.alive);
    advance(game, 30, null, true);
  },

  /** A bigger rival cutting across right in front of you — name tag in view, danger rising. */
  rival: async (game) => {
    start(game);
    const p = game.player;
    land(game, 4e5);
    const spot = findRiverSpot(game, { yMin: 200, routeMin: 1500, wallMin: 8 }) ?? findRiverSpot(game, { yMin: 100, routeMin: 900 });
    if (spot) approach(game, p, spot);
    const rival = game.streams.find((s) => s !== p && s.alive && s.personality === 'bully') ?? game.streams.find((s) => s !== p && s.alive);
    if (rival) {
      const cross = findCrossing(game, p);
      const volume = Math.max(p.volume * 2.6, 6e5);
      teleport(game, rival, cross.head.x, cross.head.z, { volume, speed: 30, keep: true });
      rival.trail.clear();
      for (const q of cross.channel) rival.trail.push(q.x, q.y, q.z, rival.radius);
      rival.heading.copy(cross.dir);
      rival.pos.set(cross.head.x, game.hydro.waterY(cross.head.x, cross.head.z, rival.radius), cross.head.z);
      rival.controller.routeOnly = 0;
      p.protectedFor = 0;
    }
    advance(game, 14, null, true);
  },

  /** Hugging the water at speed through the forest. */
  forest: async (game) => {
    start(game);
    const p = game.player;
    land(game);
    const spot = findRiverSpot(game, { yMin: 60, yMax: 520, routeMin: 500, gentle: 1 });
    if (spot) approach(game, p, spot);
    else {
      const isForest = () => p.pos.y < 560 && p.pos.y > 30 && game.ctx.terrain.normalAt(p.pos.x, p.pos.z).y > 0.86;
      advance(game, 60 * 240, () => isForest() || !p.alive);
    }
    advance(game, 45, null, true);
  },

  /** First to the sea: victory crane over the coast, shockwave, "#1". */
  sea: async (game) => {
    start(game);
    const p = game.player;
    land(game);
    // put the player a short run from a river mouth so it wins deterministically
    const mouth = findMouth(game);
    if (mouth) teleport(game, p, mouth.x, mouth.z, { volume: 3.1e6, speed: 32 });
    advance(game, 60 * 90, () => p.phase === 'finished' || !p.alive);
    advance(game, 60 * 3.4, null, true);
  },

  /** Full map open mid-race. */
  map: async (game) => {
    start(game);
    land(game);
    advance(game, 60 * 18);
    const spot = findRiverSpot(game, { yMin: 200, routeMin: 1500 });
    if (spot) approach(game, game.player, spot, 12);
    advance(game, 20, null, true);
    game.ctx.ui?.showMap?.(true);
  },
};

// --- helpers --------------------------------------------------------------------------

function start(game, seed = 1) {
  game.startMatch({ seed, intro: false });
  if (game.player?.controller) game.player.controller.autopilot = true;
}

/**
 * Fast-forward until the player has landed. Review shots show a healthy mid-race river
 * (the trailer's HUD reads ~2.4M L), so the player gets topped up to `volume`.
 */
function land(game, volume = 1.6e6) {
  const p = game.player;
  advance(game, 60 * 60, () => p.phase !== 'drop');
  if (volume && p.alive) {
    p.volume = Math.max(p.volume, volume);
    p.peakVolume = Math.max(p.peakVolume, p.volume);
  }
  // let the impact settle into the chase cam
  advance(game, 60 * 2);
}

/** A rival in front of the player, inside a cone (cos) and distance band. */
function rivalAhead(game, dMin, dMax, cos) {
  const p = game.player;
  if (!p || p.phase !== 'flow') return true;
  for (const s of game.streams) {
    if (s === p || s.phase !== 'flow') continue;
    const dx = s.pos.x - p.pos.x;
    const dz = s.pos.z - p.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < dMin || d > dMax) continue;
    if ((dx * p.heading.x + dz * p.heading.y) / d > cos) return true;
  }
  return false;
}

/**
 * A point whose drainage route passes within `tol` of (tx, tz), between rMin and rMax away
 * (largest first, so there's a proper approach run). Deterministic.
 */
export function upstreamOf(game, tx, tz, tol, rMin, rMax) {
  const hydro = game.hydro;
  const route = [];
  for (let r = rMax; r >= rMin; r -= 40) {
    for (let a = 0; a < 32; a++) {
      const x = tx + Math.cos((a / 32) * Math.PI * 2) * r;
      const z = tz + Math.sin((a / 32) * Math.PI * 2) * r;
      if (!game.ctx.terrain.isLand(x, z)) continue;
      hydro.traceRoute(x, z, r * 1.8, 10, route);
      for (const q of route) {
        if ((q.x - tx) ** 2 + (q.z - tz) ** 2 < tol * tol) return { x, z };
      }
    }
  }
  return null;
}

/**
 * A natural drainage route that crosses the player's predicted path 45–80 m ahead at a steep
 * angle: returns the channel (points up to the crossing and a bit beyond), the rival's head
 * position just past the crossing and its direction.
 */
function findCrossing(game, p) {
  const hydro = game.hydro;
  const path = game.cameraDirector.predictPath(p, 110, 6).map((v) => v.clone());
  const fx = p.heading.x;
  const fz = p.heading.y;
  const route = [];
  let best = null;
  for (const side of [1, -1]) {
    for (const lat of [70, 110, 150, 200]) {
      for (const fwd of [20, 50, 80, 110]) {
        const x = p.pos.x + fx * fwd - fz * lat * side;
        const z = p.pos.z + fz * fwd + fx * lat * side;
        if (!game.ctx.terrain.isLand(x, z)) continue;
        hydro.traceRoute(x, z, lat * 2.2, 6, route);
        for (let i = 1; i < route.length; i++) {
          const q = route[i];
          for (let k = 6; k < path.length; k++) {
            const P = path[k];
            const dist = Math.hypot(q.x - P.x, q.z - P.z);
            if (dist > 7) continue;
            const ahead = k * 6;
            const tx = q.x - route[i - 1].x;
            const tz = q.z - route[i - 1].z;
            const tl = Math.hypot(tx, tz) || 1;
            const cos = (tx * fx + tz * fz) / tl; // >0: the rival is heading away from us
            // a diagonal cut ahead (53–70°), moving away so its head stays in frame
            const score = -Math.abs(ahead - 45) / 15 - Math.abs(cos - 0.55) * 4 - Math.abs(q.y - P.y) / 12;
            if (cos > 0.2 && cos < 0.6 && ahead >= 30 && ahead <= 70 && (!best || score > best.score)) {
              // resample at the physics trail spacing, ending ~40 m past the crossing
              const pts = [];
              let travelled = 0;
              for (let n = 0; n < route.length; n++) {
                if (n > 0) travelled += Math.hypot(route[n].x - route[n - 1].x, route[n].z - route[n - 1].z);
                if (n > i && travelled - i * 6 > 34) break;
                pts.push(route[n]);
              }
              const channel = [];
              for (let n = 1; n < pts.length; n++) {
                const a = pts[n - 1];
                const b = pts[n];
                const L = Math.hypot(b.x - a.x, b.z - a.z);
                for (let d = 0; d < L; d += 4) channel.push(new THREE.Vector3().lerpVectors(a, b, d / L));
              }
              const head = pts[pts.length - 1].clone();
              const prev = pts[Math.max(0, pts.length - 2)];
              best = { score, channel, head, dir: new THREE.Vector2(head.x - prev.x, head.z - prev.z).normalize() };
            }
          }
        }
      }
    }
  }
  if (best) return best;
  // fallback: a straight channel across the path
  const P = path[Math.min(path.length - 1, 10)] ?? p.pos;
  const channel = [];
  for (let d = -150; d <= 36; d += 4) {
    const x = P.x - fz * d;
    const z = P.z + fx * d;
    channel.push(new THREE.Vector3(x, hydro.waterY(x, z), z));
  }
  return { channel, head: channel[channel.length - 1], dir: new THREE.Vector2(-fz, fx) };
}

/**
 * A photogenic stretch of river for a review shot: a main channel that is flowing (not a pool,
 * healthy slope), with room for the camera (no canyon walls), inside an altitude band.
 */
export function findRiverSpot(game, { yMin = 80, yMax = 1e4, routeMin = 900, routeMax = 1e5, minChannel = 0.5, gentle = 0, wallMin = 0, within = null } = {}) {
  const hydro = game.hydro;
  const terrain = game.ctx.terrain;
  const { res, H, filled, parent, routeDist, acc } = hydro;
  const logMax = Math.log(hydro.maxAcc);
  const n = new THREE.Vector3();
  let best = null;
  let bestScore = -Infinity;
  for (let j = 4; j < res - 4; j += 2) {
    for (let i = 4; i < res - 4; i += 2) {
      const k = j * res + i;
      const h = H[k];
      if (h < yMin || h > yMax || filled[k] - h > 0.3) continue;
      const rd = routeDist[k];
      if (rd < routeMin || rd > routeMax) continue;
      const ch = Math.log(Math.max(1, acc[k])) / logMax;
      if (ch < minChannel) continue;
      let c = k;
      for (let m = 0; m < 5 && parent[c] >= 0; m++) c = parent[c];
      const di = (c % res) - i;
      const dj = ((c / res) | 0) - j;
      const dl = Math.hypot(di, dj) || 1;
      const slope = (h - H[c]) / (dl * hydro.cell);
      if (slope < 0.035 || slope > 0.32) continue;
      const [x, z] = hydro.toWorld(i, j);
      if (within && Math.hypot(x - within.x, z - within.z) > within.radius * 0.9) continue;
      const px = -dj / dl;
      const pz = di / dl;
      let wall = 0;
      let ok = true;
      for (const side of [-1, 1]) {
        for (const d of [25, 55, 90]) {
          const w = terrain.heightAt(x + px * d * side, z + pz * d * side) - h;
          wall = Math.max(wall, w);
          if (w > 26 + d * 0.5) ok = false;
        }
      }
      // the way ahead must stay open too (no wall right in front of the lens)
      for (const d of [30, 60]) if (terrain.heightAt(x + (di / dl) * d, z + (dj / dl) * d) > h + 12) ok = false;
      if (!ok || wall < wallMin) continue;
      let g = 0;
      if (gentle) {
        for (const d of [50, 110]) {
          for (let a = 0; a < 6; a++) g += terrain.normalAt(x + Math.cos(a) * d, z + Math.sin(a) * d, n).y > 0.86 ? 1 : 0;
        }
      }
      const score = ch * 2 + Math.min(wall, 40) / 40 - Math.abs(slope - 0.12) * 5 + g * 0.2 * gentle;
      if (score > bestScore) {
        bestScore = score;
        best = { x, z, y: h };
      }
    }
  }
  return best;
}

/** Run a stream into `spot` from a little upstream so it arrives with a natural channel. */
function approach(game, s, spot, maxSeconds = 25) {
  const from = upstreamOf(game, spot.x, spot.z, 14, 150, 330) ?? spot;
  const target = game.hydro.routeDistAt(spot.x, spot.z);
  teleport(game, s, from.x, from.z, { speed: 26 });
  advance(game, 60 * maxSeconds, () => !s.alive || s.routeDist <= target + 5 || Math.hypot(s.pos.x - spot.x, s.pos.z - spot.z) < 25);
}

/** A spot ~400 m upstream of the sea on a main river (good mouth for the victory shot). */
function findMouth(game) {
  const hydro = game.hydro;
  const { res } = hydro;
  let best = null;
  let bestScore = -Infinity;
  for (let j = 2; j < res - 2; j += 3) {
    for (let i = 2; i < res - 2; i += 3) {
      const k = j * res + i;
      const rd = hydro.routeDist[k];
      if (hydro.H[k] <= 0 || rd < 380 || rd > 520) continue;
      const score = Math.log(hydro.acc[k]) + hydro.H[k] / 60;
      if (score > bestScore) {
        bestScore = score;
        const [x, z] = hydro.toWorld(i, j);
        best = { x, z };
      }
    }
  }
  return best;
}

/** Drop a stream onto the river network at (x, z), flowing, with a fresh channel. */
function teleport(game, s, x, z, { volume, speed = 25, keep = false } = {}) {
  const hydro = game.hydro;
  if (s.phase === 'drop') {
    s.phase = 'flow';
    s.landedAt = game.time;
  }
  if (volume) {
    s.volume = volume;
    s.peakVolume = Math.max(s.peakVolume, volume);
  }
  s.protectedFor = 0;
  s.pos.set(x, hydro.waterY(x, z, s.radius), z);
  const dir = hydro.flowDirAt(x, z);
  if (dir.lengthSq() > 0.5) s.heading.copy(dir);
  s.flowSpeed = speed;
  s.vel.set(s.heading.x * speed, 0, s.heading.y * speed);
  s.routeDist = hydro.routeDistAt(x, z);
  s.landRouteDist = Math.max(s.routeDist, 1);
  if (!keep) {
    s.trail.clear();
    s.trail.push(s.pos.x, s.pos.y, s.pos.z, s.radius);
  }
  if (s === game.player) {
    game.cameraDirector.setMode('chase', { target: s, snap: true });
    if (game.state !== 'stream') game.setState('stream');
  }
}

/**
 * Step the engine up to `frames` fixed frames, stopping early when `until()` is true.
 * full=false fast-forwards (simulation + camera only, no world/UI/audio updates);
 * full=true runs complete engine ticks (still without rendering).
 */
export function advance(game, frames, until = null, full = false) {
  const engine = game.ctx.engine;
  const dt = 1 / 60;
  for (let i = 0; i < frames; i++) {
    if (full && engine) engine.tick(dt);
    else {
      game.fixedUpdate(dt);
      game.ctx.dt = dt;
      game.update(dt);
    }
    if (until && until()) break;
  }
}

export async function runScenario(game, name) {
  const fn = SCENARIOS[name];
  if (!fn) {
    console.warn(`Unknown scenario "${name}". Available: ${Object.keys(SCENARIOS).join(', ')}`);
    window.__READY = true;
    return;
  }
  game.ensureWorldData?.();
  await fn(game);
  window.__READY = true;
}
