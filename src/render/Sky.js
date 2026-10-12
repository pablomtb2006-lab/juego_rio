import * as THREE from 'three';
import { ATMOSPHERE_PARS_GLSL, NOISE_GLSL } from './shaderChunks.js';

// Fullscreen triangle on the far plane; the view ray is rebuilt from the inverse
// projection (no box geometry → nothing to clip, works for the PMREM cube faces too).
const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vec4 ray = inverse(projectionMatrix) * vec4(position.xy, 1.0, 1.0);
  vDir = transpose(mat3(viewMatrix)) * (ray.xyz / ray.w);
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

function fullscreenTriangle() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  return g;
}

const FRAG = /* glsl */ `
${ATMOSPHERE_PARS_GLSL}
${NOISE_GLSL}
uniform float uNight;      // 0 day .. 1 night (stars)
uniform vec3 uCirrusColor;
varying vec3 vDir;

void main() {
  vec3 rd = normalize(vDir);
  vec3 col = atmoSky(rd);
  float mu = dot(rd, uSunDir);

#ifndef ENV_MODE
  // sun disk with a little limb darkening; HDR so bloom picks it up
  float cosR = uAtmoMisc.z;
  float disk = smoothstep(cosR - (1.0 - cosR) * 0.35, cosR + (1.0 - cosR) * 0.25, mu);
  float limb = 0.75 + 0.25 * smoothstep(cosR, 1.0, mu);
  float horizonFade = smoothstep(-0.03, 0.02, rd.y);
  col += uSunColor * disk * limb * 22.0 * horizonFade;
#endif

  // high, thin cirrus streaks — subtle painterly texture in the upper sky
  if (rd.y > 0.02) {
    vec2 uv = rd.xz / (rd.y + 0.22);
    float t = uAtmoMisc.w * 0.004;
    vec2 q = mat2(0.86, 0.5, -0.5, 0.86) * uv * vec2(1.1, 3.2) + vec2(t, 0.0);
    float c = rioFbm2(q * 1.3 + rioFbm2(uv * 0.7) * 1.4);
    c = smoothstep(0.52, 0.86, c);
    float fade = smoothstep(0.02, 0.18, rd.y) * (1.0 - smoothstep(0.55, 0.95, rd.y));
    vec3 cc = uCirrusColor + atmoGlow(rd) * 0.6;
    col = mix(col, cc, c * fade * 0.32);
  }

#ifndef ENV_MODE
  // stars at night
  if (uNight > 0.01 && rd.y > 0.0) {
    vec3 sp = rd * 420.0;
    vec3 cell = floor(sp);
    float h = rioHash13(cell);
    vec3 local = fract(sp) - 0.5;
    float s = smoothstep(0.08, 0.0, length(local)) * step(0.985, h);
    col += vec3(0.9, 0.95, 1.0) * s * uNight * 3.0 * smoothstep(0.0, 0.25, rd.y);
  }
#endif

#ifdef ENV_MODE
  // the ground half of the environment: warm-green bounce instead of more sky
  float g = smoothstep(0.02, -0.12, rd.y);
  col = mix(col, uGroundColor * 0.55, g);
#endif

  gl_FragColor = vec4(col, 1.0);
}
`;

/**
 * Stylized sky dome (gradient + sun disk + glow + cirrus + stars), drawn on the far
 * plane so it never clips. `createEnvSky()` returns the same sky without the sun disk
 * and with a ground hemisphere, used to bake the PMREM environment map.
 */
export function createSky(uniforms) {
  const material = new THREE.ShaderMaterial({
    name: 'RioSky',
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    depthWrite: false,
    depthTest: true,
    fog: false,
  });
  const mesh = new THREE.Mesh(fullscreenTriangle(), material);
  mesh.name = 'Sky';
  mesh.frustumCulled = false;
  mesh.renderOrder = 1e6; // last among opaques: only fills pixels nothing else covered
  mesh.userData.treatAsOpaque = true;
  return mesh;
}

export function createEnvSky(uniforms) {
  const material = new THREE.ShaderMaterial({
    name: 'RioEnvSky',
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    depthWrite: false,
    depthTest: false,
    fog: false,
    defines: { ENV_MODE: 1 },
  });
  const mesh = new THREE.Mesh(fullscreenTriangle(), material);
  mesh.frustumCulled = false;
  return mesh;
}
