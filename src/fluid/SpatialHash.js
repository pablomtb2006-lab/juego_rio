import { header } from './gpu/glsl.js';

/**
 * SpatialHash — neighbour search on the GPU, exact (no hash collisions):
 *
 *   1. key = linear index of the grid cell (cell size = h) the particle's predicted position is in;
 *      inactive particles get key = BIG so they sort to the end.
 *   2. bitonic sort of (key, particle index) — data-independent, log²N fullscreen passes.
 *   3. cell table: for every cell, the first and last sorted index, written by scattering one
 *      point per particle that starts (or ends) a run of equal keys.
 *
 * After this, every particle's neighbours are the runs of its 27 surrounding cells.
 * Because inactive particles sort last, active particles always occupy indices [0, nActive):
 * the emitter relies on that to know which slots are free.
 */
export class SpatialHash {
  constructor(gpu, L) {
    this.gpu = gpu;
    this.L = L;
    const H = header(L);
    this.keys = [gpu.texture(L.TW, L.TH), gpu.texture(L.TW, L.TH)];
    this.cells = gpu.texture(L.CTW, L.CTH);

    this.hashProg = gpu.program(
      'hash',
      `${H}
uniform sampler2D uPred;
out vec4 o;
void main() {
  int i = fragIndex();
  vec4 P = texelFetch(uPred, tc(i), 0);
  float key = P.w < 0.0 ? BIG : float(cellId(cellOf(P.xyz)));
  o = vec4(key, float(i), 0.0, 0.0);
}`,
    );

    this.sortProg = gpu.program(
      'bitonic',
      `${H}
uniform sampler2D uKeys;
uniform int uK;
uniform int uJ;
out vec4 o;
void main() {
  int i = fragIndex();
  int l = i ^ uJ;
  vec4 a = texelFetch(uKeys, tc(i), 0);
  vec4 b = texelFetch(uKeys, tc(l), 0);
  bool ascending = (i & uK) == 0;
  bool lower = i < l;
  // strict total order: key, then original index (deterministic, stable)
  bool aLess = a.x < b.x || (a.x == b.x && a.y < b.y);
  bool keepA = (lower == ascending) ? aLess : !aLess;
  o = keepA ? a : b;
}`,
    );

    // scatter one point per run start (mode 0) or run end (mode 1) into the cell table
    const scatterVS = `${header(L, { vertex: true })}
uniform sampler2D uKeys;
uniform int uMode;
out float vVal;
void main() {
  int i = gl_VertexID;
  float k = texelFetch(uKeys, tc(i), 0).x;
  bool edge = uMode == 0
    ? (i == 0 || texelFetch(uKeys, tc(i - 1), 0).x != k)
    : (i == NP - 1 || texelFetch(uKeys, tc(i + 1), 0).x != k);
  gl_PointSize = 1.0;
  vVal = float(i + 1);
  if (!edge || k >= BIG * 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  int c = int(k);
  vec2 t = (vec2(float(c % CTW), float(c / CTW)) + 0.5) / vec2(float(CTW), float(${L.CTH}));
  gl_Position = vec4(t * 2.0 - 1.0, 0.0, 1.0);
}`;
    this.scatterProg = gpu.program(
      'cellScatter',
      `${H}
in float vVal;
out vec4 o;
void main() { o = vec4(vVal); }`,
      scatterVS,
    );
  }

  /** Hash + sort the predicted positions. Returns the sorted key texture (x = key, y = source index). */
  sort(predTex, gridU) {
    const { gpu, L } = this;
    gpu.pass(this.hashProg, [this.keys[0]], { ...gridU, uPred: predTex });
    let src = 0;
    const N = L.TW * L.TH;
    for (let k = 2; k <= N; k <<= 1) {
      for (let j = k >> 1; j > 0; j >>= 1) {
        gpu.pass(this.sortProg, [this.keys[1 - src]], { uKeys: this.keys[src], uK: k, uJ: j });
        src = 1 - src;
      }
    }
    this.sorted = this.keys[src];
    return this.sorted;
  }

  /** Build the cell table (start+1 in R, end+1 in G; 0 = empty) from the sorted keys. */
  buildCells() {
    const { gpu, L } = this;
    const gl = gpu.gl;
    gpu.clear([this.cells]);
    gpu.begin(gpu.target([this.cells]));
    gpu.use(this.scatterProg, { uKeys: this.sorted, uMode: 0 });
    gl.colorMask(true, false, false, false);
    gl.drawArrays(gl.POINTS, 0, L.TW * L.TH);
    gpu.use(this.scatterProg, { uKeys: this.sorted, uMode: 1 });
    gl.colorMask(false, true, false, false);
    gl.drawArrays(gl.POINTS, 0, L.TW * L.TH);
    gl.colorMask(true, true, true, true);
    return this.cells;
  }
}
