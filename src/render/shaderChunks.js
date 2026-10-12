// Shared GLSL. Every custom ShaderMaterial in the game must:
//   1) spread `ctx.atmosphere.uniforms` into its uniforms
//   2) include ATMOSPHERE_PARS_GLSL in the fragment shader
//   3) finish with  gl_FragColor.rgb = applyAtmosphere(color, vWorldPos);
// so fog / aerial perspective / sun stay consistent across terrain, water and props.
// The render owner may change the *implementation* below, never the signatures.
//
// Built-in materials (MeshStandardMaterial & co.) get the exact same fog: Atmosphere
// patches THREE.ShaderChunk.fog_* to call atmoFogComposite() (see patchBuiltinChunks).
//
// Extra helpers available to custom shaders once ATMOSPHERE_PARS_GLSL is included
// (all optional to use):
//   vec3  atmoSky(vec3 dir)                 sky colour (no sun disk) in a world direction
//   vec3  atmoHaze(vec3 dir)                aerial-perspective / fog colour for a view direction
//   float atmoFogAmount(vec3 cam, vec3 p)   0..1 fog opacity between two world points
//   float atmoCloudShadow(vec3 worldPos)    0..1 sunlight visibility under the cloud layer
//   vec3  atmoAmbient(vec3 n)               cheap sky/ground hemisphere irradiance for normal n
//
// Everything is guarded so the block can be included several times (e.g. a ShaderMaterial
// with `fog: true` that also includes ATMOSPHERE_PARS_GLSL).

export const ATMOSPHERE_UNIFORMS_GLSL = /* glsl */ `
uniform vec3 uSunDir;        // normalized, pointing *towards* the sun
uniform vec3 uSunColor;      // linear, already multiplied by intensity / PI (≈ irradiance colour)
uniform vec3 uSkyColor;      // zenith-ish ambient (hemisphere top)
uniform vec3 uGroundColor;   // hemisphere ground bounce
uniform vec3 uFogColor;      // haze colour at the horizon (no sun glow)
uniform float uFogDensity;
uniform float uFogHeightFalloff;
uniform vec3 uCameraPos;
uniform float uTime;
uniform vec3 uZenithColor;
uniform vec3 uHorizonColor;
uniform vec3 uSunGlow;       // forward-scatter glow colour around the sun
uniform vec4 uAtmoFog;       // x: density at base height (1/m), y: height falloff (1/m), z: base height (m), w: max opacity
uniform vec4 uAtmoMisc;      // x: aerial density (1/m), y: 1 / camera.far, z: cos(sun disk radius), w: time (s)
uniform vec4 uCloudShadowParams; // x,y: map centre offset (m), z: 1 / map size (m), w: strength (0 = off)
uniform vec4 uCloudShadowParams2; // x: cloud layer height (m)
uniform sampler2D uCloudShadowMap;
`;

export const ATMOSPHERE_FUNCS_GLSL = /* glsl */ `
vec3 atmoGlow(vec3 rd) {
  float mu = max(dot(rd, uSunDir), 0.0);
  float mu2 = mu * mu;
  return uSunGlow * (0.22 * mu2 * mu + 0.55 * pow(mu, 14.0) + 1.1 * pow(mu, 90.0));
}

// Haze / aerial perspective colour seen along view direction rd.
vec3 atmoHaze(vec3 rd) {
  // looking down through the haze from altitude shows a slightly deeper tone
  float down = clamp(-rd.y * 2.5, 0.0, 1.0);
  vec3 base = mix(uFogColor, mix(uFogColor, uZenithColor, 0.22), down);
  return base + atmoGlow(rd) * (1.0 - 0.55 * down);
}

// Stylized sky gradient (no sun disk, no clouds). Matches atmoHaze() at the horizon.
vec3 atmoSky(vec3 rd) {
  float y = rd.y;
  float hy = max(y, 0.0);
  float g = pow(smoothstep(0.0, 1.0, hy), 0.5);
  vec3 grad = mix(uHorizonColor, uZenithColor, g);
  // brighter, warmer band right above the horizon
  float band = 1.0 - smoothstep(-0.03, 0.22, y);
  vec3 col = mix(grad, uFogColor, band * band);
  float down = clamp(-y * 2.5, 0.0, 1.0);
  col = mix(col, mix(uFogColor, uZenithColor, 0.22), down);
  return col + atmoGlow(rd) * (1.0 - 0.45 * hy) * (1.0 - 0.55 * down);
}

float atmoFogAmount(vec3 cam, vec3 p) {
  vec3 d = p - cam;
  float dist = length(d);
  float k = max(uAtmoFog.y, 1e-6);
  float h0 = cam.y - uAtmoFog.z;
  // optical depth of an exponential height fog along the segment (analytic integral)
  float t = k * d.y;
  float f = abs(t) > 1e-3 ? (1.0 - exp(-t)) / t : 1.0 - 0.5 * t;
  float od = uAtmoFog.x * exp(-k * h0) * dist * f;
  od += uAtmoMisc.x * dist; // altitude-independent aerial perspective
  float fog = min(1.0 - exp(-max(od, 0.0)), uAtmoFog.w);
  // fade completely into the sky right before the far plane (hides geometry clipping)
  fog = mix(fog, 1.0, smoothstep(0.8, 0.97, dist * uAtmoMisc.y));
  return fog;
}

vec3 atmoFogComposite(vec3 color, vec3 p, vec3 cam) {
  float fog = atmoFogAmount(cam, p);
  vec3 rd = normalize(p - cam);
  return mix(color, atmoHaze(rd), fog);
}

// Soft shadows of the cumulus layer projected along the sun direction.
float atmoCloudShadow(vec3 worldPos) {
  if (uCloudShadowParams.w <= 0.0) return 1.0;
  float h = uCloudShadowParams2.x - worldPos.y;
  vec2 p = worldPos.xz + uSunDir.xz / max(uSunDir.y, 0.12) * max(h, 0.0);
  vec2 uv = (p - uCloudShadowParams.xy) * uCloudShadowParams.z + 0.5; // repeat-wrapped map
  float c = texture2D(uCloudShadowMap, uv).r;
  return 1.0 - c * uCloudShadowParams.w * step(0.0, h);
}

vec3 atmoAmbient(vec3 n) {
  return mix(uGroundColor, uSkyColor, n.y * 0.5 + 0.5);
}

vec3 applyAtmosphere(vec3 color, vec3 worldPos) {
  return atmoFogComposite(color, worldPos, uCameraPos);
}
`;

export const ATMOSPHERE_PARS_GLSL = /* glsl */ `
#ifndef RIO_ATMOSPHERE
#define RIO_ATMOSPHERE
${ATMOSPHERE_UNIFORMS_GLSL}
${ATMOSPHERE_FUNCS_GLSL}
#endif
`;

// Small, fast value-noise helpers shared by sky / clouds / post.
export const NOISE_GLSL = /* glsl */ `
#ifndef RIO_NOISE
#define RIO_NOISE
float rioHash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float rioHash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
float rioNoise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = rioHash12(i);
  float b = rioHash12(i + vec2(1.0, 0.0));
  float c = rioHash12(i + vec2(0.0, 1.0));
  float d = rioHash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float rioFbm2(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    s += a * rioNoise2(p);
    p = mat2(1.6, 1.2, -1.2, 1.6) * p;
    a *= 0.5;
  }
  return s;
}
#endif
`;

// ---------------------------------------------------------------------------
// Built-in chunk patches (MeshStandardMaterial & co.)
// ---------------------------------------------------------------------------

export const FOG_PARS_VERTEX = /* glsl */ `
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogWorldPos;
#endif
`;

export const FOG_VERTEX = /* glsl */ `
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  // view → world without needing modelMatrix (works for instancing / batching / skinning)
  vFogWorldPos = ( ( vec4( mvPosition.xyz, 1.0 ) - viewMatrix[ 3 ] ) * viewMatrix ).xyz;
#endif
`;

export const FOG_PARS_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying vec3 vFogWorldPos;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
  ${ATMOSPHERE_PARS_GLSL}
#endif
`;

export const FOG_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
  if ( uAtmoFog.w > 0.0 ) {
    gl_FragColor.rgb = atmoFogComposite( gl_FragColor.rgb, vFogWorldPos, cameraPosition );
  } else {
    // material without the shared atmosphere uniforms: classic three.js fog
    #ifdef FOG_EXP2
      float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
    #else
      float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
    #endif
    gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
  }
#endif
`;

// Injected into lights_fragment_begin right after the sun's incident light is fetched:
// cloud shadows darken the direct sunlight on every lit built-in material.
export const SUN_CLOUD_SHADOW_GLSL = /* glsl */ `
		#ifdef USE_FOG
		directLight.color *= atmoCloudShadow( ( ( vec4( geometryPosition, 1.0 ) - viewMatrix[ 3 ] ) * viewMatrix ).xyz );
		#endif
`;
