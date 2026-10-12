import * as THREE from 'three';

/**
 * Time-of-day keyframes for the stylized lighting rig. t ∈ [0, 1), 0.5 = noon.
 * Colours are authored in sRGB hex (converted to linear by THREE.Color).
 *
 *   elev / az        sun elevation & azimuth in degrees (az 0 = +X, 90 = +Z)
 *   sun, sunI        sun colour and intensity (three.js physical units, ~π = 1:1 diffuse)
 *   zenith, horizon  sky gradient
 *   fog              haze colour at the horizon (distant mountains fade into it)
 *   glow, glowI      forward-scatter glow around the sun (sky + fog)
 *   density          height-fog density at sea level (1/m), falloff height (m)
 *   aerial           altitude-independent aerial perspective density (1/m)
 *   ambient          hemisphere sky / ground colours (custom shaders + Lambert/Phong)
 *   env              scene.environmentIntensity (PBR ambient + reflections)
 *   cloudLit/Shade   cumulus lit top / shadowed underside
 *   exposure         post tone-mapping exposure
 *   grade            { warm, cool, sat, contrast } colour grade (PostFX)
 */
export const KEYS = [
  {
    t: 0.0, // deep blue night (moonlit)
    elev: -18, az: 300,
    sun: 0x9fb6ff, sunI: 0.35,
    zenith: 0x0a1430, horizon: 0x24345e, fog: 0x2a3a62, glow: 0x3a4f8a, glowI: 0.15,
    density: 0.00008, falloff: 800, aerial: 0.000008,
    skyAmb: 0x2a3c6e, groundAmb: 0x141824, hemiI: 0.6, env: 0.45,
    cloudLit: 0x8796c4, cloudShade: 0x2a3358,
    exposure: 1.25,
    grade: { warm: 0.0, cool: 0.6, sat: 1.0, contrast: 1.05 },
  },
  {
    t: 0.22, // pre-dawn
    elev: -3, az: 200,
    sun: 0xff9a6a, sunI: 0.6,
    zenith: 0x2a3f78, horizon: 0xe79a7e, fog: 0xa48aa2, glow: 0xff8a5c, glowI: 0.9,
    density: 0.0001, falloff: 700, aerial: 0.00001,
    skyAmb: 0x6c78ae, groundAmb: 0x3a2e34, hemiI: 0.6, env: 0.6,
    cloudLit: 0xffb08f, cloudShade: 0x6a5d8e,
    exposure: 1.15,
    grade: { warm: 0.4, cool: 0.5, sat: 1.08, contrast: 1.04 },
  },
  {
    t: 0.3, // morning
    elev: 20, az: 205,
    sun: 0xffdcae, sunI: 2.7,
    zenith: 0x3a82d6, horizon: 0xcfe2f4, fog: 0xb4cce4, glow: 0xffd2a0, glowI: 0.6,
    density: 0.00008, falloff: 700, aerial: 0.000007,
    skyAmb: 0x9cc0ec, groundAmb: 0x6c6a48, hemiI: 0.55, env: 1.35,
    cloudLit: 0xfff1e0, cloudShade: 0x98a3d2,
    exposure: 1.0,
    grade: { warm: 0.35, cool: 0.4, sat: 1.1, contrast: 1.06 },
  },
  {
    t: 0.5, // "noon" — the gameplay look: warm sun at ~42°, deep blue zenith
    elev: 42, az: 225,
    sun: 0xffe9c9, sunI: 3.3,
    zenith: 0x2a7ae6, horizon: 0xb2dcff, fog: 0x9ccaf2, glow: 0xfff0d8, glowI: 0.45,
    density: 0.00006, falloff: 700, aerial: 0.000006,
    skyAmb: 0xa8cff5, groundAmb: 0x7a7550, hemiI: 0.55, env: 1.45,
    cloudLit: 0xffffff, cloudShade: 0xa9b8dc,
    exposure: 1.0,
    grade: { warm: 0.3, cool: 0.45, sat: 1.12, contrast: 1.07 },
  },
  {
    t: 0.64, // late afternoon (menu mood)
    elev: 26, az: 248,
    sun: 0xffd29a, sunI: 3.1,
    zenith: 0x2a72d8, horizon: 0xc4ddf6, fog: 0xadc8ea, glow: 0xffc888, glowI: 0.75,
    density: 0.00006, falloff: 700, aerial: 0.000006,
    skyAmb: 0xa2c2ec, groundAmb: 0x7a6a48, hemiI: 0.55, env: 1.4,
    cloudLit: 0xfff2e0, cloudShade: 0xa6aed8,
    exposure: 1.02,
    grade: { warm: 0.45, cool: 0.45, sat: 1.12, contrast: 1.08 },
  },
  {
    t: 0.74, // golden hour (victory)
    elev: 9, az: 262,
    sun: 0xffb46e, sunI: 2.6,
    zenith: 0x3459a8, horizon: 0xf6c49a, fog: 0xc6a7b4, glow: 0xff9a52, glowI: 1.35,
    density: 0.00008, falloff: 700, aerial: 0.000008,
    skyAmb: 0x9aa0d0, groundAmb: 0x6e5040, hemiI: 0.6, env: 1.3,
    cloudLit: 0xffc49a, cloudShade: 0x7e72aa,
    exposure: 1.08,
    grade: { warm: 0.6, cool: 0.55, sat: 1.14, contrast: 1.08 },
  },
  {
    t: 0.8, // dusk (fireworks)
    elev: 1.5, az: 270,
    sun: 0xff8a52, sunI: 1.4,
    zenith: 0x24386e, horizon: 0xe8957a, fog: 0x9c86a8, glow: 0xff7a4a, glowI: 1.25,
    density: 0.00009, falloff: 700, aerial: 0.000009,
    skyAmb: 0x6c7ab6, groundAmb: 0x46383c, hemiI: 0.7, env: 1.1,
    cloudLit: 0xff9c7a, cloudShade: 0x5c5486,
    exposure: 1.18,
    grade: { warm: 0.55, cool: 0.65, sat: 1.12, contrast: 1.08 },
  },
  {
    t: 0.88, // night
    elev: -12, az: 290,
    sun: 0x9fb6ff, sunI: 0.35,
    zenith: 0x0c1734, horizon: 0x2a3766, fog: 0x2e3d66, glow: 0x4a5b9a, glowI: 0.25,
    density: 0.00008, falloff: 800, aerial: 0.000008,
    skyAmb: 0x2c3e70, groundAmb: 0x151926, hemiI: 0.6, env: 0.45,
    cloudLit: 0x8c9ac8, cloudShade: 0x2c355a,
    exposure: 1.25,
    grade: { warm: 0.0, cool: 0.6, sat: 1.0, contrast: 1.05 },
  },
];

/** Named moods used by the game flow. */
export const MOODS = {
  day: 0.5,
  menu: 0.64,
  victory: 0.765,
  dusk: 0.8,
};

const _a = new THREE.Color();
const _b = new THREE.Color();
const COLOR_KEYS = ['sun', 'zenith', 'horizon', 'fog', 'glow', 'skyAmb', 'groundAmb', 'cloudLit', 'cloudShade'];
const NUM_KEYS = ['elev', 'az', 'sunI', 'glowI', 'density', 'falloff', 'aerial', 'hemiI', 'env', 'exposure'];

/** Sample the keyframes at t (wraps). Returns a fresh state object with THREE.Color values. */
export function sampleTimeOfDay(t, out = {}) {
  t = ((t % 1) + 1) % 1;
  let i = 0;
  while (i < KEYS.length - 1 && KEYS[i + 1].t <= t) i++;
  const k0 = KEYS[i];
  const k1 = KEYS[(i + 1) % KEYS.length];
  const t1 = k1.t <= k0.t ? k1.t + 1 : k1.t;
  let f = (t - k0.t) / Math.max(t1 - k0.t, 1e-6);
  f = f * f * (3 - 2 * f);
  for (const key of COLOR_KEYS) {
    out[key] ??= new THREE.Color();
    // interpolate in linear space (THREE.Color stores linear values)
    out[key].copy(_a.set(k0[key])).lerp(_b.set(k1[key]), f);
  }
  for (const key of NUM_KEYS) {
    let v0 = k0[key];
    let v1 = k1[key];
    if (key === 'az' && Math.abs(v1 - v0) > 180) v1 += v1 < v0 ? 360 : -360;
    out[key] = v0 + (v1 - v0) * f;
  }
  out.grade ??= {};
  for (const g of ['warm', 'cool', 'sat', 'contrast']) out.grade[g] = k0.grade[g] + (k1.grade[g] - k0.grade[g]) * f;
  out.t = t;
  return out;
}
