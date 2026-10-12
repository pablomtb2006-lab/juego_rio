import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MarchingCubes } from 'three/addons/objects/MarchingCubes.js';
import { mulberry32 } from '../../core/random.js';
import { makeNoise3, fbm3, clamp01, ensurePropAttributes } from './util.js';
import { buildRockMesh } from './RockFactory.js';

/**
 * The summit rock arch (reference frame "THE GOAL? BE THE FIRST TO THE SEA").
 * Sculpted as a signed distance field and polygonised with marching cubes:
 *   - a thick sandstone fin with an elliptical window (slender span on top,
 *     heavy asymmetric shoulders), squarish rounded cross-section
 *   - a flared foot that melts into the summit and continues under the terrain
 *   - horizontal strata ledges, large erosion lumps and a few eroded pockets
 * The window is tilted ~44° towards the sky (and the sun's azimuth, so the face seen
 * from the drop camera is lit): a drop falling (nearly) vertically through
 * `position` passes the window.
 *
 * Returns { group, position (centre of the opening), radius (clear radius),
 *           normal (axis through the opening, pointing up/out), bounds }.
 */

const UP = new THREE.Vector3(0, 1, 0);

const smin = (a, b, k) => {
  const h = clamp01(0.5 + (0.5 * (b - a)) / k);
  return b + (a - b) * h - k * h * (1 - h);
};

export function buildRockArch(ctx, { material, sandstone = new THREE.Color(0xc4a688), resolution = 92 } = {}) {
  const { terrain } = ctx;
  const peak = terrain.peaks?.[0] ?? { x: 0, y: terrain.heightAt(0, 0), z: 0 };
  const rand = mulberry32((terrain.seed ?? 7) * 31 + 77);
  const noise = makeNoise3(4242);
  const group = new THREE.Group();
  group.name = 'rock-arch';

  // opening axis tilted towards the sun's azimuth so the face the drop camera sees is lit
  const sun = ctx.atmosphere?.sunDirection ?? new THREE.Vector3(0.45, 0.55, 0.35);
  const az = new THREE.Vector3(sun.x, 0, sun.z);
  if (az.lengthSq() < 1e-4) az.set(1, 0, 0);
  az.normalize();
  const tilt = THREE.MathUtils.degToRad(44);
  const N = new THREE.Vector3().copy(az).multiplyScalar(Math.sin(tilt)).addScaledVector(UP, Math.cos(tilt)).normalize();
  const Vl = new THREE.Vector3().crossVectors(N, UP).normalize();
  const U = new THREE.Vector3().crossVectors(Vl, N).normalize(); // in-plane "up" (U.y > 0)
  const V = new THREE.Vector3().crossVectors(U, N).normalize(); // (V, U, N) right-handed

  // window and body dimensions (m)
  const Rx = 54;
  const Ry = 64;
  const rtTop = 19;
  const rtBase = 47;
  const asym = rand() * 6.28;
  const band = (th) => {
    // th = 0 top … PI bottom: slender span → heavy shoulders/base, lumpy & asymmetric
    const b = THREE.MathUtils.smoothstep((1 - Math.cos(th)) / 2, 0.2, 0.95);
    return (rtTop + (rtBase - rtTop) * b) * (1 + 0.16 * Math.sin(th * 2 + asym) + 0.08 * Math.sin(th * 5 + asym * 2));
  };
  const depthOf = (th) => band(th) * 0.62 + 7;

  const C = new THREE.Vector3(peak.x, peak.y - 12, peak.z).addScaledVector(U, Ry + rtBase * 1.1);
  const toWorldY = (x, y, z) => C.y + V.y * x + U.y * y + N.y * z;

  // eroded pockets on the shoulders (small secondary holes / caves)
  const pockets = [];
  for (let i = 0; i < 4; i++) {
    const th = (rand() < 0.5 ? -1 : 1) * (0.9 + rand() * 1.2);
    const r = band(th);
    const rr = Math.hypot(Rx * Math.sin(th), Ry * Math.cos(th)) + r * (0.9 + rand() * 0.5);
    pockets.push({ x: Math.sin(th) * rr, y: Math.cos(th) * rr, z: (rand() < 0.5 ? -1 : 1) * depthOf(th) * (0.6 + rand() * 0.5), r: 6 + rand() * 7 });
  }

  const footY = -(Ry + rtBase * 1.25);
  function sdf(x, y, z) {
    // --- window band ---
    const th = Math.atan2(x / Rx, y / Ry);
    const rho = Math.hypot(x / Rx, y / Ry);
    const reff = Math.hypot(Rx * Math.sin(th), Ry * Math.cos(th));
    const rin = (rho - 1) * reff;
    const rt = band(th);
    const dp = depthOf(th);
    const u = rin - rt;
    const rr = Math.min(rt, dp) * 0.55;
    const qx = Math.abs(u) - rt + rr;
    const qz = Math.abs(z) - dp + rr;
    let d = Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0) - rr;
    // --- flared foot melting into the summit (and below the terrain) ---
    const fy = y - footY;
    const fr = Rx * 0.9 + rtBase * 0.6 + Math.max(0, -fy) * 0.55;
    const footE = Math.hypot(x / fr, fy / (rtBase * 1.2), z / (depthOf(Math.PI) * 1.35 + Math.max(0, -fy) * 0.5)) - 1;
    const foot = footE * Math.min(fr, rtBase * 1.2);
    d = smin(d, foot, 18);
    // --- erosion ---
    const wy = toWorldY(x, y, z);
    const n1 = fbm3(noise, x * 0.022, y * 0.022, z * 0.022, 3);
    const n2 = noise(x * 0.075 + 3.1, y * 0.075, z * 0.075 - 1.7);
    d += n1 * 8.5 + n2 * 2.6;
    // strata ledges (horizontal in world space)
    const s = Math.sin(wy * 0.34 + n1 * 2.5);
    d += 1.5 * s * s * s;
    // pockets
    for (const p of pockets) {
      const pd = Math.hypot(x - p.x, y - p.y, z - p.z) - p.r;
      d = Math.max(d, -pd);
    }
    return d;
  }

  // --- polygonise ------------------------------------------------------------------
  const ext = Math.max(Rx + rtBase * 2.4, Ry + rtTop * 2.2 + 10, -footY + 40) + 10;
  const res = resolution;
  const mc = new MarchingCubes(res, material, false, false, 90000);
  mc.isolation = 0;
  const half = res / 2;
  const field = mc.field;
  // centre the cube so the foot fits: shift local y by yShift
  const yShift = -(ext - (Ry + rtTop * 2.2 + 12));
  const cell = (2 * ext) / res;
  const L = (i) => ((i - half) / half) * ext;
  // coarse pass (every 3rd sample); fine samples far from the surface are interpolated
  const CS = 3;
  const cn = Math.ceil((res - 1) / CS) + 1;
  const coarse = new Float32Array(cn * cn * cn);
  for (let k = 0; k < cn; k++)
    for (let j = 0; j < cn; j++)
      for (let i = 0; i < cn; i++) coarse[(k * cn + j) * cn + i] = sdf(L(Math.min(i * CS, res - 1)), L(Math.min(j * CS, res - 1)) + yShift, L(Math.min(k * CS, res - 1)));
  const refine = cell * CS * 3.2;
  for (let k = 0; k < res; k++) {
    const ck = Math.min(cn - 2, Math.floor(k / CS));
    const tk = k / CS - ck;
    for (let j = 0; j < res; j++) {
      const cj = Math.min(cn - 2, Math.floor(j / CS));
      const tj = j / CS - cj;
      for (let i = 0; i < res; i++) {
        const ci = Math.min(cn - 2, Math.floor(i / CS));
        const ti = i / CS - ci;
        const c000 = coarse[(ck * cn + cj) * cn + ci];
        const c100 = coarse[(ck * cn + cj) * cn + ci + 1];
        const c010 = coarse[(ck * cn + cj + 1) * cn + ci];
        const c110 = coarse[(ck * cn + cj + 1) * cn + ci + 1];
        const c001 = coarse[((ck + 1) * cn + cj) * cn + ci];
        const c101 = coarse[((ck + 1) * cn + cj) * cn + ci + 1];
        const c011 = coarse[((ck + 1) * cn + cj + 1) * cn + ci];
        const c111 = coarse[((ck + 1) * cn + cj + 1) * cn + ci + 1];
        const mn = Math.min(Math.abs(c000), Math.abs(c100), Math.abs(c010), Math.abs(c110), Math.abs(c001), Math.abs(c101), Math.abs(c011), Math.abs(c111));
        let d;
        if (mn > refine) {
          const x0 = c000 + (c100 - c000) * ti;
          const x1 = c010 + (c110 - c010) * ti;
          const x2 = c001 + (c101 - c001) * ti;
          const x3 = c011 + (c111 - c011) * ti;
          const y0 = x0 + (x1 - x0) * tj;
          const y1 = x2 + (x3 - x2) * tj;
          d = y0 + (y1 - y0) * tk;
        } else d = sdf(L(i), L(j) + yShift, L(k));
        // MarchingCubes treats field > isolation as inside
        field[k * res * res + j * res + i] = -d;
      }
    }
  }
  mc.update();
  const vcount = mc.count;
  const pos = new Float32Array(vcount * 3);
  const nor = new Float32Array(vcount * 3);
  const col = new Float32Array(vcount * 3);
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  const cTmp = new THREE.Color();
  const light = new THREE.Color(0xd8bd9e);
  const dark = new THREE.Color(0xa9896d);
  for (let i = 0; i < vcount; i++) {
    const lx = mc.positionArray[i * 3] * ext;
    const ly = mc.positionArray[i * 3 + 1] * ext + yShift;
    const lz = mc.positionArray[i * 3 + 2] * ext;
    p.copy(C).addScaledVector(V, lx).addScaledVector(U, ly).addScaledVector(N, lz);
    n.set(0, 0, 0)
      .addScaledVector(V, mc.normalArray[i * 3])
      .addScaledVector(U, mc.normalArray[i * 3 + 1])
      .addScaledVector(N, mc.normalArray[i * 3 + 2]);
    if (n.lengthSq() < 1e-12) n.copy(UP);
    n.normalize();
    pos.set([p.x, p.y, p.z], i * 3);
    nor.set([n.x, n.y, n.z], i * 3);
    // sandstone banding + cavity AO (inside of the window, overhangs)
    const bandT = 0.5 + 0.5 * Math.sin(p.y * 0.075 + noise(p.x * 0.01, p.y * 0.03, p.z * 0.01) * 2.2);
    cTmp.copy(dark).lerp(light, bandT);
    cTmp.lerp(sandstone, 0.35);
    const th = Math.atan2(lx / Rx, ly / Ry);
    const rin = (Math.hypot(lx / Rx, ly / Ry) - 1) * Math.hypot(Rx * Math.sin(th), Ry * Math.cos(th));
    const inner = 1 - THREE.MathUtils.smoothstep(rin, 2, 18);
    const ao = (1 - 0.16 * inner) * (0.84 + 0.16 * clamp01(n.y * 0.6 + 0.7));
    cTmp.multiplyScalar(ao);
    col.set([cTmp.r, cTmp.g, cTmp.b], i * 3);
  }
  mc.geometry.dispose();
  const archGeo = new THREE.BufferGeometry();
  archGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  archGeo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  archGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  ensurePropAttributes(archGeo, { tint: 0 });

  // rubble: faceted sandstone boulders scattered around the summit
  const geos = [archGeo];
  const m = new THREE.Matrix4();
  const bottom = C.clone().addScaledVector(U, footY);
  for (let i = 0; i < 16; i++) {
    const a = rand() * Math.PI * 2;
    const dist = 120 + rand() * 150;
    const x = bottom.x + Math.cos(a) * dist;
    const z = bottom.z + Math.sin(a) * dist;
    const s = 4 + rand() * 10;
    let gy = terrain.heightAt(x, z);
    for (let k = 0; k < 6; k++) gy = Math.min(gy, terrain.heightAt(x + Math.cos(k) * s * 0.7, z + Math.sin(k) * s * 0.7));
    const g = buildRockMesh({ seed: 950 + i, detail: 2, scale: new THREE.Vector3(1.2, 0.7 + rand() * 0.5, 1.0), cuts: 9, noise: 0.26 });
    m.compose(new THREE.Vector3(x, gy - s * 0.3, z), new THREE.Quaternion().setFromEuler(new THREE.Euler((rand() - 0.5) * 0.3, rand() * 6.28, (rand() - 0.5) * 0.3)), new THREE.Vector3(s, s, s));
    g.applyMatrix4(m);
    const c = g.attributes.color;
    const tint = 0.85 + rand() * 0.15;
    for (let k = 0; k < c.count; k++) c.setXYZ(k, c.getX(k) * sandstone.r * tint, c.getY(k) * sandstone.g * tint, c.getZ(k) * sandstone.b * tint);
    g.attributes.aTint.array.fill(0);
    geos.push(g);
  }
  const merged = mergeGeometries(geos);
  const mesh = new THREE.Mesh(merged, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.customDepthMaterial = material.userData.depth;
  mesh.name = 'arch';
  group.add(mesh);

  const bounds = new THREE.Box3().setFromObject(group);
  return {
    group,
    position: C.clone(),
    radius: Math.min(Rx, Ry) - 11,
    normal: N.clone(),
    bounds,
    triangles: vcount / 3,
  };
}
