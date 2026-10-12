import * as THREE from 'three';
import { mulberry32 } from '../../core/random.js';
import { ATMOSPHERE_PARS_GLSL } from '../../render/shaderChunks.js';

/**
 * Flocks of birds circling over the coast, the valleys and the summit arch.
 * One instanced draw call, fully animated on the GPU (path, banking, flapping
 * with glide phases) — zero CPU cost per frame besides one uniform.
 * Follows the atmosphere contract (ATMOSPHERE_PARS_GLSL + applyAtmosphere).
 */

function birdGeometry() {
  // local frame: x = right, y = up, z = forward. Wingspan ≈ 2 (scaled per instance).
  const P = [];
  const W = []; // wing side (-1, 0, 1)
  const T = []; // 0 shoulder .. 1 tip
  const C = []; // vertex colour
  const white = [0.96, 0.96, 0.94];
  const grey = [0.62, 0.66, 0.7];
  const dark = [0.2, 0.21, 0.24];
  const beak = [0.95, 0.66, 0.2];
  const tri = (a, b, c) => {
    for (const v of [a, b, c]) {
      P.push(v.p[0], v.p[1], v.p[2]);
      W.push(v.w);
      T.push(v.t);
      C.push(...v.c);
    }
  };
  const v = (p, w, t, c) => ({ p, w, t, c });
  // body: small diamond prism
  const nose = v([0, 0, 0.55], 0, 0, white);
  const tail = v([0, 0.02, -0.6], 0, 0, white);
  const top = v([0, 0.09, 0.05], 0, 0, white);
  const bot = v([0, -0.08, 0.05], 0, 0, grey);
  const l = v([-0.09, 0, 0.05], 0, 0, white);
  const r = v([0.09, 0, 0.05], 0, 0, white);
  tri(nose, top, l); tri(nose, r, top); tri(nose, l, bot); tri(nose, bot, r);
  tri(tail, l, top); tri(tail, top, r); tri(tail, bot, l); tri(tail, r, bot);
  tri(v([0, 0, 0.7], 0, 0, beak), v([0.02, 0, 0.52], 0, 0, beak), v([-0.02, 0, 0.52], 0, 0, beak));
  // tail fan
  tri(v([0, 0.01, -0.45], 0, 0, white), v([-0.14, 0.01, -0.78], 0, 0, grey), v([0.14, 0.01, -0.78], 0, 0, grey));
  // wings: inner + outer panel each side (swept back gull wing)
  for (const s of [-1, 1]) {
    const sh0 = v([0.06 * s, 0.02, 0.18], s, 0, grey);
    const sh1 = v([0.06 * s, 0.02, -0.12], s, 0, grey);
    const el0 = v([0.55 * s, 0.03, 0.12], s, 0.5, grey);
    const el1 = v([0.55 * s, 0.03, -0.12], s, 0.5, grey);
    const tip = v([1.05 * s, 0.0, -0.22], s, 1, dark);
    const tip2 = v([0.9 * s, 0.0, -0.05], s, 0.85, dark);
    tri(sh0, el0, sh1);
    tri(sh1, el0, el1);
    tri(el0, tip2, el1);
    tri(el1, tip2, tip);
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('aWing', new THREE.Float32BufferAttribute(W, 1));
  g.setAttribute('aTip', new THREE.Float32BufferAttribute(T, 1));
  g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  return g;
}

const VERT = /* glsl */ `
attribute float aWing;
attribute float aTip;
attribute vec3 color;
attribute vec4 iFlock;  // centre xyz, radius
attribute vec4 iParam;  // angular speed (signed), phase, vertical bob, size
attribute vec3 iColor;
uniform float uTime;
varying vec3 vWorldPos;
varying vec3 vCol;
varying vec3 vN;
void main() {
  float a = iParam.y + uTime * iParam.x;
  float R = iFlock.w * (0.82 + 0.18 * sin(uTime * 0.11 + iParam.y * 3.1));
  vec3 c = iFlock.xyz;
  vec3 p = c + vec3(cos(a) * R, sin(a * 2.0 + iParam.y) * iParam.z, sin(a) * R * 0.8);
  vec3 dp = vec3(-sin(a) * R, cos(a * 2.0 + iParam.y) * 2.0 * iParam.z, cos(a) * R * 0.8) * sign(iParam.x);
  vec3 fwd = normalize(dp);
  vec3 right = normalize(cross(fwd, vec3(0.0, 1.0, 0.0)));
  vec3 up = cross(right, fwd);
  // bank into the turn
  float bank = -0.45 * sign(iParam.x);
  vec3 r2 = right * cos(bank) + up * sin(bank);
  vec3 u2 = up * cos(bank) - right * sin(bank);
  // flap with glide phases
  float glide = smoothstep(-0.3, 0.5, sin(uTime * 0.6 + iParam.y * 2.3));
  float flap = sin(uTime * 9.0 + iParam.y * 11.0) * glide;
  float ang = (0.12 + flap * 0.75) * (aTip > 0.6 ? 1.35 : 1.0);
  vec3 lp = position;
  vec3 n = vec3(0.0, 1.0, 0.0);
  if (aWing != 0.0) {
    float x = abs(lp.x);
    lp.x = sign(lp.x) * x * cos(ang);
    lp.y += x * sin(ang);
    n = normalize(vec3(-sign(lp.x) * sin(ang), cos(ang), 0.0));
  }
  float s = iParam.w;
  vec3 wp = p + (r2 * lp.x + u2 * lp.y + fwd * lp.z) * s;
  vN = normalize(r2 * n.x + u2 * n.y);
  vCol = color * iColor;
  vWorldPos = wp;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const FRAG = /* glsl */ `
${ATMOSPHERE_PARS_GLSL}
varying vec3 vWorldPos;
varying vec3 vCol;
varying vec3 vN;
void main() {
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  float d = max(dot(n, uSunDir), 0.0);
  vec3 col = vCol * (uSkyColor * 0.55 + uSunColor * d * 1.1 + 0.15);
  gl_FragColor = vec4(applyAtmosphere(col, vWorldPos), 1.0);
  #include <colorspace_fragment>
}
`;

export class Birds {
  constructor(ctx) {
    this.ctx = ctx;
    this.flocks = [];
  }

  /** flocks: [{ x, y, z, radius, count, kind: 'gull'|'dark', size }] */
  build(flocks, seed = 1) {
    const rand = mulberry32(seed);
    const n = flocks.reduce((a, f) => a + f.count, 0);
    const g = birdGeometry();
    const F = new Float32Array(n * 4);
    const Pm = new Float32Array(n * 4);
    const Cl = new Float32Array(n * 3);
    let i = 0;
    for (const f of flocks) {
      const dir = rand() < 0.5 ? -1 : 1;
      const base = rand() * 6.28;
      const speed = (f.speed ?? 14) / f.radius;
      for (let k = 0; k < f.count; k++, i++) {
        // birds of a flock share the loop but spread along it and in altitude/radius
        F.set([f.x + (rand() - 0.5) * f.radius * 0.25, f.y + (rand() - 0.5) * f.radius * 0.18, f.z + (rand() - 0.5) * f.radius * 0.25, f.radius * (0.75 + rand() * 0.4)], i * 4);
        Pm.set([dir * speed * (0.9 + rand() * 0.2), base + (k / f.count) * 1.6 + rand() * 0.3, 4 + rand() * 10, (f.size ?? 2.4) * (0.85 + rand() * 0.3)], i * 4);
        const c = f.kind === 'dark' ? [0.32, 0.3, 0.32] : [1, 1, 1];
        Cl.set(c, i * 3);
      }
    }
    g.setAttribute('iFlock', new THREE.InstancedBufferAttribute(F, 4));
    g.setAttribute('iParam', new THREE.InstancedBufferAttribute(Pm, 4));
    g.setAttribute('iColor', new THREE.InstancedBufferAttribute(Cl, 3));
    g.instanceCount = n;
    const u = this.ctx.atmosphere?.uniforms ?? {};
    this.uniforms = {
      ...u,
      uTime: { value: 0 },
    };
    // atmosphere uniforms the shader needs, with fallbacks if render renamed them
    const need = {
      uSunDir: new THREE.Vector3(0.45, 0.55, 0.35).normalize(),
      uSunColor: new THREE.Color(1, 0.92, 0.8),
      uSkyColor: new THREE.Color(0.45, 0.65, 1),
      uGroundColor: new THREE.Color(0.35, 0.3, 0.22),
      uFogColor: new THREE.Color(0.62, 0.76, 0.92),
      uFogDensity: 0.00012,
      uFogHeightFalloff: 0.0012,
      uCameraPos: new THREE.Vector3(),
    };
    for (const [k, v] of Object.entries(need)) if (!this.uniforms[k]) this.uniforms[k] = { value: v };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'birds';
    this.count = n;
    this.ctx.scene.add(this.mesh);
    return this.mesh;
  }

  update(dt, time) {
    if (this.uniforms) this.uniforms.uTime.value = time;
  }
}
