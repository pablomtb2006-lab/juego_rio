import * as THREE from 'three';
import { getSkin } from '../../game/skins.js';

/**
 * Shared helpers for every water surface (ocean, lakes, rivers, VFX):
 *   - terrain height sampling on the GPU (manual bilinear texelFetch → works on GPUs without
 *     float-linear filtering and matches TerrainData.heightAt exactly)
 *   - a sea field texture (depth below sea level + signed distance to the coastline)
 *   - noise, sky reflection, fresnel, sun glints
 *   - skin palettes (+ rival tint)
 */

const cache = new WeakMap();

/** Shared animation clock for every water shader (engine time, seconds). */
export const waterTime = { value: 0 };

/** R32F nearest texture sharing TerrainData.heights (no copy). */
export function getHeightTexture(terrain) {
  let c = cache.get(terrain);
  if (!c) cache.set(terrain, (c = {}));
  if (!c.height) {
    const tex = new THREE.DataTexture(terrain.heights, terrain.res, terrain.res, THREE.RedFormat, THREE.FloatType);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    c.height = tex;
  }
  return c.height;
}

/** Uniforms for TERRAIN_GLSL. */
export function terrainUniforms(terrain) {
  return {
    uHeightTex: { value: getHeightTexture(terrain) },
    uTerrainInfo: { value: new THREE.Vector3(terrain.size, terrain.res, terrain.seaLevel) },
  };
}

export const TERRAIN_GLSL = /* glsl */ `
uniform highp sampler2D uHeightTex;
uniform vec3 uTerrainInfo; // size, res, seaLevel
float terrainHeight(vec2 xz) {
  float res = uTerrainInfo.y;
  vec2 g = (xz / uTerrainInfo.x + 0.5) * (res - 1.0);
  g = clamp(g, vec2(0.0), vec2(res - 1.001));
  ivec2 i = ivec2(floor(g));
  vec2 f = g - vec2(i);
  float a = texelFetch(uHeightTex, i, 0).r;
  float b = texelFetch(uHeightTex, i + ivec2(1, 0), 0).r;
  float c = texelFetch(uHeightTex, i + ivec2(0, 1), 0).r;
  float d = texelFetch(uHeightTex, i + ivec2(1, 1), 0).r;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
vec2 terrainUV(vec2 xz) {
  float res = uTerrainInfo.y;
  return ((xz / uTerrainInfo.x + 0.5) * (res - 1.0) + 0.5) / res;
}
`;

/**
 * RG16F texture over the terrain grid: R = depth below sea level (m, negative on land),
 * G = signed euclidean distance to the coastline (m, + at sea, − on land), computed from
 * the sub-cell zero crossings of the bilinear height field so shore foam bands are smooth.
 */
export function getSeaFieldTexture(terrain) {
  let c = cache.get(terrain);
  if (!c) cache.set(terrain, (c = {}));
  if (c.sea) return c.sea;
  const { res, heights, cell, seaLevel } = terrain;
  const n = res * res;
  const INF = 1e9;
  // nearest coastline point per cell (grid coordinates), propagated with 8SSEDT-like sweeps
  const px = new Float32Array(n).fill(INF);
  const pz = new Float32Array(n).fill(INF);
  const d2 = new Float32Array(n).fill(INF);
  const seed = (k, x, z) => {
    const i = k % res;
    const j = (k / res) | 0;
    const dd = (x - i) * (x - i) + (z - j) * (z - j);
    if (dd < d2[k]) {
      d2[k] = dd;
      px[k] = x;
      pz[k] = z;
    }
  };
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const k = j * res + i;
      const h = heights[k] - seaLevel;
      if (i + 1 < res) {
        const h2 = heights[k + 1] - seaLevel;
        if ((h > 0) !== (h2 > 0)) {
          const t = h / (h - h2);
          seed(k, i + t, j);
          seed(k + 1, i + t, j);
        }
      }
      if (j + 1 < res) {
        const h2 = heights[k + res] - seaLevel;
        if ((h > 0) !== (h2 > 0)) {
          const t = h / (h - h2);
          seed(k, i, j + t);
          seed(k + res, i, j + t);
        }
      }
    }
  }
  const relax = (k, kk) => {
    if (px[kk] >= INF) return;
    const i = k % res;
    const j = (k / res) | 0;
    const dd = (px[kk] - i) * (px[kk] - i) + (pz[kk] - j) * (pz[kk] - j);
    if (dd < d2[k]) {
      d2[k] = dd;
      px[k] = px[kk];
      pz[k] = pz[kk];
    }
  };
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const k = j * res + i;
        if (i > 0) relax(k, k - 1);
        if (j > 0) {
          relax(k, k - res);
          if (i > 0) relax(k, k - res - 1);
          if (i < res - 1) relax(k, k - res + 1);
        }
      }
      for (let i = res - 1; i >= 0; i--) {
        const k = j * res + i;
        if (i < res - 1) relax(k, k + 1);
      }
    }
    for (let j = res - 1; j >= 0; j--) {
      for (let i = res - 1; i >= 0; i--) {
        const k = j * res + i;
        if (i < res - 1) relax(k, k + 1);
        if (j < res - 1) {
          relax(k, k + res);
          if (i < res - 1) relax(k, k + res + 1);
          if (i > 0) relax(k, k + res - 1);
        }
      }
      for (let i = 0; i < res; i++) {
        const k = j * res + i;
        if (i > 0) relax(k, k - 1);
      }
    }
  }
  const data = new Uint16Array(n * 2);
  const toHalf = THREE.DataUtils.toHalfFloat;
  for (let k = 0; k < n; k++) {
    const depth = seaLevel - heights[k];
    let dist = d2[k] >= INF ? 4000 : Math.sqrt(d2[k]) * cell;
    dist = Math.min(dist, 4000);
    data[k * 2] = toHalf(Math.max(-2000, Math.min(2000, depth)));
    data[k * 2 + 1] = toHalf(depth >= 0 ? dist : -dist);
  }
  const tex = new THREE.DataTexture(data, res, res, THREE.RGFormat, THREE.HalfFloatType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  c.sea = tex;
  return tex;
}

// ---------------------------------------------------------------------------------------
// GLSL: noise

export const NOISE_GLSL = /* glsl */ `
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
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
// value noise with quintic fade, returns 0..1
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float vnoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i);
  float n100 = hash13(i + vec3(1, 0, 0));
  float n010 = hash13(i + vec3(0, 1, 0));
  float n110 = hash13(i + vec3(1, 1, 0));
  float n001 = hash13(i + vec3(0, 0, 1));
  float n101 = hash13(i + vec3(1, 0, 1));
  float n011 = hash13(i + vec3(0, 1, 1));
  float n111 = hash13(i + vec3(1, 1, 1));
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y), mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}
// gradient noise with analytic derivatives: returns (value, d/dx, d/dy), value in ~[-1,1]
vec3 gnoised(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  vec2 ga = hash22(i) * 2.0 - 1.0;
  vec2 gb = hash22(i + vec2(1.0, 0.0)) * 2.0 - 1.0;
  vec2 gc = hash22(i + vec2(0.0, 1.0)) * 2.0 - 1.0;
  vec2 gd = hash22(i + vec2(1.0, 1.0)) * 2.0 - 1.0;
  float va = dot(ga, f);
  float vb = dot(gb, f - vec2(1.0, 0.0));
  float vc = dot(gc, f - vec2(0.0, 1.0));
  float vd = dot(gd, f - vec2(1.0, 1.0));
  float v = va + u.x * (vb - va) + u.y * (vc - va) + u.x * u.y * (va - vb - vc + vd);
  vec2 d = ga + u.x * (gb - ga) + u.y * (gc - ga) + u.x * u.y * (ga - gb - gc + gd)
         + du * (u.yx * (va - vb - vc + vd) + vec2(vb, vc) - va);
  return vec3(v * 1.4, d * 1.4);
}
float fbm2(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = mat2(1.6, 1.2, -1.2, 1.6) * p; a *= 0.5; }
  return s / 0.9375;
}
// cellular: distance to nearest and second nearest feature (for cracks / bubbles / caustics)
vec2 voronoi(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float d1 = 8.0, d2 = 8.0;
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    vec2 o = hash22(i + g);
    vec2 r = g + o - f;
    float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
  }
  return sqrt(vec2(d1, d2));
}
`;

/** Fragment-only helpers (derivatives). */
export const AA_GLSL = /* glsl */ `
// anti-aliased step: crisp edge whose width follows the pixel footprint of v
float aastep(float threshold, float v) {
  float w = max(fwidth(v), 1e-4) * 0.75;
  return smoothstep(threshold - w, threshold + w, v);
}
`;

// ---------------------------------------------------------------------------------------
// GLSL: lighting (needs ATMOSPHERE_PARS_GLSL first for uSunDir, uSunColor, uSkyColor, uFogColor)

export const LIGHT_GLSL = /* glsl */ `
${AA_GLSL}
#if defined(WATER_ENV_CUBEUV)
  #define ENVMAP_TYPE_CUBE_UV
  uniform sampler2D uEnvMap;
  #include <cube_uv_reflection_fragment>
#elif defined(WATER_ENV_CUBE)
  uniform samplerCube uEnvMap;
#elif defined(WATER_ENV_EQUIRECT)
  uniform sampler2D uEnvMap;
#endif
uniform float uEnvIntensity;

vec3 analyticSky(vec3 d) {
  float y = clamp(d.y, -0.2, 1.0);
  vec3 horizon = uFogColor * 1.05;
  vec3 zenith = uSkyColor * 0.9;
  vec3 c = mix(horizon, zenith, pow(max(y, 0.0), 0.5));
  c = mix(c, uFogColor * 0.75, 1.0 - smoothstep(-0.2, 0.0, y));
  float s = max(dot(d, uSunDir), 0.0);
  c += uSunColor * (pow(s, 10.0) * 0.18 + pow(s, 60.0) * 0.25);
  return c;
}

vec3 skyReflection(vec3 d, float rough) {
  d.y = abs(d.y) * 0.9 + 0.02; // never reflect the ground: stylized water always mirrors sky
  d = normalize(d);
#if defined(WATER_ENV_CUBEUV)
  return textureCubeUV(uEnvMap, d, rough).rgb * uEnvIntensity;
#elif defined(WATER_ENV_CUBE)
  return textureLod(uEnvMap, vec3(-d.x, d.y, d.z), rough * 6.0).rgb * uEnvIntensity;
#elif defined(WATER_ENV_EQUIRECT)
  vec2 uv = vec2(atan(d.z, d.x) * 0.15915494 + 0.5, asin(clamp(d.y, -1.0, 1.0)) * 0.31830989 + 0.5);
  return texture(uEnvMap, uv).rgb * uEnvIntensity;
#else
  return analyticSky(d);
#endif
}

float fresnelSchlick(float cosT, float f0) {
  return f0 + (1.0 - f0) * pow(1.0 - clamp(cosT, 0.0, 1.0), 5.0);
}

// sun specular: sharp core + soft lobe (stylized "hot spot" on water)
vec3 sunSpecular(vec3 N, vec3 V, float sharp, float soft) {
  vec3 H = normalize(uSunDir + V);
  float nh = max(dot(N, H), 0.0);
  return uSunColor * (pow(nh, sharp) * 4.0 + pow(nh, soft) * 0.35);
}

// twinkling glints sitting on the sun's reflection path (world-space cells)
float sunGlints(vec2 xz, float cellSize, vec3 N, vec3 V, float t) {
  vec3 R = reflect(-V, N);
  float lobe = pow(max(dot(R, uSunDir), 0.0), 18.0);
  if (lobe < 0.01) return 0.0;
  vec2 p = xz / cellSize;
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 o = hash22(i);
  float ph = hash12(i + 17.0);
  float tw = sin(t * (3.0 + ph * 5.0) + ph * 40.0);
  float d = length(f - o);
  float star = (1.0 - smoothstep(0.0, 0.09, d)) * smoothstep(0.55, 1.0, tw);
  return star * lobe;
}

// "lit water body" ambient + sun wrap for the body colour
vec3 waterBodyLight(vec3 N) {
  float ndl = dot(N, uSunDir) * 0.5 + 0.5;
  return mix(uSkyColor * 0.55 + vec3(0.25), uSunColor * 1.1, ndl * 0.6);
}
`;

/** Env-map handling: returns {defines, uniforms}; call syncEnv() each frame to follow atmosphere.envMap. */
export function envUniforms() {
  return { uEnvMap: { value: null }, uEnvIntensity: { value: 1 } };
}

export function syncEnv(material, envMap) {
  if (material.userData.envMap === envMap) return;
  material.userData.envMap = envMap;
  const d = material.defines;
  delete d.WATER_ENV_CUBEUV;
  delete d.WATER_ENV_CUBE;
  delete d.WATER_ENV_EQUIRECT;
  delete d.CUBEUV_TEXEL_WIDTH;
  delete d.CUBEUV_TEXEL_HEIGHT;
  delete d.CUBEUV_MAX_MIP;
  if (envMap) {
    if (envMap.mapping === THREE.CubeUVReflectionMapping && envMap.image?.height) {
      const h = envMap.image.height;
      const maxMip = Math.log2(h) - 2;
      d.WATER_ENV_CUBEUV = '';
      d.CUBEUV_TEXEL_HEIGHT = (1 / h).toFixed(8);
      d.CUBEUV_TEXEL_WIDTH = (1 / (3 * Math.max(Math.pow(2, maxMip), 7 * 16))).toFixed(8);
      d.CUBEUV_MAX_MIP = maxMip.toFixed(1);
    } else if (envMap.isCubeTexture) d.WATER_ENV_CUBE = '';
    else if (envMap.mapping === THREE.EquirectangularReflectionMapping) d.WATER_ENV_EQUIRECT = '';
    else envMap = null;
  }
  material.uniforms.uEnvMap.value = envMap;
  material.needsUpdate = true;
}

// ---------------------------------------------------------------------------------------
// Skins

/** Which special-effect branch a skin uses in the water shaders. */
export const SKIN_FX = { clear: 0, tropical: 0, glacier: 5, toxic: 4, gold: 3, magma: 1, galaxy: 2 };

/**
 * Linear-space palette for a stream. Rivals keep reading as water but carry a clear tint of
 * their colour (shallow + foam edge) so they are distinguishable from the player.
 */
export function streamPalette(stream) {
  const skin = getSkin(stream.skin);
  const deep = new THREE.Color(skin.deep);
  const shallow = new THREE.Color(skin.shallow);
  const foam = new THREE.Color(skin.foam);
  const glow = new THREE.Color(skin.glow);
  const tint = new THREE.Color(stream.color ?? 0xffffff);
  const isRival = !stream.isPlayer;
  if (isRival) {
    deep.lerp(tint.clone().multiplyScalar(0.55), 0.42);
    shallow.lerp(tint, 0.42);
    foam.lerp(tint, 0.1);
  }
  return { deep, shallow, foam, glow, tint, isRival, fx: SKIN_FX[skin.id] ?? 0, rarity: skin.rarity, id: skin.id };
}
