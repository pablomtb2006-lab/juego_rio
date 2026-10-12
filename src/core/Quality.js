// Quality presets. Every system reads ctx.quality instead of hard-coding costs.
//
// Shared keys (read by other systems — keep them): name, pixelRatio, shadows, shadowMapSize,
// shadowCascades, ao, bloom, terrainRings, terrainGrid, vegetationDensity, grass, particles,
// drawDistance.
// Render-only keys (render/*):
//   shadowMapSize     per cascade (the sun uses 2 cascades in one atlas: 2·size × size)
//   shadowDistance    metres of shadow from a ground-level camera (scaled up with altitude)
//   shadowSoftness    PCF filter radius in texels
//   clouds            cumulus puff density multiplier
//   cloudShadows      strength of the moving cloud shadows on the landscape (0 = off)
//   envMapSize        PMREM resolution of the sky environment
//   antialias         'smaa' | 'fxaa' | 'none'
//   aoQuality         N8AO mode ('Performance' | 'Low' | 'Medium' | 'High' | 'Ultra')
//   aoHalfRes, aoRadius
//   bloomLevels       mip levels of the bloom blur
export const PRESETS = {
  low: {
    name: 'low',
    pixelRatio: 0.75,
    shadows: false,
    shadowMapSize: 1024,
    shadowCascades: 1,
    ao: false,
    bloom: true,
    terrainRings: 4,
    terrainGrid: 64,
    vegetationDensity: 0.35,
    grass: false,
    particles: 0.4,
    drawDistance: 6000,
    shadowDistance: 600,
    shadowSoftness: 1.5,
    clouds: 0.55,
    cloudShadows: 0.45,
    envMapSize: 64,
    antialias: 'fxaa',
    aoQuality: 'Performance',
    aoHalfRes: true,
    aoRadius: 6,
    bloomLevels: 4,
  },
  medium: {
    name: 'medium',
    pixelRatio: 1,
    shadows: true,
    shadowMapSize: 1024,
    shadowCascades: 2,
    ao: false,
    bloom: true,
    terrainRings: 5,
    terrainGrid: 96,
    vegetationDensity: 0.6,
    grass: true,
    particles: 0.7,
    drawDistance: 9000,
    shadowDistance: 900,
    shadowSoftness: 1.8,
    clouds: 0.75,
    cloudShadows: 0.5,
    envMapSize: 128,
    antialias: 'smaa',
    aoQuality: 'Performance',
    aoHalfRes: true,
    aoRadius: 6,
    bloomLevels: 5,
  },
  high: {
    name: 'high',
    pixelRatio: 1.5,
    shadows: true,
    shadowMapSize: 2048,
    shadowCascades: 2,
    ao: true,
    bloom: true,
    terrainRings: 6,
    terrainGrid: 128,
    vegetationDensity: 1,
    grass: true,
    particles: 1,
    drawDistance: 14000,
    shadowDistance: 1400,
    shadowSoftness: 2.2,
    clouds: 1,
    cloudShadows: 0.55,
    envMapSize: 128,
    antialias: 'smaa',
    aoQuality: 'Medium',
    aoHalfRes: true,
    aoRadius: 6,
    bloomLevels: 6,
  },
  ultra: {
    name: 'ultra',
    pixelRatio: 2,
    shadows: true,
    shadowMapSize: 3072,
    shadowCascades: 2,
    ao: true,
    bloom: true,
    terrainRings: 7,
    terrainGrid: 160,
    vegetationDensity: 1.4,
    grass: true,
    particles: 1.3,
    drawDistance: 18000,
    shadowDistance: 2000,
    shadowSoftness: 2.4,
    clouds: 1.25,
    cloudShadows: 0.55,
    envMapSize: 256,
    antialias: 'smaa',
    aoQuality: 'High',
    aoHalfRes: false,
    aoRadius: 6,
    bloomLevels: 7,
  },
};

const ORDER = ['low', 'medium', 'high', 'ultra'];
const CACHE_KEY = 'rio.quality.auto.v1';

/**
 * ?quality=low|medium|high|ultra wins. Otherwise: cached auto result, else a GPU probe
 * (renderer string + a ~10 ms fill-rate micro-benchmark on a throwaway WebGL2 context).
 * Auto never picks 'ultra' (opt-in).
 */
export function detectQuality(requested) {
  if (requested && PRESETS[requested]) return { ...PRESETS[requested] };
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached && PRESETS[cached]) return { ...PRESETS[cached], auto: true };
  } catch {
    /* storage blocked */
  }
  let tier;
  try {
    tier = classify(probeGPU());
  } catch {
    tier = fallbackTier();
  }
  try {
    localStorage.setItem(CACHE_KEY, tier);
  } catch {
    /* storage blocked */
  }
  return { ...PRESETS[tier], auto: true };
}

function isMobile() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const iPadOS = typeof navigator !== 'undefined' && navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || iPadOS;
}

function fallbackTier() {
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  if (isMobile()) return cores >= 8 ? 'medium' : 'low';
  return cores >= 8 ? 'high' : 'medium';
}

/** Renderer string + timing of a heavy fragment shader. Returns { renderer, ms, mobile }. */
export function probeGPU() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const gl = canvas.getContext('webgl2', { powerPreference: 'high-performance', antialias: false, depth: false });
  if (!gl) return { renderer: '', ms: Infinity, mobile: isMobile(), noWebGL2: true };
  let renderer = gl.getParameter(gl.RENDERER) || '';
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  if (dbg) renderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || renderer;

  let ms = Infinity;
  try {
    const vs = `#version 300 es
      void main(){ vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;
    const fs = `#version 300 es
      precision highp float; uniform float uSeed; out vec4 o;
      void main(){
        vec2 p = gl_FragCoord.xy * 0.01 + uSeed; float a = 0.0;
        for (int i = 0; i < 96; i++) { p = vec2(p.x * 1.07 + sin(p.y + a), p.y * 0.93 + cos(p.x - a)); a += fract(p.x * p.y * 0.137); }
        o = vec4(fract(a), fract(p), 1.0);
      }`;
    const prog = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      gl.attachShader(prog, sh);
    }
    gl.linkProgram(prog);
    if (gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      gl.useProgram(prog);
      const loc = gl.getUniformLocation(prog, 'uSeed');
      const px = new Uint8Array(4);
      // warm-up (compile + first draw), then bail out early on software rasterizers
      gl.uniform1f(loc, 0.1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let t0 = performance.now();
      gl.uniform1f(loc, 0.2);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const single = performance.now() - t0;
      if (single > 25) ms = single * 6;
      else {
        t0 = performance.now();
        for (let i = 0; i < 6; i++) {
          gl.uniform1f(loc, 0.3 + i);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
        }
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        ms = performance.now() - t0;
      }
    }
  } catch {
    /* keep ms = Infinity */
  }
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return { renderer, ms, mobile: isMobile() };
}

function classify({ renderer = '', ms = Infinity, mobile, noWebGL2 }) {
  const r = renderer.toLowerCase();
  if (noWebGL2 || /swiftshader|llvmpipe|softpipe|software|basic render/.test(r)) return 'low';
  let tier;
  if (mobile) {
    if (/apple gpu|apple a1[5-9]|apple m\d/.test(r)) tier = 'medium';
    else if (/adreno.*(6[4-9]\d|7\d\d|8\d\d)|mali-g(7[1-9]|[89]\d|71\d|72\d)|immortalis|xclipse/.test(r)) tier = 'medium';
    else tier = 'low';
  } else if (/rtx|gtx (9[6-9]0|10[5-8]0|16[5-6]0)|radeon (rx|pro)|rx [5-9]\d{3}|apple m\d|arc a\d/.test(r)) tier = 'high';
  else if (/intel|iris|uhd|hd graphics|vega [3-8]\b|radeon\(tm\) graphics|mali|adreno/.test(r)) tier = 'medium';
  else tier = 'medium';

  // the micro-benchmark nudges the guess (≈ 6 draws of 256² px × 96 heavy iterations)
  let i = ORDER.indexOf(tier);
  if (ms > 60) i = 0;
  else if (ms > 18) i = Math.min(i, 1);
  else if (ms < 3 && !mobile && i === 1) i = 2;
  return ORDER[Math.min(i, 2)];
}
