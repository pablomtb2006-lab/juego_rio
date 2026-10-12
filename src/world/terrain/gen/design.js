// The designed (pre-erosion) island. Art-directable large-scale structure that the erosion
// passes then make believable:
//   - a main crest through the centre carrying the summit (arch landmark) and sub-peaks
//   - radial arms (spurs) descending to the coast with broad valleys between them → routes
//   - mid-altitude plateaus with flat tops (lakes) and steep rims
//   - a seaward ramp so every route keeps flowing downhill

import { createNoise2D } from '../../../core/random.js';
import { fbm, ridged, sstep } from './noise.js';

/** Polynomial smooth max. */
const smax = (a, b, k) => {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.max(a, b) + h * h * k * 0.25;
};

/** Distance from (x,z) to a polyline → out = [distance, arc length at closest point, total length]. */
function polyDist(pts, x, z, out) {
  let best = 1e18;
  let along = 0;
  let acc = 0;
  for (let s = 0; s < pts.length - 1; s++) {
    const ax = pts[s][0];
    const az = pts[s][1];
    const vx = pts[s + 1][0] - ax;
    const vz = pts[s + 1][1] - az;
    const L2 = vx * vx + vz * vz;
    let t = ((x - ax) * vx + (z - az) * vz) / L2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = x - (ax + vx * t);
    const dz = z - (az + vz * t);
    const d2 = dx * dx + dz * dz;
    const segL = Math.sqrt(L2);
    if (d2 < best) {
      best = d2;
      along = acc + t * segL;
    }
    acc += segL;
  }
  out[0] = Math.sqrt(best);
  out[1] = along;
  out[2] = acc;
  return out;
}

export function makeDesign(size, rand) {
  const nWarp = createNoise2D(rand);
  const nCoast = createNoise2D(rand);
  const nMount = createNoise2D(rand);
  const nDetail = createNoise2D(rand);
  const nK = createNoise2D(rand);
  const R0 = size * 0.355;
  const ea = rand() * Math.PI;
  const ax = Math.cos(ea);
  const az = Math.sin(ea);
  const ma = rand() * Math.PI * 2;
  const cx = Math.cos(ma) * size * 0.03;
  const cz = Math.sin(ma) * size * 0.03;

  // main crest along the island's long axis
  const crest = [];
  const crestLen = R0 * (0.75 + rand() * 0.2);
  for (let s = 0; s <= 6; s++) {
    const t = s / 6 - 0.5;
    const off = (rand() - 0.5) * 900;
    crest.push([cx + ax * t * crestLen - az * off, cz + az * t * crestLen + ax * off]);
  }
  const summitT = 0.35 + rand() * 0.3; // where along the crest the highest peak sits
  const crestPeaks = [];
  for (let k = 0; k < 5; k++) {
    crestPeaks.push({ t: k === 0 ? summitT : 0.08 + rand() * 0.84, h: k === 0 ? 1 : 0.78 + rand() * 0.12, w: 0.06 + rand() * 0.05 });
  }

  // arms: spurs leaving the crest towards the coast, alternating sides
  const arms = [];
  const armCount = 7 + Math.floor(rand() * 3);
  for (let k = 0; k < armCount; k++) {
    const side = k % 2 ? 1 : -1;
    const t = (k + 0.5) / armCount + (rand() - 0.5) * 0.08;
    const si = Math.min(5, Math.floor(t * 6));
    const ft = t * 6 - si;
    const sx = crest[si][0] + (crest[si + 1][0] - crest[si][0]) * ft;
    const sz = crest[si][1] + (crest[si + 1][1] - crest[si][1]) * ft;
    // perpendicular to the crest, fanned out towards the crest ends
    let a = Math.atan2(az, ax) + side * (Math.PI / 2) - (t - 0.5) * side * 1.6 + (rand() - 0.5) * 0.5;
    const len = R0 * (0.6 + rand() * 0.3);
    const pts = [[sx, sz]];
    let px = sx;
    let pz = sz;
    const segs = 7;
    for (let s = 0; s < segs; s++) {
      a += (rand() - 0.5) * 0.5;
      px += Math.cos(a) * (len / segs);
      pz += Math.sin(a) * (len / segs);
      pts.push([px, pz]);
    }
    arms.push({ pts, h: 0.5 + rand() * 0.2, w: 1300 + rand() * 600, end: 0.08 + rand() * 0.1, ph: rand() * 10 });
  }
  // the two crest ends continue as arms too
  for (const e of [0, 1]) {
    const p0 = e ? crest[6] : crest[0];
    let a = Math.atan2(az, ax) + (e ? 0 : Math.PI) + (rand() - 0.5) * 0.4;
    const len = R0 * (0.5 + rand() * 0.2);
    const pts = [[p0[0], p0[1]]];
    let px = p0[0];
    let pz = p0[1];
    for (let s = 0; s < 5; s++) {
      a += (rand() - 0.5) * 0.5;
      px += Math.cos(a) * (len / 5);
      pz += Math.sin(a) * (len / 5);
      pts.push([px, pz]);
    }
    arms.push({ pts, h: 0.55, w: 1500, end: 0.1, ph: rand() * 10 });
  }

  // plateaus between arms at mid radius (flat tops → lakes)
  const plateaus = [];
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2 + rand() * 1.5;
    const r = R0 * (0.36 + rand() * 0.2);
    plateaus.push({
      x: cx + Math.cos(a) * r,
      z: cz + Math.sin(a) * r,
      rx: 900 + rand() * 600,
      rz: 650 + rand() * 450,
      rot: rand() * Math.PI,
      h: 0.34 + rand() * 0.12,
    });
  }

  function landAt(x, z) {
    const wx = x + 1500 * fbm(nWarp, x / 7000, z / 7000, 3) + 450 * fbm(nWarp, x / 1700 + 9, z / 1700 - 4, 3);
    const wz = z + 1500 * fbm(nWarp, x / 7000 + 31, z / 7000 + 7, 3) + 450 * fbm(nWarp, x / 1700 - 2, z / 1700 + 11, 3);
    const dx = wx - cx * 0.6;
    const dz = wz - cz * 0.6;
    const u = dx * ax + dz * az;
    const v = -dx * az + dz * ax;
    const r = Math.hypot(u / 1.13, v / 0.9) / R0;
    let m = 1 - Math.pow(r, 2.6);
    m += 0.5 * fbm(nCoast, wx / 5200, wz / 5200, 5, 2.1, 0.55);
    return m;
  }

  const tmp = [0, 0, 0];
  function reliefAt(x, z, dIn) {
    // seaward ramp rising inland
    const base = 0.04 + 0.3 * sstep(0, R0 * 0.85, dIn);
    // crest
    polyDist(crest, x, z, tmp);
    const ct = tmp[1] / tmp[2];
    let ch = 0.68;
    for (const p of crestPeaks) ch = Math.max(ch, p.h * Math.exp(-Math.pow((ct - p.t) / p.w, 2)));
    const cw = 2000;
    let hgt = base;
    if (tmp[0] < cw) {
      const q = 1 - tmp[0] / cw;
      hgt = smax(hgt, ch * Math.pow(q, 1.15), 0.08);
    }
    // arms
    for (const arm of arms) {
      polyDist(arm.pts, x, z, tmp);
      if (tmp[0] >= arm.w) continue;
      const t = tmp[1] / tmp[2];
      // peaks and saddles along the spur
      const mod = 0.78 + 0.22 * Math.sin(t * 13 + arm.ph) * Math.sin(t * 5.3 + arm.ph * 1.7);
      const ah = (arm.h + (arm.end - arm.h) * Math.pow(t, 0.75)) * mod;
      const q = 1 - tmp[0] / arm.w;
      const v = ah * q * q * (3 - 2 * q) * (0.6 + 0.4 * q);
      hgt = smax(hgt, v, 0.06);
    }
    // plateaus
    for (const p of plateaus) {
      const dx = x - p.x;
      const dz = z - p.z;
      const c = Math.cos(p.rot);
      const s = Math.sin(p.rot);
      const u = (dx * c + dz * s) / p.rx;
      const v = (-dx * s + dz * c) / p.rz;
      const d = Math.hypot(u, v) + 0.25 * fbm(nDetail, x / 900, z / 900, 2);
      if (d > 1.6) continue;
      const top = p.h + 0.025 * fbm(nDetail, x / 500 + 7, z / 500, 2);
      const w = sstep(1.35, 0.85, d);
      hgt = Math.max(hgt, top * w + hgt * (1 - w));
    }
    // jagged mountain texture, stronger up high
    const mt = ridged(nMount, x / 3600, z / 3600, 5);
    hgt += (mt - 0.35) * 0.22 * sstep(0.15, 0.7, hgt);
    hgt += 0.035 * fbm(nDetail, x / 1500, z / 1500, 3);
    return Math.max(hgt, 0.004) * sstep(0, 600, dIn);
  }

  function erodibilityAt(x, z) {
    const kv = fbm(nK, x / 3200, z / 3200, 3);
    return 0.55 + 0.9 * sstep(-0.35, 0.45, kv);
  }

  return { landAt, reliefAt, erodibilityAt, cx, cz, R0, crest, arms, plateaus };
}
