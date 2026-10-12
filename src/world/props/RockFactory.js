import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../../core/random.js';
import { makeNoise3, fbm3, clamp01, ensurePropAttributes } from './util.js';

/**
 * Chiselled stylised rocks: noise-displaced icospheres flattened by a handful of
 * random cutting planes → big readable facets (Fortnite-style), flat shaded.
 * Vertex colour bakes cavity/bottom darkening; the rock material adds strata,
 * moss on top faces and snow at altitude in the shader.
 *
 * Every rock is built in object space with its base around y = 0 (bottom buried
 * ~25% so instances sit into the ground) and unit-ish radius 1.
 */

function deform(geo, spec) {
  const rng = mulberry32(spec.seed);
  const noise = makeNoise3(spec.seed * 3 + 1);
  const planes = [];
  for (let i = 0; i < spec.cuts; i++) {
    const n = new THREE.Vector3(rng() * 2 - 1, (rng() * 2 - 1) * 0.8 + (spec.topCut ? 0.35 : 0), rng() * 2 - 1).normalize();
    planes.push({ n, d: spec.cutMin + rng() * (spec.cutMax - spec.cutMin) });
  }
  if (spec.topCut) planes.push({ n: new THREE.Vector3(0, 1, 0), d: spec.topCut });
  const P = geo.attributes.position;
  const v = new THREE.Vector3();
  const ao = new Float32Array(P.count);
  for (let i = 0; i < P.count; i++) {
    v.set(P.getX(i), P.getY(i), P.getZ(i));
    const base = v.clone();
    const f = 1 + spec.noise * fbm3(noise, v.x * 1.3, v.y * 1.3, v.z * 1.3, 3);
    v.multiplyScalar(f);
    v.multiply(spec.scale);
    for (const pl of planes) {
      const d = v.dot(pl.n);
      if (d > pl.d) v.addScaledVector(pl.n, pl.d - d);
    }
    // bury the bottom
    if (spec.bury !== false) {
      if (v.y < -0.35 * spec.scale.y) v.y = -0.35 * spec.scale.y + (v.y + 0.35 * spec.scale.y) * 0.3;
      v.y += 0.22 * spec.scale.y;
    }
    P.setXYZ(i, v.x, v.y, v.z);
    ao[i] = clamp01(0.62 + 0.38 * (base.y * 0.5 + 0.5) + (f - 1) * 1.2);
  }
  return ao;
}

/** Remove zero-area triangles (plane cuts collapse some) so flat normals never NaN. */
function dropDegenerate(g) {
  const P = g.attributes.position;
  const keep = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let i = 0; i < P.count; i += 3) {
    a.fromBufferAttribute(P, i);
    b.fromBufferAttribute(P, i + 1);
    c.fromBufferAttribute(P, i + 2);
    if (b.sub(a).cross(c.sub(a)).lengthSq() > 1e-10) keep.push(i);
  }
  if (keep.length * 3 === P.count) return g;
  const out = new THREE.BufferGeometry();
  for (const name of Object.keys(g.attributes)) {
    const src = g.attributes[name];
    const isz = src.itemSize;
    const arr = new Float32Array(keep.length * 3 * isz);
    keep.forEach((v, t) => {
      for (let k = 0; k < 3; k++) for (let j = 0; j < isz; j++) arr[(t * 3 + k) * isz + j] = src.array[(v + k) * isz + j];
    });
    out.setAttribute(name, new THREE.BufferAttribute(arr, isz));
  }
  return out;
}

function buildRock(spec, detail) {
  let g = new THREE.IcosahedronGeometry(1, detail);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  g = mergeVertices(g, 1e-4);
  const ao = deform(g, spec);
  g.setAttribute('aAO', new THREE.Float32BufferAttribute(ao, 1));
  g = dropDegenerate(g.toNonIndexed());
  g.computeVertexNormals();
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  const A = g.attributes.aAO;
  const N = g.attributes.normal;
  for (let i = 0; i < n; i++) {
    // facets facing down are in cavities / contact shadow → darker
    const c = A.getX(i) * (0.78 + 0.22 * clamp01(N.getY(i) * 0.5 + 0.6));
    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = c;
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.deleteAttribute('aAO');
  ensurePropAttributes(g, { tint: 1, wind: 0 });
  g.computeBoundingSphere();
  return g;
}

export const ROCK_SPECS = [
  { name: 'boulder0', seed: 11, cuts: 6, cutMin: 0.62, cutMax: 0.85, noise: 0.22, scale: new THREE.Vector3(1.1, 0.8, 1.0) },
  { name: 'boulder1', seed: 23, cuts: 8, cutMin: 0.55, cutMax: 0.8, noise: 0.25, scale: new THREE.Vector3(1.0, 0.95, 0.9) },
  { name: 'boulder2', seed: 37, cuts: 5, cutMin: 0.7, cutMax: 0.9, noise: 0.3, scale: new THREE.Vector3(1.25, 0.7, 0.95) },
  { name: 'slab0', seed: 41, cuts: 6, cutMin: 0.6, cutMax: 0.85, noise: 0.18, scale: new THREE.Vector3(1.5, 0.45, 1.1), topCut: 0.3 },
  { name: 'slab1', seed: 53, cuts: 7, cutMin: 0.55, cutMax: 0.8, noise: 0.2, scale: new THREE.Vector3(1.3, 0.55, 1.35), topCut: 0.38 },
  { name: 'shard0', seed: 67, cuts: 7, cutMin: 0.5, cutMax: 0.78, noise: 0.2, scale: new THREE.Vector3(0.75, 1.7, 0.8) },
];

/** { lod0, lod1, far } geometries for a rock spec. */
export function buildRockSpec(spec) {
  return {
    lod0: buildRock(spec, 2),
    lod1: buildRock(spec, 1),
    far: buildRock(spec, 0),
  };
}

/**
 * A free-form rock body for landmarks: displaced, plane-cut and flattened like the
 * small rocks but at an arbitrary transform. Returns a flat-shaded geometry with
 * prop attributes (colour = AO).
 */
export function buildRockMesh({ seed = 1, detail = 3, scale = new THREE.Vector3(1, 1, 1), cuts = 7, noise = 0.25, cutMin = 0.6, cutMax = 0.85, topCut = 0, bury = true }) {
  return buildRock({ seed, cuts, cutMin, cutMax, noise, scale, topCut, bury }, detail);
}
