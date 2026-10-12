import * as THREE from 'three';

/**
 * FORKS (TRAMO B) — the map stops being a corridor.
 *
 * Water always converges downhill, so a drainage network never really splits. The choice the
 * player gets is lateral: two neighbouring valleys running side by side, separated by a ridge
 * low enough to hop with speed (or with a leap). Those are the forks. Each branch is measured
 * (length to the sea, dams and steepness along it) and labelled:
 *
 *   'short'      CORTA · PELIGROSA   — least distance, most trouble
 *   'safe'       LARGA · SEGURA      — the long way round, little in the way
 *   'obstacles'  OBSTÁCULOS          — middling distance, full of traps
 *
 * Public contract:
 *   forks.list            [{ id, x, z, y, branches: [Branch, Branch], width }]
 *   Branch                { label, points: Vector3[], length, danger, dir: Vector2, color }
 *   forks.nearest(s, r)   { fork, dist, ahead } for a stream, or null
 *   forks.build()         called once after the hydrology exists
 *
 * The gates are drawn by world/props/ForkGates.js, which only reads `list`.
 */

const SEEDS = 28; // routes traced around the drop zone
const STEP = 45; // metres between route samples
const NEAR = 420; // two valleys this close are a choice you can actually make
const APART = 520; // …as long as they stay this far apart downstream (they never merged)
const LOOK = 40; // samples (≈1.8 km) to look ahead
const MIN_GAP = 1100; // metres between forks
const RIDGE_MIN = 5; // below this they are the same valley, not a choice
const RIDGE_MAX = 34; // above this the ridge is a wall, not a hop
const OBSTACLE_PER_KM = 1.7; // a long branch this busy is signed OBSTÁCULOS, not SEGURA
const LEN_DIFF = 0.05; // the two ways out must differ by at least this much to be worth signing

export const FORK_COLORS = { short: 0xff5a3c, safe: 0x4ddc7a, obstacles: 0xffc13d };

export class Forks {
  constructor(game) {
    this.game = game;
    this.list = [];
  }

  /** Geometry only. Obstacles are placed after this, then classify() sets the labels. */
  detect() {
    const { terrain } = this.game.ctx;
    const hydro = this.game.hydro;
    const zone = this.game.dropZone;
    if (!hydro || !zone) return;

    // --- 1) trace the drainage from a ring around the drop zone
    const routes = [];
    for (let k = 0; k < SEEDS; k++) {
      const a = (k / SEEDS) * Math.PI * 2;
      const r = zone.radius * 0.75;
      const x = zone.x + Math.cos(a) * r;
      const z = zone.z + Math.sin(a) * r;
      if (!terrain.isLand(x, z)) continue;
      const pts = [];
      hydro.traceRoute(x, z, 40000, STEP, pts);
      if (pts.length > LOOK) routes.push(pts);
    }
    if (routes.length < 2) return;

    // --- 2+3) every pair of routes: where do they run side by side with a hoppable ridge?
    // (only ~28 routes of ~150 samples, so a direct scan is both simple and fast enough)
    const cands = [];
    for (let A = 0; A < routes.length; A++) {
      for (let B = A + 1; B < routes.length; B++) {
        const ra = routes[A];
        const rb = routes[B];
        let best = null;
        for (let i = 0; i < ra.length; i += 3) {
          for (let j = 0; j < rb.length; j += 3) {
            const pa = ra[i];
            const pb = rb[j];
            const gap = Math.hypot(pa.x - pb.x, pa.z - pb.z);
            if (gap > NEAR || gap < 40) continue;
            // a ridge between them: too low and it is one valley, too high and it is a wall
            const rise = hydro.maxRiseAlong(pa.x, pa.z, pb.x, pb.z, 10);
            if (rise < RIDGE_MIN || rise > RIDGE_MAX) continue;
            // and they must stay separate downstream (they never merge back)
            let apart = 0;
            for (let k = 6; k < LOOK; k++) {
              const qa = ra[i + k];
              const qb = rb[j + k];
              if (!qa || !qb) break;
              apart = Math.max(apart, Math.hypot(qa.x - qb.x, qa.z - qb.z));
            }
            if (apart < APART) continue;
            if (!best || apart > best.split) best = { ra: A, ia: i, rb: B, ib: j, split: apart, x: (pa.x + pb.x) / 2, z: (pa.z + pb.z) / 2 };
          }
        }
        if (best) cands.push(best);
      }
    }

    // --- 4) keep the clearest forks, well spread out, highest up first
    cands.sort((a, b) => b.split - a.split);
    const picked = [];
    for (const c of cands) {
      if (picked.length >= 6) break;
      if (picked.some((p) => Math.hypot(p.x - c.x, p.z - c.z) < MIN_GAP)) continue;
      picked.push(c);
    }

    // --- 5) build the forks (labels come later, once the obstacles exist)
    this.list = picked
      .map((c, id) => {
        const a = this.measure(routes[c.ra].slice(c.ia));
        const b = this.measure(routes[c.rb].slice(c.ib));
        if (Math.abs(a.length - b.length) < Math.max(a.length, b.length) * LEN_DIFF) return null;
        return {
          id,
          x: c.x,
          z: c.z,
          y: terrain.heightAt(c.x, c.z),
          width: Math.max(60, Math.min(180, c.split * 0.12)),
          branches: [a, b],
        };
      })
      .filter(Boolean)
      .map((f, id) => ({ ...f, id }));
    for (const f of this.list) f.shortBranch = f.branches[0].length <= f.branches[1].length ? f.branches[0] : f.branches[1];
  }

  /**
   * Label the branches once the dams are placed. Danger is counted per kilometre, otherwise the
   * long way round always "wins" simply by being long.
   */
  classify() {
    for (const f of this.list) {
      const [a, b] = f.branches;
      for (const br of [a, b]) {
        br.danger = this.dangerOf(br);
        br.perKm = br.danger / Math.max(1, br.length / 1000);
      }
      const [shortB, longB] = a.length <= b.length ? [a, b] : [b, a];
      shortB.label = 'short';
      // if the long way round is the nastier one, say so instead of calling it safe
      longB.label = longB.perKm > shortB.perKm * 1.1 || longB.perKm > OBSTACLE_PER_KM ? 'obstacles' : 'safe';
      for (const br of [a, b]) br.color = FORK_COLORS[br.label];
    }
  }

  /** Dams and plunges along a branch. */
  dangerOf(br) {
    const dams = this.game.obstacles?.dams ?? [];
    let danger = br.steep / 400; // a plunging route is its own kind of trouble
    for (const d of dams) {
      for (let i = 0; i < br.points.length; i += 2) {
        if (Math.hypot(d.x - br.points[i].x, d.z - br.points[i].z) < 80) {
          danger += d.strength / 700000; // a dam you cannot break is worse than one you can
          break;
        }
      }
    }
    return danger;
  }

  /** Length to the sea, total drop, and the direction out of the fork. */
  measure(points) {
    let length = 0;
    let steep = 0;
    for (let i = 1; i < points.length; i++) {
      const p = points[i];
      const q = points[i - 1];
      length += Math.hypot(p.x - q.x, p.z - q.z);
      steep += Math.max(0, q.y - p.y);
    }
    const dir = new THREE.Vector2(1, 0);
    const far = points[Math.min(6, points.length - 1)];
    if (far && points[0]) dir.set(far.x - points[0].x, far.z - points[0].z).normalize();
    return { points, length, steep, danger: 0, perKm: 0, dir, label: 'safe', color: FORK_COLORS.safe };
  }

  /** The fork a stream is approaching, if any. `ahead` is 1 when it is dead in front. */
  nearest(s, range = 420) {
    let best = null;
    let bestD = range;
    for (const f of this.list) {
      const dx = f.x - s.pos.x;
      const dz = f.z - s.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > bestD) continue;
      const ahead = d > 1 ? (dx * s.heading.x + dz * s.heading.y) / d : 1;
      if (ahead < 0.35) continue;
      bestD = d;
      best = { fork: f, dist: d, ahead };
    }
    return best;
  }
}
