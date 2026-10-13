import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

/**
 * WaterRendering — the optics of the water, applied to the reconstructed surface.
 *
 * Per pixel covered by water (FreeSurfaceReconstruction gives depth + thickness):
 *   - normal          from the smoothed depth, edge-aware finite differences
 *   - reflection      Fresnel (Schlick, F0 = 0.02 ⇔ n = 1.33) × sky radiance + sun glint
 *   - refraction      the bed seen through the surface, displaced along the normal, more where
 *                     the water is thicker (screen-space: it can only show what is on screen)
 *   - absorption      Beer–Lambert per colour channel: T = exp(−(σa + σs)·thickness − τ_dye)
 *                     τ_dye = Σ σ_dye·chord: the optical depth of each river's colour along the
 *                     ray (FreeSurfaceReconstruction); 0 when there are no rivers
 *   - body colour     single scattering by suspended matter: albedo σs/(σa+σs) per channel,
 *                     times the ambient light, times (1 − exp(−(σa+σs)·thickness))
 * So the colour of the water COMES FROM absorption and turbidity over the real thickness of water
 * the ray crosses, not from a colour picked per distance. Shallow water shows the bed; deep water
 * keeps only what it does not absorb and what it scatters back.
 *
 * Every optical parameter is independent and exposed in `params` (brief §2.2).
 */
export const SKY_GLSL = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyGround;
vec3 skyRadiance(vec3 d) {
  float t = d.y;
  vec3 sky = mix(uSkyHorizon, uSkyTop, pow(clamp(t, 0.0, 1.0), 0.5));
  sky = mix(sky, uSkyGround, smoothstep(0.0, -0.2, t));
  float s = max(dot(d, uSunDir), 0.0);
  return sky + uSunColor * (pow(s, 1200.0) * 60.0 + pow(s, 16.0) * 0.18);
}`;

/** Optical presets. `real` uses measured absorption of pure water (Pope & Fry 1997). */
export const WATER_PRESETS = {
  // stylised like the reference video: saturated blue body, bed visible only where shallow
  video: { absorb: [3.6, 1.6, 0.35], turbidity: 0.9, scatterTint: [0.3, 0.55, 1.0], reflect: 1.0, refract: 1.0, bottom: 1.0, intensity: 0.8 },
  // a clear mountain stream: little scattering, green-cyan absorption
  stream: { absorb: [0.9, 0.22, 0.12], turbidity: 0.25, scatterTint: [0.55, 0.85, 0.8], reflect: 1.0, refract: 1.2, bottom: 1.0, intensity: 1.0 },
  // pure water, measured σa at 650/550/450 nm (≈ 0.34, 0.057, 0.009 1/m): almost colourless at 1 m
  real: { absorb: [0.34, 0.057, 0.0092], turbidity: 0.02, scatterTint: [1, 1, 1], reflect: 1.0, refract: 1.0, bottom: 1.0, intensity: 1.0 },
  // a river carrying silt
  silty: { absorb: [1.2, 1.4, 1.9], turbidity: 2.4, scatterTint: [0.85, 0.72, 0.5], reflect: 0.9, refract: 0.7, bottom: 0.8, intensity: 1.0 },
  // rival rivers: the colour comes from each river's dye absorbance (RiverEntity), so the base
  // water is nearly clear and the scattering is neutral (white) — it lights whatever the dye leaves
  rivales: { absorb: [0.34, 0.057, 0.0092], turbidity: 0.7, scatterTint: [1, 1, 1], reflect: 1.0, refract: 1.0, bottom: 1.0, intensity: 1.45 },
};

const VS = /* glsl */ `
precision highp float;
in vec3 position;
in vec2 uv;
out vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const FS = /* glsl */ `
precision highp float;
${SKY_GLSL}
uniform sampler2D uScene;
uniform sampler2D uSceneDepth;
uniform sampler2D uDepth;
uniform sampler2D uThick;
uniform mat4 uProjInv;
uniform mat4 uViewInv;
uniform vec2 uRes;
uniform float uNear;
uniform float uFar;
uniform vec3 uAbsorb;
uniform float uTurbidity;
uniform vec3 uScatterTint;
uniform float uReflect;
uniform float uRefract;
uniform float uBottom;
uniform float uIntensity;
uniform float uExposure;
uniform int uView;
in vec2 vUv;
out vec4 fragColor;

vec3 viewPos(vec2 uv, float z) {
  vec4 v = uProjInv * vec4(uv * 2.0 - 1.0, -1.0, 1.0);
  vec3 dir = v.xyz / v.w;
  return dir * (z / -dir.z);
}
float sceneViewDepth(vec2 uv) {
  float d = texture(uSceneDepth, uv).r * 2.0 - 1.0;
  return 2.0 * uNear * uFar / (uFar + uNear - d * (uFar - uNear));
}
vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
vec3 toSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec3 scene = texture(uScene, vUv).rgb;
  float z = texture(uDepth, vUv).r;
  vec3 col = scene;
  if (z > 0.0) {
    vec2 px = 1.0 / uRes;
    vec3 P = viewPos(vUv, z);
    float zr = texture(uDepth, vUv + vec2(px.x, 0.0)).r;
    float zl = texture(uDepth, vUv - vec2(px.x, 0.0)).r;
    float zu = texture(uDepth, vUv + vec2(0.0, px.y)).r;
    float zd = texture(uDepth, vUv - vec2(0.0, px.y)).r;
    vec3 dx = zr > 0.0 ? viewPos(vUv + vec2(px.x, 0.0), zr) - P : vec3(0.0, 0.0, 1e9);
    vec3 dx2 = zl > 0.0 ? P - viewPos(vUv - vec2(px.x, 0.0), zl) : vec3(0.0, 0.0, 1e9);
    if (abs(dx2.z) < abs(dx.z)) dx = dx2;
    vec3 dy = zu > 0.0 ? viewPos(vUv + vec2(0.0, px.y), zu) - P : vec3(0.0, 0.0, 1e9);
    vec3 dy2 = zd > 0.0 ? P - viewPos(vUv - vec2(0.0, px.y), zd) : vec3(0.0, 0.0, 1e9);
    if (abs(dy2.z) < abs(dy.z)) dy = dy2;
    vec3 n = (abs(dx.z) > 1e8 || abs(dy.z) > 1e8) ? vec3(0.0, 0.0, 1.0) : normalize(cross(dx, dy));
    vec3 V = normalize(-P);
    if (dot(n, V) < 0.0) n = -n;
    vec3 nW = normalize(mat3(uViewInv) * n);
    vec3 VW = normalize(mat3(uViewInv) * V);
    vec4 TH = texture(uThick, vUv);
    float thick = max(TH.a, 0.0);
    vec3 dyeOD = max(TH.rgb, vec3(0.0));               // Σ σ_dye · chord (dimensionless)
    vec3 dyeSigma = dyeOD / max(thick, 1e-3);          // mean dye absorbance along the ray (1/m)

    // refraction: displace the lookup of the bed along the surface normal, more through thicker water
    vec2 ruv = clamp(vUv - n.xy * uRefract * min(thick, 1.5) * 0.06, vec2(0.0), vec2(1.0));
    if (sceneViewDepth(ruv) < z) ruv = vUv; // that sample is an object in FRONT of the water
    vec3 bed = texture(uScene, ruv).rgb;

    // absorption + single scattering over the thickness actually crossed
    vec3 sigma = uAbsorb + dyeSigma + vec3(uTurbidity);
    vec3 T = exp(-(uAbsorb + vec3(uTurbidity)) * thick - dyeOD);
    vec3 albedo = uTurbidity / max(sigma, vec3(1e-4)) * uScatterTint;
    vec3 ambient = skyRadiance(vec3(0.0, 1.0, 0.0)) * 0.55 + uSunColor * max(uSunDir.y, 0.0) * 0.32;
    vec3 body = albedo * ambient * (1.0 - T) * uIntensity;
    vec3 water = bed * T * uBottom + body;

    // reflection: Fresnel × environment, plus the sun's glint
    float cosT = clamp(dot(nW, VW), 0.0, 1.0);
    float F = (0.02 + 0.98 * pow(1.0 - cosT, 5.0)) * uReflect;
    vec3 R = reflect(-VW, nW);
    vec3 refl = skyRadiance(R);
    vec3 H = normalize(uSunDir + VW);
    float glint = pow(max(dot(nW, H), 0.0), 900.0) * 12.0;
    col = mix(water, refl, F) + uSunColor * glint * uReflect;

    // the thinnest film melts into the ground instead of ending in a hard line
    col = mix(scene, col, smoothstep(0.0, 0.025, thick));

    if (uView == 1) col = nW * 0.5 + 0.5;
    if (uView == 2) col = vec3(thick * 0.5);
  }
  fragColor = vec4(toSRGB(aces(col * uExposure)), 1.0);
}`;

export class WaterRendering {
  constructor(renderer, sky) {
    this.renderer = renderer;
    this.params = { ...WATER_PRESETS.video, exposure: 1.0, view: 0 };
    this.quad = new FullScreenQuad(
      new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        uniforms: {
          ...sky.uniforms,
          uScene: { value: null },
          uSceneDepth: { value: null },
          uDepth: { value: null },
          uThick: { value: null },
          uProjInv: { value: new THREE.Matrix4() },
          uViewInv: { value: new THREE.Matrix4() },
          uRes: { value: new THREE.Vector2() },
          uNear: { value: 0.1 },
          uFar: { value: 1000 },
          uAbsorb: { value: new THREE.Vector3() },
          uTurbidity: { value: 1 },
          uScatterTint: { value: new THREE.Vector3() },
          uReflect: { value: 1 },
          uRefract: { value: 1 },
          uBottom: { value: 1 },
          uIntensity: { value: 1 },
          uExposure: { value: 1 },
          uView: { value: 0 },
        },
        vertexShader: VS,
        fragmentShader: FS,
        depthTest: false,
        depthWrite: false,
      }),
    );
  }

  setPreset(name) {
    Object.assign(this.params, WATER_PRESETS[name]);
  }

  /** Composite water over the scene into the current render target (null = screen). */
  render(camera, sceneColor, sceneDepth, surface, w, h) {
    const u = this.quad.material.uniforms;
    const p = this.params;
    u.uScene.value = sceneColor;
    u.uSceneDepth.value = sceneDepth;
    u.uDepth.value = surface.depth;
    u.uThick.value = surface.thickness;
    u.uProjInv.value.copy(camera.projectionMatrixInverse);
    u.uViewInv.value.copy(camera.matrixWorld);
    u.uRes.value.set(w, h);
    u.uNear.value = camera.near;
    u.uFar.value = camera.far;
    u.uAbsorb.value.fromArray(p.absorb);
    u.uTurbidity.value = p.turbidity;
    u.uScatterTint.value.fromArray(p.scatterTint);
    u.uReflect.value = p.reflect;
    u.uRefract.value = p.refract;
    u.uBottom.value = p.bottom;
    u.uIntensity.value = p.intensity;
    u.uExposure.value = p.exposure;
    u.uView.value = p.view;
    this.quad.render(this.renderer);
  }
}
