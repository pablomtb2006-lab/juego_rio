import * as THREE from 'three';

// Procedural, tileable terrain textures baked once on the GPU at init (no image files).
//   noise  RGBA: R low-freq fbm, G mid-freq fbm, B cells (Voronoi F1), A high-freq value noise
//   rock   RGBA: RG facet+strata normal (tangent xy), B cavity (0 crevice … 1 exposed), A tone
//   ground RGBA: RG clump normal (tangent xy), B cavity, A tone (patches / flowers)

const COMMON = /* glsl */ `
precision highp float;
varying vec2 vUv;
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
// periodic value noise; p in lattice units, period in cells
float pnoise(vec2 p, float period, float seed) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = hash12(mod(i, period) + seed);
  float b = hash12(mod(i + vec2(1.0, 0.0), period) + seed);
  float c = hash12(mod(i + vec2(0.0, 1.0), period) + seed);
  float d = hash12(mod(i + vec2(1.0, 1.0), period) + seed);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float pfbm(vec2 uv, float freq, int oct, float seed) {
  float s = 0.0;
  float a = 0.5;
  float n = 0.0;
  for (int o = 0; o < 8; o++) {
    if (o >= oct) break;
    s += a * pnoise(uv * freq, freq, seed + float(o) * 17.0);
    n += a;
    a *= 0.5;
    freq *= 2.0;
  }
  return s / n;
}
// periodic voronoi with the offset to the nearest feature point: x = F1, y = F2, zw = r
vec4 pvoronoiR(vec2 uv, float cells, float seed, out vec2 id) {
  vec2 p = uv * cells;
  vec2 i = floor(p);
  vec2 f = fract(p);
  float f1 = 8.0;
  float f2 = 8.0;
  vec2 rr = vec2(0.0);
  id = vec2(0.0);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 cid = mod(i + g, cells);
      vec2 r = g + hash22(cid + seed) - f;
      float d = dot(r, r);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        id = cid;
        rr = r;
      } else if (d < f2) {
        f2 = d;
      }
    }
  }
  return vec4(sqrt(f1), sqrt(f2), rr);
}
// periodic voronoi: x = F1, y = F2, zw = cell id
vec4 pvoronoi(vec2 uv, float cells, float seed) {
  vec2 p = uv * cells;
  vec2 i = floor(p);
  vec2 f = fract(p);
  float f1 = 8.0;
  float f2 = 8.0;
  vec2 id = vec2(0.0);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 cid = mod(i + g, cells);
      vec2 o = hash22(cid + seed);
      vec2 r = g + o - f;
      float d = dot(r, r);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        id = cid;
      } else if (d < f2) {
        f2 = d;
      }
    }
  }
  return vec4(sqrt(f1), sqrt(f2), id);
}
`;

const NOISE_FRAG = /* glsl */ `
${COMMON}
void main() {
  float r = pfbm(vUv, 4.0, 5, 3.0);
  float g = pfbm(vUv, 8.0, 4, 41.0);
  float b = pvoronoi(vUv, 12.0, 7.0).x;
  float a = pfbm(vUv, 32.0, 2, 91.0);
  gl_FragColor = vec4(r, g, b, a);
}
`;

// height field of the rock: big facets + small facets + strata + cracks; normal by differences
const ROCK_FRAG = /* glsl */ `
${COMMON}
float facetH(vec2 uv, float cells, float seed, float tilt, out float edge) {
  vec2 id;
  vec4 v = pvoronoiR(uv, cells, seed, id);
  vec2 n = (hash22(id + seed * 3.1) - 0.5) * tilt;
  // planar facet through the cell's feature point
  float h = dot(n, -v.zw) + hash12(id + seed) * 0.6;
  edge = v.y - v.x;
  return h;
}
float rockH(vec2 uv, out float crack) {
  float e1;
  float e2;
  float h = facetH(uv, 5.0, 11.0, 1.4, e1) * 0.55;
  h += facetH(uv, 13.0, 29.0, 1.1, e2) * 0.25;
  // strata: horizontal bands along v (world height in side projections)
  float band = pnoise(vec2(uv.y * 24.0, uv.x * 2.0), 24.0, 5.0) * 0.6 + pnoise(vec2(uv.y * 64.0, uv.x * 4.0), 64.0, 9.0) * 0.4;
  h += band * 0.22;
  h += pfbm(uv, 16.0, 3, 13.0) * 0.12;
  crack = 1.0 - smoothstep(0.0, 0.06, e1) * smoothstep(0.0, 0.035, e2);
  h -= crack * 0.25;
  return h;
}
void main() {
  float px = 1.0 / 1024.0;
  float c0;
  float c1;
  float c2;
  float h = rockH(vUv, c0);
  float hx = rockH(vUv + vec2(px, 0.0), c1);
  float hy = rockH(vUv + vec2(0.0, px), c2);
  vec3 n = normalize(vec3(-(hx - h) * 70.0, -(hy - h) * 70.0, 1.0));
  float cav = clamp(1.0 - c0 * 0.85 - (0.5 - pfbm(vUv, 8.0, 3, 77.0)) * 0.3, 0.0, 1.0);
  float band = pnoise(vec2(vUv.y * 24.0, vUv.x * 2.0), 24.0, 5.0);
  float tone = clamp(0.5 + (band - 0.5) * 0.8 + (pfbm(vUv, 6.0, 4, 55.0) - 0.5) * 0.6, 0.0, 1.0);
  gl_FragColor = vec4(n.xy * 0.5 + 0.5, cav, tone);
}
`;

const GROUND_FRAG = /* glsl */ `
${COMMON}
float groundH(vec2 uv) {
  // soft clumps (stylised grass tufts) + fine grain
  vec4 v = pvoronoi(uv, 22.0, 3.0);
  float clump = 1.0 - smoothstep(0.0, 0.75, v.x);
  float h = clump * 0.6 + pfbm(uv, 32.0, 3, 21.0) * 0.4;
  return h;
}
void main() {
  float px = 1.0 / 512.0;
  float h = groundH(vUv);
  float hx = groundH(vUv + vec2(px, 0.0));
  float hy = groundH(vUv + vec2(0.0, px));
  vec3 n = normalize(vec3(-(hx - h) * 18.0, -(hy - h) * 18.0, 1.0));
  float cav = clamp(0.35 + h * 0.8, 0.0, 1.0);
  float patches = pfbm(vUv, 4.0, 4, 61.0);
  // sparse flower / pebble specks
  vec4 sp = pvoronoi(vUv, 48.0, 17.0);
  float speck = (1.0 - smoothstep(0.08, 0.16, sp.x)) * step(0.82, hash12(sp.zw + 4.0));
  gl_FragColor = vec4(n.xy * 0.5 + 0.5, cav, clamp(patches * 0.85 + speck * 0.6, 0.0, 1.0));
}
`;

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

function bake(renderer, frag, size) {
  const rt = new THREE.WebGLRenderTarget(size, size, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.RepeatWrapping,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: true,
    depthBuffer: false,
    anisotropy: Math.min(8, renderer.capabilities.getMaxAnisotropy?.() ?? 1),
  });
  const mat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: frag, depthTest: false, depthWrite: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const prevRT = renderer.getRenderTarget();
  const prevAuto = renderer.autoClear;
  renderer.autoClear = true;
  renderer.setRenderTarget(rt);
  renderer.render(scene, cam);
  renderer.setRenderTarget(prevRT);
  renderer.autoClear = prevAuto;
  mesh.geometry.dispose();
  mat.dispose();
  return rt.texture;
}

export function createTerrainTextures(renderer, quality) {
  const hi = quality.name === 'high' || quality.name === 'ultra';
  return {
    noise: bake(renderer, NOISE_FRAG, 512),
    rock: bake(renderer, ROCK_FRAG, hi ? 1024 : 512),
    ground: bake(renderer, GROUND_FRAG, 512),
  };
}
