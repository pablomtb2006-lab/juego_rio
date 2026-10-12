import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../../core/random.js';
import { MeshBuilder, makeNoise3, fibDir, clamp01 } from './util.js';
import { ATLAS_CELLS } from './textures.js';

/**
 * Procedural stylised trees (Fortnite-like chunky silhouettes, soft "blob" shading).
 * Every species is built at three LODs from the same seeded layout:
 *   lod 0  full: trunk + branches + lumpy clump cores + camera-facing leaf cards
 *   lod 1  mid : simplified trunk + low-poly cores + a few big cards
 *   far    one cheap closed proxy (no cards), used beyond the mid radius
 * Normals are "spherised" (blended between clump and crown centres) so foliage
 * shades as soft volumes instead of facets. Vertex colour = baked AO (foliage) or
 * bark albedo (aTint = 0, ignores the instance colour).
 */

const UP = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _n = new THREE.Vector3();
const _col = new THREE.Color();

/** Soft normal = blend of two directions; falls back to `a` when they cancel out. */
function blendN(out, a, b, t) {
  out.copy(a).multiplyScalar(1 - t).addScaledVector(b, t);
  if (out.lengthSq() < 0.05) out.copy(a);
  return out.normalize();
}

const unitIco = {};
function icoMerged(detail) {
  if (!unitIco[detail]) {
    const g = new THREE.IcosahedronGeometry(1, detail);
    g.deleteAttribute('normal');
    g.deleteAttribute('uv');
    unitIco[detail] = mergeVertices(g, 1e-4);
  }
  return unitIco[detail];
}

// ---------------------------------------------------------------------------------
// primitives

/** Tapered tube along a polyline (parallel-transport frames). */
function addTube(b, pts, radii, sides, { color, wind, tint = 0, tip = true }) {
  const n = pts.length;
  const T = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[Math.max(i - 1, 0)];
    const p1 = pts[Math.min(i + 1, n - 1)];
    T.push(new THREE.Vector3().subVectors(p1, p0).normalize());
  }
  let N = Math.abs(T[0].y) < 0.9 ? new THREE.Vector3().crossVectors(T[0], UP) : new THREE.Vector3().crossVectors(T[0], new THREE.Vector3(1, 0, 0));
  N.normalize();
  const rings = [];
  for (let i = 0; i < n; i++) {
    N = N.clone().addScaledVector(T[i], -N.dot(T[i])).normalize();
    const B = new THREE.Vector3().crossVectors(T[i], N);
    const ring = [];
    for (let k = 0; k < sides; k++) {
      const a = (k / sides) * Math.PI * 2;
      _n.copy(N).multiplyScalar(Math.cos(a)).addScaledVector(B, Math.sin(a));
      _a.copy(pts[i]).addScaledVector(_n, radii[i]);
      ring.push(b.vert(_a, _n, color(i / (n - 1), k, _a), tint, wind(_a)));
    }
    rings.push(ring);
  }
  for (let i = 0; i < n - 1; i++) {
    for (let k = 0; k < sides; k++) {
      const k1 = (k + 1) % sides;
      b.quadAuto(rings[i][k], rings[i][k1], rings[i + 1][k1], rings[i + 1][k]);
    }
  }
  if (tip) {
    _a.copy(pts[n - 1]).addScaledVector(T[n - 1], radii[n - 1] * 2 + 0.05);
    const t = b.vert(_a, T[n - 1], color(1, 0, _a), tint, wind(_a));
    for (let k = 0; k < sides; k++) b.triAuto(rings[n - 1][k], rings[n - 1][(k + 1) % sides], t);
  }
}

/** Lumpy clump core: displaced icosphere with crown-blended normals. */
function addBlob(b, c, r, detail, crown, noise, seed, { squash = 0.85, ao, wind }) {
  const g = icoMerged(detail);
  const P = g.attributes.position;
  const base = b.count;
  for (let i = 0; i < P.count; i++) {
    _a.set(P.getX(i), P.getY(i), P.getZ(i));
    const f = 1 + 0.2 * noise(_a.x * 1.7 + seed, _a.y * 1.7 - seed, _a.z * 1.7 + seed * 0.5);
    _b.set(_a.x * r * f, _a.y * r * f * (_a.y < 0 ? squash * 0.8 : squash), _a.z * r * f).add(c);
    _c.subVectors(_b, crown.c).normalize();
    blendN(_n, _a, _c, 0.5);
    b.vert(_b, _n, ao(_b, _n), 1, wind(_b));
  }
  const I = g.index.array;
  for (let i = 0; i < I.length; i += 3) b.triAuto(base + I[i], base + I[i + 1], base + I[i + 2]);
}

/** Camera-facing alpha cards scattered over a clump. */
function addCards(b, c, r, count, half, cell, crown, rng, { ao, wind, dropDown = 0.5, spread = [0.82, 1.1] }) {
  const [u0, v0] = ATLAS_CELLS[cell];
  const d = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    fibDir(i, count, d);
    d.x += (rng() - 0.5) * 0.45;
    d.y += (rng() - 0.5) * 0.45;
    d.z += (rng() - 0.5) * 0.45;
    d.normalize();
    if (d.y < -0.55 && rng() < dropDown) continue;
    const ctr = _a.copy(c).addScaledVector(d, r * (spread[0] + (spread[1] - spread[0]) * rng()));
    const hs = half * (0.8 + 0.4 * rng());
    _c.subVectors(ctr, crown.c).normalize();
    blendN(_n, d, _c, 0.5);
    const col = ao(ctr, _n).clone().multiplyScalar(1.04);
    const w = wind(ctr);
    const ang = rng() * Math.PI * 2;
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    const ids = [];
    for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const cx = (x * ca - y * sa) * hs;
      const cy = (x * sa + y * ca) * hs;
      const uv = [u0 + 0.01 + ((x + 1) / 2) * 0.48, v0 + 0.01 + ((y + 1) / 2) * 0.48];
      ids.push(b.vert(ctr, _n, col, 1, w, uv, [cx, cy]));
    }
    b.tri(ids[0], ids[1], ids[2]);
    b.tri(ids[0], ids[2], ids[3]);
  }
}

/** One card at an explicit position (pine tips). */
function addCard(b, ctr, nrm, half, cell, col, w, ang) {
  const [u0, v0] = ATLAS_CELLS[cell];
  const ca = Math.cos(ang);
  const sa = Math.sin(ang);
  const ids = [];
  for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const uv = [u0 + 0.01 + ((x + 1) / 2) * 0.48, v0 + 0.01 + ((y + 1) / 2) * 0.48];
    ids.push(b.vert(ctr, nrm, col, 1, w, uv, [(x * ca - y * sa) * half, (x * sa + y * ca) * half]));
  }
  b.tri(ids[0], ids[1], ids[2]);
  b.tri(ids[0], ids[2], ids[3]);
}

// ---------------------------------------------------------------------------------
// species

const BARK = {
  pine: new THREE.Color(0x5e412d),
  broad: new THREE.Color(0x6e5139),
  birch: new THREE.Color(0xe9e3d6),
  birchMark: new THREE.Color(0x2e2925),
};

function barkColorFn(base, H, rng, birch = false) {
  const marks = [];
  if (birch) for (let i = 0; i < 26; i++) marks.push([rng() * H, 0.08 + rng() * 0.25, Math.floor(rng() * 7)]);
  return (t, k, p) => {
    const ao = 0.55 + 0.45 * clamp01(p.y / (H * 0.25) + 0.2);
    const c = new THREE.Color().copy(base).multiplyScalar(ao * (0.92 + 0.16 * ((k * 7919) % 5) / 5));
    if (birch) {
      for (const [y, h, kk] of marks) {
        if (Math.abs(p.y - y) < h && (k === kk || k === (kk + 1) % 7)) c.copy(BARK.birchMark);
      }
    }
    return c;
  };
}

function crownAO(crown, lift = 0) {
  return (p, n) => {
    const hemi = 0.5 + 0.5 * n.y;
    const outer = clamp01(_c.subVectors(p, crown.c).length() / (crown.r * 1.05));
    const ao = 0.44 + 0.38 * hemi + 0.3 * outer * outer + lift;
    return _col.setScalar(Math.min(ao, 1.12)).clone();
  };
}

/**
 * Pine / fir. Stacked drooping star skirts (needle tiers) on a tall trunk, bare below.
 */
function buildPine(spec, lod) {
  const rng = mulberry32(spec.seed);
  const H = spec.H;
  const solid = new MeshBuilder();
  const cards = new MeshBuilder();
  const wind = (p) => Math.pow(clamp01(p.y / H), 1.7) * (1 + 0.15 * Math.hypot(p.x, p.z) / (H * spec.maxR));

  // trunk (slight bend)
  const bendX = (rng() - 0.5) * 0.04 * H;
  const bendZ = (rng() - 0.5) * 0.04 * H;
  const trunkPts = [];
  const trunkR = [];
  const rings = lod === 0 ? 7 : lod === 1 ? 3 : 2;
  const baseR = H * 0.022 * (spec.trunk ?? 1);
  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    const y = -0.8 + t * (H * 0.96 + 0.8);
    trunkPts.push(new THREE.Vector3(bendX * Math.sin(t * Math.PI), y, bendZ * Math.sin(t * Math.PI)));
    trunkR.push(baseR * (1 - 0.88 * t) * (t < 0.06 ? 1.6 : 1));
  }
  const barkCol = barkColorFn(BARK.pine, H, rng);
  if (lod < 2) addTube(solid, trunkPts, trunkR, lod === 0 ? 7 : 5, { color: barkCol, wind, tint: 0 });

  // tiers layout (shared by every LOD)
  const tiers = [];
  const n = spec.tiers;
  const y0 = H * spec.crownStart;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const y = y0 + (H * 0.9 - y0) * Math.pow(t, 0.92);
    const R = H * spec.maxR * (1 - t * 0.82) * (0.9 + rng() * 0.2);
    tiers.push({ t, y, R, rot: rng() * Math.PI * 2, j: rng() });
  }
  const trunkAt = (y) => {
    const t = clamp01((y + 0.8) / (H * 0.96 + 0.8));
    return [bendX * Math.sin(t * Math.PI), bendZ * Math.sin(t * Math.PI)];
  };

  if (lod === 2) {
    // far proxy: two stacked cones + stub trunk
    const far = new MeshBuilder();
    const cone = (yb, yt, R, sides, rot) => {
      const apex = far.vert(_a.set(0, yt, 0), UP, _col.setScalar(1.0), 1, 1);
      const ring = [];
      const under = [];
      for (let k = 0; k < sides; k++) {
        const a = rot + (k / sides) * Math.PI * 2;
        const rd = _b.set(Math.cos(a), 0, Math.sin(a));
        _n.copy(rd).multiplyScalar(0.85).addScaledVector(UP, 0.55).normalize();
        ring.push(far.vert(_a.set(rd.x * R, yb, rd.z * R), _n, _col.setScalar(0.78), 1, 0.6));
        _n.copy(rd).multiplyScalar(0.5).addScaledVector(UP, -0.8).normalize();
        under.push(far.vert(_a.set(rd.x * R, yb, rd.z * R), _n, _col.setScalar(0.42), 1, 0.6));
      }
      const uc = far.vert(_a.set(0, yb + R * 0.2, 0), _n.set(0, -1, 0), _col.setScalar(0.4), 1, 0.5);
      for (let k = 0; k < sides; k++) {
        far.triAuto(apex, ring[k], ring[(k + 1) % sides]);
        far.triAuto(uc, under[(k + 1) % sides], under[k]);
      }
    };
    const Rb = H * spec.maxR * 1.0;
    cone(y0 - Rb * 0.25, H * 0.72, Rb, 7, rng());
    cone(H * 0.48, H * 1.0, Rb * 0.62, 6, rng());
    addTube(far, [new THREE.Vector3(0, -0.5, 0), new THREE.Vector3(0, y0 + 0.5, 0)], [baseR * 1.2, baseR * 0.8], 3, {
      color: () => _col.copy(BARK.pine).multiplyScalar(0.8).clone(),
      wind: () => 0,
      tint: 0,
      tip: false,
    });
    return { far: far.build() };
  }

  const P = lod === 0 ? spec.P : Math.max(5, spec.P - 2);
  const useTiers = tiers;
  const cardRng = mulberry32(spec.seed * 7 + lod);
  const tipCol = new THREE.Color(1.12, 1.2, 0.95);
  for (const tier of useTiers) {
    const { y, rot, t } = tier;
    const R = tier.R;
    const hUp = R * 0.46 + H * 0.012;
    const droop = R * spec.droop;
    const [tx, tz] = trunkAt(y);
    const tierShade = 0.74 + 0.3 * t;
    const apex = solid.vert(_a.set(tx, y + hUp, tz), UP, _col.setScalar(0.98 * tierShade + 0.08), 1, wind(_a));
    const mid = [];
    const rim = [];
    const rimU = [];
    const tips = [];
    for (let j = 0; j < 2 * P; j++) {
      const tip = j % 2 === 0;
      const ang = rot + (j * Math.PI) / P + (cardRng() - 0.5) * 0.3 * (Math.PI / P);
      const rr = tip ? R * (0.84 + 0.3 * cardRng()) : R * (0.55 + 0.12 * cardRng());
      const cx = Math.cos(ang);
      const sz = Math.sin(ang);
      if (lod === 0) {
        // mid ring (convex shoulder)
        const mr = rr * 0.5;
        _a.set(tx + cx * mr, y + hUp * 0.45 - (tip ? 0 : hUp * 0.08), tz + sz * mr);
        _n.set(cx * 0.5, 1, sz * 0.5).normalize();
        _col.setScalar(0.8 * tierShade);
        mid.push(solid.vert(_a, _n, _col, 1, wind(_a)));
      }
      // rim (drooping tips)
      const dr = tip ? droop * (0.85 + 0.3 * cardRng()) : droop * 0.35;
      _a.set(tx + cx * rr, y - dr, tz + sz * rr);
      _n.set(cx * 0.95, 0.5, sz * 0.95).normalize();
      if (tip) _col.copy(tipCol).multiplyScalar(tierShade);
      else _col.setScalar(0.7 * tierShade);
      rim.push(solid.vert(_a, _n, _col, 1, wind(_a)));
      _n.set(cx * 0.65, -0.55, sz * 0.65).normalize();
      rimU.push(solid.vert(_a, _n, _col.setScalar(0.46 * tierShade), 1, wind(_a)));
      if (tip) tips.push({ x: tx + cx * rr, y: y - dr, z: tz + sz * rr, cx, sz, rr });
    }
    const under = solid.vert(_a.set(tx, y + hUp * 0.12, tz), _n.set(0, -1, 0), _col.setScalar(0.34 * tierShade), 1, wind(_a));
    const m = 2 * P;
    for (let j = 0; j < m; j++) {
      const j1 = (j + 1) % m;
      if (lod === 0) {
        solid.triAuto(apex, mid[j], mid[j1]);
        solid.quadAuto(mid[j], rim[j], rim[j1], mid[j1]);
      } else solid.triAuto(apex, rim[j], rim[j1]);
      solid.triAuto(under, rimU[j1], rimU[j]);
    }
    // needle tufts: one at every tip + one on the shoulder → fluffy layered silhouette
    if (lod === 0) {
      for (const tp of tips) {
        _a.set(tp.x - tp.cx * R * 0.06, tp.y + droop * 0.22, tp.z - tp.sz * R * 0.06);
        _n.set(tp.cx * 0.8, 0.6, tp.sz * 0.8).normalize();
        addCard(cards, _a, _n, R * 0.25, 'needle', _col.copy(tipCol).multiplyScalar(0.98 * tierShade), wind(_a), cardRng() * 6.28);
        const f = 0.55 + cardRng() * 0.12;
        _a.set(tx + tp.cx * tp.rr * f, y + hUp * (1 - f) * 0.9 - droop * f * 0.4 + R * 0.04, tz + tp.sz * tp.rr * f);
        _n.set(tp.cx * 0.55, 1, tp.sz * 0.55).normalize();
        addCard(cards, _a, _n, R * 0.22, 'needle', _col.setScalar(0.92 * tierShade), wind(_a), cardRng() * 6.28);
      }
    }
  }
  // top spike
  const [tx, tz] = trunkAt(H);
  const topR = H * 0.025;
  addTube(solid, [new THREE.Vector3(tx, H * 0.88, tz), new THREE.Vector3(tx, H * 1.0, tz)], [topR * 1.3, topR * 0.25], 5, {
    color: () => _col.setScalar(0.95).clone(),
    wind,
    tint: 1,
  });

  return { solid: solid.build(), cards: lod === 0 && cards.count ? cards.build() : null };
}

/**
 * Broadleaf / birch / bush: trunk + branches + clump cluster.
 *   spec.style: 'broad' | 'birch' | 'bush'
 */
function buildClumpTree(spec, lod) {
  const rng = mulberry32(spec.seed);
  const H = spec.H;
  const style = spec.style;
  const solid = new MeshBuilder();
  const cards = new MeshBuilder();
  const noise = makeNoise3(spec.seed + 11);

  const crown = {
    c: new THREE.Vector3(0, H * spec.crownY, 0),
    r: H * spec.crownR,
  };
  // lean/offset of the crown
  const lean = new THREE.Vector3((rng() - 0.5) * H * 0.08, 0, (rng() - 0.5) * H * 0.08);
  crown.c.add(lean);

  // clump layout
  const clumps = [];
  const nc = spec.clumps;
  for (let i = 0; i < nc; i++) {
    let d;
    if (i === 0) d = new THREE.Vector3(0, 1, 0);
    else {
      d = fibDir(i - 1 + Math.floor(nc * 0.15), Math.round(nc * 1.5), new THREE.Vector3());
      d.y = Math.abs(d.y) * 0.8 - 0.1;
      d.x += (rng() - 0.5) * 0.5;
      d.z += (rng() - 0.5) * 0.5;
      d.normalize();
    }
    const dist = i === 0 ? crown.r * 0.42 : crown.r * (0.5 + rng() * 0.18);
    const c = crown.c.clone().addScaledVector(d, dist);
    c.y *= 1;
    c.y += (spec.stretchY ?? 0) * (c.y - crown.c.y);
    const r = crown.r * (spec.clumpR ?? 0.55) * (0.82 + rng() * 0.36);
    clumps.push({ c, r, seed: rng() * 100 });
  }
  const wind = (p) => Math.pow(clamp01(p.y / H), 1.6) * (1 + 0.2 * clamp01(_c.subVectors(p, crown.c).length() / crown.r));
  const ao = crownAO(crown, style === 'bush' ? 0.05 : 0);
  const aoCore = (p, n) => ao(p, n).multiplyScalar(0.72);

  if (lod === 2) {
    const far = new MeshBuilder();
    addBlob(far, crown.c.clone().add(new THREE.Vector3(0, crown.r * 0.12, 0)), crown.r * 1.12, 0, crown, noise, 3, {
      squash: 0.9,
      ao: (p, n) => _col.setScalar(0.5 + 0.38 * (0.5 + 0.5 * n.y)).clone(),
      wind: () => 1,
    });
    if (style !== 'bush') {
      addTube(far, [new THREE.Vector3(0, -0.5, 0), crown.c.clone().multiplyScalar(0.8)], [H * 0.03, H * 0.02], 3, {
        color: () => _col.copy(style === 'birch' ? BARK.birch : BARK.broad).multiplyScalar(0.8).clone(),
        wind: () => 0,
        tint: 0,
        tip: false,
      });
    }
    return { far: far.build() };
  }

  // trunk
  if (style !== 'bush') {
    const trunkTop = crown.c.clone();
    trunkTop.y = crown.c.y - crown.r * 0.15;
    const pts = [];
    const rad = [];
    const rings = lod === 0 ? 6 : 2;
    const baseR = H * (style === 'birch' ? 0.028 : 0.056) * (spec.trunk ?? 1);
    const wob = rng() * 10;
    for (let i = 0; i <= rings; i++) {
      const t = i / rings;
      const p = new THREE.Vector3(0, -0.6, 0).lerp(trunkTop, t);
      p.x += Math.sin(t * 3 + wob) * H * 0.012;
      p.z += Math.cos(t * 2.3 + wob) * H * 0.012;
      pts.push(p);
      rad.push(baseR * (1 - 0.42 * t) * (t < 0.08 ? 1.7 : 1));
    }
    const bark = barkColorFn(style === 'birch' ? BARK.birch : BARK.broad, H, rng, style === 'birch');
    addTube(solid, pts, rad, lod === 0 ? 7 : 5, { color: bark, wind, tint: 0, tip: false });

    // branches into the clumps
    const nb = lod === 0 ? clumps.length : Math.min(3, clumps.length);
    for (let i = 0; i < nb; i++) {
      const cl = clumps[i];
      const from = trunkTop.clone().lerp(pts[Math.max(1, rings - 2)], rng() * 0.6);
      const to = cl.c.clone().lerp(crown.c, 0.25);
      const midp = from.clone().lerp(to, 0.5);
      midp.y += H * 0.03;
      const r0 = baseR * 0.55 * (0.7 + rng() * 0.3);
      addTube(solid, [from, midp, to], [r0, r0 * 0.65, r0 * 0.35], lod === 0 ? 5 : 4, { color: bark, wind, tint: 0, tip: false });
    }
  } else {
    // bushes: a few woody stems for grounding
    for (let i = 0; i < (lod === 0 ? 3 : 0); i++) {
      const a = rng() * Math.PI * 2;
      const to = new THREE.Vector3(Math.cos(a) * H * 0.25, H * 0.45, Math.sin(a) * H * 0.25);
      addTube(solid, [new THREE.Vector3(0, -0.2, 0), to], [H * 0.035, H * 0.015], 4, {
        color: () => _col.copy(BARK.broad).multiplyScalar(0.7).clone(),
        wind,
        tint: 0,
        tip: false,
      });
    }
  }

  // foliage
  const cardRng = mulberry32(spec.seed * 13 + lod);
  const cell = spec.cell ?? 'broad';
  for (const cl of clumps) {
    addBlob(solid, cl.c, cl.r * (lod === 0 ? 0.84 : 0.92), lod === 0 ? 1 : 0, crown, noise, cl.seed, { squash: 0.86, ao: lod === 0 ? aoCore : ao, wind });
    const nCards = lod === 0 ? spec.cards : Math.max(4, Math.round(spec.cards * 0.3));
    const half = cl.r * (lod === 0 ? spec.cardSize : spec.cardSize * 1.6);
    addCards(cards, cl.c, cl.r, nCards, half, cell, crown, cardRng, { ao, wind, spread: lod === 0 ? [0.76, 1.06] : [0.75, 0.95] });
  }

  return { solid: solid.build(), cards: cards.count ? cards.build() : null };
}

/** Species catalogue. `kind` groups species for placement; colours come from the instance. */
export const TREE_SPECIES = [
  { name: 'pine0', kind: 'pine', type: 'pine', seed: 101, H: 21, tiers: 11, crownStart: 0.28, maxR: 0.22, droop: 0.5, P: 8 },
  { name: 'pine1', kind: 'pine', type: 'pine', seed: 202, H: 26, tiers: 13, crownStart: 0.4, maxR: 0.16, droop: 0.42, P: 7 },
  { name: 'pine2', kind: 'pine', type: 'pine', seed: 303, H: 17, tiers: 9, crownStart: 0.24, maxR: 0.26, droop: 0.55, P: 8, trunk: 1.2 },
  { name: 'broad0', kind: 'broad', type: 'clump', style: 'broad', seed: 404, H: 12, crownY: 0.64, crownR: 0.34, clumps: 7, cards: 40, cardSize: 0.4 },
  { name: 'broad1', kind: 'broad', type: 'clump', style: 'broad', seed: 505, H: 14.5, crownY: 0.66, crownR: 0.3, clumps: 8, cards: 38, cardSize: 0.4, stretchY: 0.35 },
  { name: 'broad2', kind: 'broad', type: 'clump', style: 'broad', seed: 606, H: 10, crownY: 0.6, crownR: 0.42, clumps: 6, cards: 42, cardSize: 0.4, trunk: 1.25 },
  { name: 'birch0', kind: 'birch', type: 'clump', style: 'birch', seed: 707, H: 14, crownY: 0.7, crownR: 0.24, clumps: 6, cards: 30, cardSize: 0.42, cell: 'birch', stretchY: 0.9, clumpR: 0.62 },
  { name: 'birch1', kind: 'birch', type: 'clump', style: 'birch', seed: 808, H: 11, crownY: 0.68, crownR: 0.27, clumps: 6, cards: 30, cardSize: 0.42, cell: 'birch', stretchY: 0.6, clumpR: 0.6 },
  { name: 'bush0', kind: 'bush', type: 'clump', style: 'bush', seed: 909, H: 1.7, crownY: 0.42, crownR: 0.48, clumps: 4, cards: 14, cardSize: 0.6, cell: 'bush', clumpR: 0.62 },
  { name: 'bush1', kind: 'bush', type: 'clump', style: 'bush', seed: 1010, H: 2.4, crownY: 0.45, crownR: 0.46, clumps: 5, cards: 14, cardSize: 0.6, cell: 'bush', clumpR: 0.6 },
];

/** Build every LOD of a species: { lod0: {solid, cards}, lod1: {solid, cards}, far } */
export function buildSpecies(spec) {
  const fn = spec.type === 'pine' ? buildPine : buildClumpTree;
  const lod0 = fn(spec, 0);
  const lod1 = fn(spec, 1);
  const far = spec.kind === 'bush' ? null : fn(spec, 2).far;
  return { lod0, lod1, far };
}
