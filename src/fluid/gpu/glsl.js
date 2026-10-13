/**
 * GLSL shared by every solver pass: sizes as compile-time constants, texel ↔ index mapping,
 * the uniform grid, and the neighbour loop.
 */
export function header(L, { vertex = false } = {}) {
  return /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
#define TW ${L.TW}
#define TH ${L.TH}
#define TWS ${Math.log2(L.TW)}
#define NP ${L.TW * L.TH}
#define GX ${L.GX}
#define GY ${L.GY}
#define GZ ${L.GZ}
#define CTW ${L.CTW}
#define BIG 1.0e8
#define MAX_PER_CELL 96
uniform vec3 uGridMin;
uniform float uCell;
ivec2 tc(int i) { return ivec2(i & (TW - 1), i >> TWS); }
${vertex ? '' : 'int fragIndex() { ivec2 f = ivec2(gl_FragCoord.xy); return f.y * TW + f.x; }'}
ivec3 cellOf(vec3 p) {
  return clamp(ivec3(floor((p - uGridMin) / uCell)), ivec3(0), ivec3(GX - 1, GY - 1, GZ - 1));
}
int cellId(ivec3 c) { return c.x + GX * (c.y + GY * c.z); }
ivec2 cellTC(int c) { return ivec2(c % CTW, c / CTW); }
`;
}

/**
 * Loop over every particle j in the 27 cells around `P` (sorted order), running `body` with
 * `j` (int) defined. Needs `uCells` (start+1, end+1 per cell) in scope.
 */
export function neighbours(P, body) {
  return /* glsl */ `{
  ivec3 nc_ = cellOf(${P});
  for (int nz_ = -1; nz_ <= 1; nz_++)
  for (int ny_ = -1; ny_ <= 1; ny_++)
  for (int nx_ = -1; nx_ <= 1; nx_++) {
    ivec3 cc_ = nc_ + ivec3(nx_, ny_, nz_);
    if (any(lessThan(cc_, ivec3(0))) || any(greaterThanEqual(cc_, ivec3(GX, GY, GZ)))) continue;
    vec2 se_ = texelFetch(uCells, cellTC(cellId(cc_)), 0).rg;
    if (se_.x < 0.5) continue;
    int s_ = int(se_.x) - 1;
    int e_ = min(int(se_.y) - 1, s_ + MAX_PER_CELL);
    for (int j = s_; j <= e_; j++) {
      ${body}
    }
  }
}`;
}
