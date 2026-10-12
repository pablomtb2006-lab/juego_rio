// Small-scale height detail that lives on top of the bicubic heightfield. It is evaluated
// identically on the CPU (heightAt → physics, cameras, props) and on the GPU (vertex shader),
// using an integer hash so both sides agree to ~1e-4 m. Amplitude is masked per cell by the
// generator (0 in channels, lakes, beaches; strongest on rocky slopes).

export const DETAIL_MAX = 4.5; // metres at mask = 1

// octaves: [wavelength m, weight, offset]
const OCT = [
  [61.0, 0.58, 2048.0],
  [24.3, 0.29, 2065.31],
  [9.7, 0.13, 2006.3],
];

function hash2(ix, iz) {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iz, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function vnoise(x, z) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const w = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const a = hash2(ix, iz);
  const b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1);
  const d = hash2(ix + 1, iz + 1);
  return (a + (b - a) * u + (c - a) * w + (a - b - c + d) * u * w) * 2 - 1;
}

/** Unmasked detail in [-1, 1]. */
export function detailNoise(x, z) {
  let s = 0;
  for (let o = 0; o < OCT.length; o++) {
    const [L, wgt, off] = OCT[o];
    s += wgt * vnoise(x / L + off, z / L + off);
  }
  return s;
}

/** GLSL (ES 3.0) twin of the functions above + analytic gradient for per-pixel normals. */
export const DETAIL_GLSL = /* glsl */ `
const float DETAIL_MAX = ${DETAIL_MAX.toFixed(4)};
float dHash(ivec2 p) {
  uint h = (uint(p.x) * 0x27d4eb2du) ^ (uint(p.y) * 0x165667b1u);
  h = (h ^ (h >> 15u)) * 0x85ebca6bu;
  h = (h ^ (h >> 13u)) * 0xc2b2ae35u;
  h ^= h >> 16u;
  return float(h) * (1.0 / 4294967296.0);
}
// value noise in [-1,1]; .x value, .yz gradient (per unit of the noise coords)
vec3 dNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  ivec2 ii = ivec2(i);
  float a = dHash(ii);
  float b = dHash(ii + ivec2(1, 0));
  float c = dHash(ii + ivec2(0, 1));
  float d = dHash(ii + ivec2(1, 1));
  float k = a - b - c + d;
  float v = a + (b - a) * u.x + (c - a) * u.y + k * u.x * u.y;
  vec2 g = du * vec2(b - a + k * u.y, c - a + k * u.x);
  return vec3(v * 2.0 - 1.0, g * 2.0);
}
// unmasked detail; .x value [-1,1], .yz d/dx, d/dz in world units
vec3 detailNoise(vec2 xz) {
  vec3 s = vec3(0.0);
  ${OCT.map(([L, w, off]) => `{ vec3 n = dNoise(xz / ${L.toFixed(4)} + vec2(${off.toFixed(4)})); s += ${w.toFixed(4)} * vec3(n.x, n.yz / ${L.toFixed(4)}); }`).join('\n  ')}
  return s;
}
// value only (vertex shader)
float detailValue(vec2 xz) {
  float s = 0.0;
  ${OCT.map(([L, w, off]) => `s += ${w.toFixed(4)} * dNoise(xz / ${L.toFixed(4)} + vec2(${off.toFixed(4)})).x;`).join('\n  ')}
  return s;
}
`;
