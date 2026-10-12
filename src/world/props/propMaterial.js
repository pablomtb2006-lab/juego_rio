import * as THREE from 'three';
import { getFoliageAtlas } from './textures.js';

/**
 * Prop materials: MeshStandardMaterial + onBeforeCompile so props get the engine's
 * lights, shadows, environment and scene.fog for free (atmosphere contract for
 * Standard materials), plus:
 *   - instanced world transform done once (wind sway, leaf flutter, stream push)
 *   - camera-facing foliage cards (aCard) for fluffy, alpha-tested silhouettes
 *   - far-LOD hiding inside the near LOD radius (+ thinning compensation)
 *   - foliage translucency / sky rim, rock moss + strata + snow, grass gradients
 * Every material gets a matching customDepthMaterial so shadows sway / use cards too.
 *
 * Shared uniforms live in PROP_UNIFORMS (updated by Vegetation.update).
 */
export const PROP_UNIFORMS = {
  uPropTime: { value: 0 },
  uWind: { value: new THREE.Vector4(0.8, 0.6, 1, 0) }, // xy = dir, z = strength multiplier
  uLodCenter: { value: new THREE.Vector3() },
  uStreams: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
  uSunDirP: { value: new THREE.Vector3(0.45, 0.55, 0.35).normalize() },
  uSunColorP: { value: new THREE.Color(1, 0.92, 0.8) },
  uSkyColorP: { value: new THREE.Color(0.45, 0.65, 1) },
  uMossColor: { value: new THREE.Color(0x6eaa24) },
  uMossColor2: { value: new THREE.Color(0x9bcb32) },
  uSnowLine: { value: 1e5 },
  uGrassFar: { value: 60 },
  uThin: { value: new THREE.Vector2(2500, 7000) }, // far thinning start / end distance
  uFocus: { value: new THREE.Vector4(0, 0, 0, 0) }, // xyz = what the camera looks at (stream head), w = on
  uOccRadius: { value: 6 },
};

/** Hook the shared sun/sky uniforms to the atmosphere ones when present (same objects). */
export function linkAtmosphere(ctx) {
  const u = ctx.atmosphere?.uniforms;
  if (!u) return;
  if (u.uSunDir) PROP_UNIFORMS.uSunDirP = u.uSunDir;
  if (u.uSunColor) PROP_UNIFORMS.uSunColorP = u.uSunColor;
  if (u.uSkyColor) PROP_UNIFORMS.uSkyColorP = u.uSkyColor;
}

const VERT_PARS = /* glsl */ `
attribute vec2 aCard;
attribute float aWind;
attribute float aTint;
uniform float uPropTime;
uniform vec4 uWind;
uniform vec3 uLodCenter;
uniform vec4 uStreams[4];
uniform float uWindAmp;
uniform float uFlutter;
uniform float uFarHide;
uniform float uGrassFar;
uniform vec2 uThin;
varying vec3 vPropWorld;
varying float vPropWind;
`;

const PROJECT = /* glsl */ `
#ifdef USE_INSTANCING
  mat4 propInst = instanceMatrix;
#else
  mat4 propInst = mat4(1.0);
#endif
  vec3 propOrigin = (modelMatrix * propInst * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float propScale = length(propInst[1].xyz);
  vec4 propWorld = modelMatrix * propInst * vec4(transformed, 1.0);
  float propPhase = dot(propOrigin.xz, vec2(0.0123, 0.0171));
  vPropWind = aWind;

#ifdef PROP_FAR
  {
    float pd = distance(propOrigin, uLodCenter);
    float keep = smoothstep(uFarHide, uFarHide * 1.04 + 8.0, pd);
    // distance thinning (CPU drops instances) → grow the survivors to keep coverage
    float tk = 1.0 - 0.55 * smoothstep(uThin.x, uThin.y, pd);
    float grow = inversesqrt(tk);
    propWorld.xyz = propOrigin + (propWorld.xyz - propOrigin) * grow * keep;
  }
#endif

#ifdef PROP_GRASS
  {
    float gd = distance(propOrigin.xz, uLodCenter.xz);
    float gk = 1.0 - smoothstep(uGrassFar * 0.55, uGrassFar, gd);
    propWorld.xyz = propOrigin + (propWorld.xyz - propOrigin) * gk;
  }
#endif

#ifdef PROP_WIND
  {
    float w = aWind * uWindAmp * propScale * uWind.z;
    float gust = 0.55 + 0.45 * sin(uPropTime * 0.37 + dot(propOrigin.xz, vec2(0.0021, 0.0016)));
    float sway = sin(uPropTime * 1.15 + propPhase) * 0.65 + sin(uPropTime * 2.37 + propPhase * 1.9) * 0.35;
    vec2 wd = uWind.xy;
    propWorld.xz += wd * w * gust * (0.55 + 0.45 * sway);
    propWorld.xz += vec2(-wd.y, wd.x) * w * 0.22 * sin(uPropTime * 0.93 + propPhase * 1.3);
    float fl = aWind * uFlutter * propScale * aTint;
    propWorld.xyz += fl * vec3(
      sin(uPropTime * 5.3 + propWorld.x * 0.61 + propWorld.y * 0.37),
      sin(uPropTime * 6.7 + propWorld.z * 0.53) * 0.6,
      cos(uPropTime * 4.9 + propWorld.y * 0.71 + propWorld.z * 0.29));
  }
#endif

#ifdef PROP_STREAM
  for (int i = 0; i < 4; i++) {
    vec4 s = uStreams[i];
    vec2 dv = propOrigin.xz - s.xy;
    float dd = length(dv);
    float push = s.w * (1.0 - smoothstep(s.z, s.z + 16.0, dd));
    vec2 away = dv / max(dd, 0.001);
    float bw = aWind * propScale;
    propWorld.xz += away * push * bw * PROP_STREAM_BEND;
    propWorld.xz += vec2(sin(uPropTime * 21.0 + propPhase * 7.0), cos(uPropTime * 17.0 + propPhase * 5.0)) * push * bw * 0.3;
#ifdef PROP_GRASS
    propWorld.y -= push * aWind * propScale * 0.45;
#endif
  }
#endif

#ifdef PROP_CARDS
  {
    vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    propWorld.xyz += (camR * aCard.x + camU * aCard.y) * propScale;
  }
#endif

  vPropWorld = propWorld.xyz;
  vec4 mvPosition = viewMatrix * propWorld;
  gl_Position = projectionMatrix * mvPosition;
`;

const COLOR_VERTEX = /* glsl */ `
#if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
  vColor = vec4( 1.0 );
#endif
#ifdef USE_COLOR
  vColor.rgb *= color;
#endif
#ifdef USE_INSTANCING_COLOR
  vColor.rgb *= mix( vec3( 1.0 ), instanceColor.rgb, aTint );
#endif
`;

const FRAG_PARS = /* glsl */ `
uniform vec3 uSunDirP;
uniform vec3 uSunColorP;
uniform vec3 uSkyColorP;
uniform vec3 uMossColor;
uniform vec3 uMossColor2;
uniform float uSnowLine;
uniform float uMossAmount;
uniform float uSnowAmount;
uniform float uStrata;
uniform float uTranslucency;
uniform vec4 uFocus;
uniform float uOccRadius;
varying vec3 vPropWorld;
varying float vPropWind;
float propBayer(vec2 p) {
  vec2 q = mod(floor(p), 4.0);
  int i = int(q.x) + int(q.y) * 4;
  float m[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
  return (m[i] + 0.5) / 16.0;
}
float propHash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
// 3D value noise in [0, 1] (rock strata / moss breakup)
float propNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(propHash(i), propHash(i + vec3(1, 0, 0)), f.x),
                 mix(propHash(i + vec3(0, 1, 0)), propHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(propHash(i + vec3(0, 0, 1)), propHash(i + vec3(1, 0, 1)), f.x),
                 mix(propHash(i + vec3(0, 1, 1)), propHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
`;

// screen-door fade of props that hide the stream head (chase cam) or touch the lens
const OCCLUDE = /* glsl */ `
#include <clipping_planes_fragment>
#ifdef PROP_OCCLUDE
  {
    float hide = 1.0 - smoothstep(2.5, 8.0, distance(vPropWorld, cameraPosition));
    if (uFocus.w > 0.5) {
      vec3 ab = uFocus.xyz - cameraPosition;
      float t = dot(vPropWorld - cameraPosition, ab) / max(dot(ab, ab), 1.0);
      vec3 cp = cameraPosition + ab * clamp(t, 0.0, 1.0);
      float seg = (1.0 - smoothstep(uOccRadius * 0.5, uOccRadius, distance(vPropWorld, cp))) * step(0.0, t) * (1.0 - smoothstep(0.85, 0.98, t));
      hide = max(hide, seg);
    }
    if (hide > propBayer(gl_FragCoord.xy)) discard;
  }
#endif
`;

const ALPHA_TEST = /* glsl */ `
#ifdef USE_ALPHATEST
  {
    // keep foliage coverage at lower mips (alpha-tested leaves otherwise thin out with distance)
    vec2 tuv = vMapUv * 512.0;
    vec2 tdx = dFdx(tuv);
    vec2 tdy = dFdy(tuv);
    float tlod = max(0.0, 0.5 * log2(max(dot(tdx, tdx), dot(tdy, tdy))));
    diffuseColor.a *= 1.0 + tlod * 0.3;
    if ( diffuseColor.a < alphaTest ) discard;
  }
#endif
`;

const ROCK_SURFACE = /* glsl */ `
#ifdef PROP_ROCK
  {
    vec3 rvn = dot(vNormal, vNormal) > 1e-8 ? vNormal : vec3(0.0, 1.0, 0.0);
    vec3 Nw = normalize(inverseTransformDirection(normalize(rvn), viewMatrix));
    float n1 = propNoise(vPropWorld * 0.21);
    float n2 = propNoise(vPropWorld * 0.93 + 7.1);
    float nn = n1 * 0.65 + n2 * 0.35;
    float strata = 0.5 + 0.5 * sin(vPropWorld.y * 1.7 + nn * 4.0);
    diffuseColor.rgb *= 1.0 + uStrata * (0.18 * strata - 0.16 + (nn - 0.5) * 0.3);
    float mossMask = smoothstep(0.42, 0.72, Nw.y + (nn - 0.5) * 0.6) * uMossAmount;
    mossMask *= smoothstep(3.0, 14.0, vPropWorld.y) * (1.0 - smoothstep(uSnowLine * 0.8, uSnowLine * 0.95, vPropWorld.y));
    vec3 moss = mix(uMossColor, uMossColor2, n2);
    diffuseColor.rgb = mix(diffuseColor.rgb, moss * (0.85 + 0.3 * n1), mossMask);
    float snow = smoothstep(0.5, 0.75, Nw.y + (nn - 0.5) * 0.4) * smoothstep(uSnowLine * 0.97, uSnowLine * 1.04, vPropWorld.y);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.96, 1.0), snow * uSnowAmount);
  }
#endif
#ifdef PROP_GRASS
  {
    float tip = sqrt(clamp(vPropWind, 0.0, 1.0));
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.12, 1.1, 0.78), tip * 0.6);
  }
#endif
`;

const FOLIAGE_LIGHT = /* glsl */ `
#include <lights_fragment_end>
#ifdef PROP_FOLIAGE
  {
    vec3 Vw = normalize(vPropWorld - cameraPosition);
    float back = pow(saturate(dot(Vw, normalize(uSunDirP))), 3.0);
    totalEmissiveRadiance += diffuseColor.rgb * uSunColorP * back * uTranslucency;
    float fres = pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 3.0);
    totalEmissiveRadiance += diffuseColor.rgb * uSkyColorP * fres * 0.28;
  }
#endif
`;

function patch(shader, mat, isDepth) {
  const U = PROP_UNIFORMS;
  Object.assign(shader.uniforms, {
    uPropTime: U.uPropTime,
    uWind: U.uWind,
    uLodCenter: U.uLodCenter,
    uStreams: U.uStreams,
    uGrassFar: U.uGrassFar,
    uThin: U.uThin,
    uWindAmp: mat.userData.uWindAmp,
    uFlutter: mat.userData.uFlutter,
    uFarHide: mat.userData.uFarHide,
  });
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
    .replace('#include <project_vertex>', PROJECT);
  if (isDepth) {
    shader.fragmentShader = shader.fragmentShader.replace('#include <alphatest_fragment>', ALPHA_TEST);
    return;
  }
  Object.assign(shader.uniforms, {
    uSunDirP: U.uSunDirP,
    uSunColorP: U.uSunColorP,
    uSkyColorP: U.uSkyColorP,
    uMossColor: U.uMossColor,
    uMossColor2: U.uMossColor2,
    uSnowLine: U.uSnowLine,
    uMossAmount: mat.userData.uMossAmount,
    uSnowAmount: mat.userData.uSnowAmount,
    uFocus: U.uFocus,
    uOccRadius: U.uOccRadius,
    uStrata: mat.userData.uStrata,
    uTranslucency: mat.userData.uTranslucency,
  });
  shader.vertexShader = shader.vertexShader
    .replace('#include <color_vertex>', COLOR_VERTEX)
    .replace(
      '#include <worldpos_vertex>',
      'vec4 worldPosition = propWorld;',
    );
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
    .replace('#include <alphatest_fragment>', ALPHA_TEST)
    .replace('#include <clipping_planes_fragment>', OCCLUDE)
    .replace('#include <color_fragment>', `#include <color_fragment>\n${ROCK_SURFACE}`)
    .replace('#include <lights_fragment_end>', FOLIAGE_LIGHT)
    .replace(
      '#include <normal_fragment_begin>',
      '#include <normal_fragment_begin>\n#ifdef PROP_NOFLIP\n  normal = normalize( vNormal );\n#endif\n  if ( !( dot( normal, normal ) > 0.5 ) ) normal = vec3( 0.0, 0.0, 1.0 );',
    );
}

/**
 * @param {object} o
 *   cards      alpha-tested atlas cards (camera facing)
 *   wind       sway amplitude in metres at scale 1 (0 = static)
 *   flutter    leaf flutter amplitude (m)
 *   far        far-LOD material (hidden inside uFarHide of uLodCenter)
 *   stream     bend away from passing stream heads
 *   foliage    translucency + rim
 *   rock       moss / strata / snow surface
 *   grass      grass blade gradient + distance shrink
 */
export function createPropMaterial(o = {}) {
  const defines = {};
  if (o.cards) defines.PROP_CARDS = '';
  if (o.wind) defines.PROP_WIND = '';
  if (o.far) defines.PROP_FAR = '';
  if (o.stream) {
    defines.PROP_STREAM = '';
    defines.PROP_STREAM_BEND = (o.streamBend ?? 2.0).toFixed(2);
  }
  if (o.foliage) defines.PROP_FOLIAGE = '';
  if (o.rock) defines.PROP_ROCK = '';
  if (o.grass) defines.PROP_GRASS = '';
  if (o.noFlip) defines.PROP_NOFLIP = '';
  if (o.occlude) defines.PROP_OCCLUDE = '';

  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: o.roughness ?? 0.9,
    metalness: 0,
    map: o.cards ? getFoliageAtlas() : null,
    alphaTest: o.cards ? 0.5 : 0,
    side: o.side ?? THREE.FrontSide,
  });
  if (o.cards) mat.shadowSide = THREE.DoubleSide;
  mat.name = o.name ?? 'prop';
  mat.defines = { ...defines };
  mat.userData.uWindAmp = { value: o.wind ?? 0 };
  mat.userData.uFlutter = { value: o.flutter ?? 0 };
  mat.userData.uFarHide = { value: o.farHide ?? 1e9 };
  mat.userData.uMossAmount = { value: o.moss ?? 1 };
  mat.userData.uSnowAmount = { value: o.snow ?? 1 };
  mat.userData.uStrata = { value: o.strata ?? 1 };
  mat.userData.uTranslucency = { value: o.translucency ?? 0.45 };
  mat.onBeforeCompile = (shader) => patch(shader, mat, false);
  mat.customProgramCacheKey = () => `prop|${Object.keys(defines).join(',')}|${defines.PROP_STREAM_BEND ?? ''}`;

  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.BasicDepthPacking });
  depth.defines = { ...defines };
  depth.userData = mat.userData;
  depth.onBeforeCompile = (shader) => patch(shader, depth, true);
  depth.customProgramCacheKey = () => `propdepth|${Object.keys(defines).join(',')}|${defines.PROP_STREAM_BEND ?? ''}`;
  mat.userData.depth = depth;
  return mat;
}

/** Create an InstancedMesh with the material's matching depth material for shadows. */
export function propMesh(geometry, material, capacity) {
  const m = new THREE.InstancedMesh(geometry, material, Math.max(1, capacity));
  m.customDepthMaterial = material.userData.depth;
  m.frustumCulled = false;
  m.count = 0;
  return m;
}
