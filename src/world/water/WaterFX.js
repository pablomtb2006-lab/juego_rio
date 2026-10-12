import * as THREE from 'three';
import { ATMOSPHERE_PARS_GLSL } from '../../render/shaderChunks.js';
import { mulberry32 } from '../../core/random.js';
import { NOISE_GLSL, AA_GLSL, TERRAIN_GLSL, terrainUniforms, waterTime } from './waterCommon.js';

/**
 * Pooled water VFX shared by every stream/lake:
 *   - one instanced particle system (GPU-analytic ballistic motion with drag, so the CPU only
 *     writes a particle once when it is born; ring buffer, budget = quality.particles)
 *   - a pool of terrain-conforming decals (impact ring waves, foam patches, cut slashes, drains)
 *
 * Particle types: DROP (round droplet), FOAM (lumpy white puff), MIST (soft haze),
 * STAR (additive 4-point glint), EMBER (additive glow dot), STREAK (thin speed line).
 */
export const P = { DROP: 0, FOAM: 1, MIST: 2, STAR: 3, EMBER: 4, STREAK: 5 };
export const D = { SPLASH: 0, CUT: 1, PULSE: 2, COLLAPSE: 3 };

const PVERT = /* glsl */ `
attribute vec4 iPos;   // xyz, birth time
attribute vec4 iVel;   // xyz, life
attribute vec4 iSize;  // size0, size1, gravity scale, drag
attribute vec4 iMisc;  // type, stretch (s), seed, additive
attribute vec4 iColor; // linear rgb, opacity
uniform float uWTime;
varying vec2 vUv;
varying vec4 vColor;
varying vec3 vWorldPos;
varying float vType;
varying float vSeed;
varying float vAdd;
varying float vFade;

void main() {
  float age = uWTime - iPos.w;
  float life = iVel.w;
  if (age < 0.0 || age > life) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float k = iSize.w;
  vec3 g = vec3(0.0, -9.81 * iSize.z, 0.0);
  vec3 p;
  vec3 v;
  if (k < 0.001) {
    p = iPos.xyz + iVel.xyz * age + 0.5 * g * age * age;
    v = iVel.xyz + g * age;
  } else {
    float e = exp(-k * age);
    p = iPos.xyz + iVel.xyz * (1.0 - e) / k + g * (age / k - (1.0 - e) / (k * k));
    v = iVel.xyz * e + g * (1.0 - e) / k;
  }
  float x = age / life;
  float size = mix(iSize.x, iSize.y, x);
  vec4 mv = viewMatrix * vec4(p, 1.0);
  // never let a sprite sweep through the lens (degenerate w, giant overdraw)
  float dc = -mv.z;
  if (dc < 1.5 + size) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec3 vv = (viewMatrix * vec4(v, 0.0)).xyz;
  vec2 dir = vv.xy;
  float sp = length(dir);
  vec2 ax = sp > 1e-3 ? dir / sp : vec2(0.0, 1.0);
  vec2 px = vec2(-ax.y, ax.x);
  float len = size + sp * iMisc.y;
  vec2 c = position.xy;
  mv.xy += ax * c.y * len * 0.5 + px * c.x * size * 0.5;
  float d = length(mv.xyz);
  mv.xyz *= 1.0 - min(size * 0.6 / max(d, 1e-3), 0.3);
  gl_Position = projectionMatrix * mv;
  vUv = c;
  vColor = iColor;
  vWorldPos = p;
  vType = iMisc.x;
  vSeed = iMisc.z;
  vAdd = iMisc.w;
  vFade = smoothstep(0.0, 0.06, x) * (1.0 - smoothstep(0.55, 1.0, x)) * smoothstep(1.5 + size, 4.0 + size * (iMisc.x > 1.5 && iMisc.x < 2.5 ? 4.0 : 2.0), dc);
  if (any(isnan(gl_Position)) || any(isinf(gl_Position))) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;

const PFRAG = /* glsl */ `
${ATMOSPHERE_PARS_GLSL}
${NOISE_GLSL}
varying vec2 vUv;
varying vec4 vColor;
varying vec3 vWorldPos;
varying float vType;
varying float vSeed;
varying float vAdd;
varying float vFade;

void main() {
  vec2 uv = vUv;
  float r = length(uv);
  int type = int(vType + 0.5);
  vec3 col = vColor.rgb;
  float a = 0.0;
  vec3 light = uSkyColor * 0.45 + uSunColor * 0.8;
  if (type == 0) {
    a = 1.0 - smoothstep(0.7, 1.0, r);
    float hl = 1.0 - smoothstep(0.0, 0.45, length(uv - vec2(-0.25, 0.3)));
    col = col * light * (0.8 + 0.4 * (1.0 - r)) + uSunColor * hl * 0.9;
  } else if (type == 1) {
    float n = vnoise(uv * 2.2 + vSeed * 37.0) - 0.5;
    float n2 = vnoise(uv * 5.0 - vSeed * 11.0) - 0.5;
    float rr = r + n * 0.55 + n2 * 0.18;
    a = 1.0 - smoothstep(0.62, 0.78, rr);
    float shade = 0.82 + 0.25 * clamp(uv.y * 0.6 + 0.4 - n, 0.0, 1.0);
    col = col * light * shade;
  } else if (type == 2) {
    float n = vnoise(uv * 1.7 + vSeed * 19.0);
    a = exp(-r * r * 2.6) * (0.55 + 0.45 * n);
    col = col * light;
  } else if (type == 3) {
    float cross = max(1.0 - abs(uv.x) * 9.0, 0.0) * max(1.0 - abs(uv.y), 0.0) + max(1.0 - abs(uv.y) * 9.0, 0.0) * max(1.0 - abs(uv.x), 0.0);
    a = clamp(cross + exp(-r * r * 18.0), 0.0, 1.0);
    col *= 2.5;
  } else if (type == 4) {
    a = exp(-r * r * 5.0);
    col *= 2.0 + exp(-r * r * 30.0) * 2.0;
  } else {
    a = (1.0 - smoothstep(0.3, 1.0, abs(uv.x))) * (1.0 - smoothstep(0.6, 1.0, abs(uv.y)));
    col = col * light;
  }
  a *= vColor.a * vFade;
  if (!(a >= 0.003)) discard;
  a = min(a, 1.0);
  vec3 outc = applyAtmosphere(col, vWorldPos);
  gl_FragColor = vec4(outc * a, vAdd > 0.5 ? 0.0 : a);
}
`;

const DVERT = /* glsl */ `
${TERRAIN_GLSL}
uniform vec4 uDecal; // x, z, size, t0
varying vec3 vWorldPos;
varying vec2 vLocal;
void main() {
  vec2 local = position.xz;
  vec2 xz = uDecal.xy + local * uDecal.z;
  float h = max(terrainHeight(xz), uTerrainInfo.z) + 0.25;
  vec4 wp = vec4(xz.x, h, xz.y, 1.0);
  vWorldPos = wp.xyz;
  vLocal = local;
  vec4 mv = viewMatrix * wp;
  float d = length(mv.xyz);
  mv.xyz *= 1.0 - min((0.6 + d * 0.003) / d, 0.5);
  gl_Position = projectionMatrix * mv;
}
`;

const DFRAG = /* glsl */ `
${ATMOSPHERE_PARS_GLSL}
${NOISE_GLSL}
uniform vec4 uDecal;
uniform vec4 uParams; // type, duration, strength, seed
uniform vec3 uColor;
uniform float uWTime;
varying vec3 vWorldPos;
varying vec2 vLocal;

void main() {
  float age = uWTime - uDecal.w;
  float x = clamp(age / uParams.y, 0.0, 1.0);
  float r = length(vLocal);
  float ang = atan(vLocal.y, vLocal.x);
  int type = int(uParams.x + 0.5);
  float seed = uParams.w;
  float n = vnoise(vLocal * 7.0 + seed);
  float n2 = vnoise(vec2(ang * 4.0, r * 6.0) + seed * 3.0);
  vec3 foamCol = vec3(1.22, 1.3, 1.36);
  vec3 col = foamCol;
  float a = 0.0;
  if (type == 0) {
    // impact: racing ring wave + dissolving foam patch + dark wet stain
    float R = 0.3 + 0.68 * (1.0 - exp(-age * 2.4));
    float w = 0.07 * (1.0 - x * 0.5) + 0.02;
    float ring = 1.0 - smoothstep(w * 0.5, w, abs(r - R + (n2 - 0.5) * 0.04));
    float ring2 = 1.0 - smoothstep(w * 0.25, w * 0.6, abs(r - R * 0.72 + (n - 0.5) * 0.05));
    ring = max(ring, ring2 * 0.8 * smoothstep(0.1, 0.3, age));
    float fpatch = step(r, R * 0.92) * step(0.45 + x * 0.55, n * 0.7 + n2 * 0.3 + (1.0 - r) * 0.35);
    float wet = (1.0 - smoothstep(R * 0.7, R * 1.05, r)) * (1.0 - x);
    float fade = 1.0 - smoothstep(0.35, 1.0, x);
    float foam = max(ring * fade, fpatch * (1.0 - smoothstep(0.2, 0.9, x)));
    col = mix(vec3(0.03, 0.05, 0.05), foamCol, foam > 0.01 ? 1.0 : 0.0);
    a = max(foam, wet * 0.35);
  } else if (type == 1) {
    // cut: double shock ring in the victim colour + white slash burst
    float R = 0.2 + 0.8 * (1.0 - exp(-age * 3.0));
    float ring = 1.0 - smoothstep(0.02, 0.06, abs(r - R + (n2 - 0.5) * 0.05));
    float ring2 = 1.0 - smoothstep(0.015, 0.045, abs(r - R * 0.6));
    float rays = smoothstep(0.7, 0.95, vnoise(vec2(ang * 6.0, seed))) * step(r, R) * (1.0 - smoothstep(0.0, 0.5, x));
    float fade = 1.0 - smoothstep(0.3, 1.0, x);
    col = mix(uColor * 1.6, foamCol, ring);
    a = max(max(ring, ring2 * 0.8), rays * 0.7) * fade;
  } else if (type == 2) {
    // swallow pulse: rings sucked inwards
    float ph = fract(r * 2.5 + age * 2.2);
    float ring = smoothstep(0.75, 0.9, ph) * (1.0 - smoothstep(0.9, 1.0, ph));
    a = ring * (1.0 - smoothstep(0.6, 1.0, r)) * smoothstep(0.08, 0.25, r) * (1.0 - x) * 0.85;
    col = mix(foamCol, uColor * 1.3, 0.3);
  } else {
    // collapse: water draining away into the ground, inward ring + dark stain drying
    float R = 1.0 - 0.85 * (1.0 - exp(-age * 1.2));
    float ring = 1.0 - smoothstep(0.02, 0.06, abs(r - R + (n2 - 0.5) * 0.06));
    float stain = (1.0 - smoothstep(0.7, 1.0, r + (n - 0.5) * 0.2)) * (1.0 - x);
    float foam = ring * (1.0 - smoothstep(0.4, 0.8, x));
    col = mix(vec3(0.04, 0.05, 0.05), mix(foamCol, uColor * 1.2, 0.35), foam);
    a = max(foam, stain * 0.45);
  }
  a *= uParams.z * (1.0 - smoothstep(0.92, 1.0, r));
  if (a < 0.004) discard;
  gl_FragColor = vec4(applyAtmosphere(col, vWorldPos), a);
}
`;

export class WaterFX {
  constructor(ctx) {
    this.ctx = ctx;
    this.rand = mulberry32(9137);
    this.capacity = Math.max(1500, Math.round(9000 * (ctx.quality?.particles ?? 1)));
    this.budget = ctx.quality?.particles ?? 1;
    this.cursor = 0;
    this.dirtyLo = Infinity;
    this.dirtyHi = -1;
    this.group = new THREE.Group();
    ctx.scene.add(this.group);
    this.buildParticles();
    this.buildDecals();
  }

  buildParticles() {
    const { atmosphere } = this.ctx;
    const n = this.capacity;
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const mk = (name) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
      a.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(name, a);
      return a;
    };
    this.aPos = mk('iPos');
    this.aVel = mk('iVel');
    this.aSize = mk('iSize');
    this.aMisc = mk('iMisc');
    this.aColor = mk('iColor');
    this.attrs = [this.aPos, this.aVel, this.aSize, this.aMisc, this.aColor];
    // every slot starts dead (birth far in the past)
    for (let i = 0; i < n; i++) {
      this.aPos.array[i * 4 + 3] = -1e6;
      this.aVel.array[i * 4 + 3] = 0.001;
    }
    this.aPos.onUpload(() => {
      this.dirtyLo = Infinity;
      this.dirtyHi = -1;
    });
    geo.instanceCount = n;
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...atmosphere.uniforms, uWTime: waterTime },
      vertexShader: PVERT,
      fragmentShader: PFRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.points = new THREE.Mesh(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;
    this.group.add(this.points);
  }

  buildDecals() {
    const { atmosphere, terrain } = this.ctx;
    const rings = 26;
    const segs = 72;
    const pos = [0, 0, 0];
    for (let k = 1; k <= rings; k++) {
      const r = k / rings;
      for (let j = 0; j < segs; j++) {
        const a = (j / segs) * Math.PI * 2;
        pos.push(Math.cos(a) * r, 0, Math.sin(a) * r);
      }
    }
    const idx = [];
    for (let j = 0; j < segs; j++) idx.push(0, 1 + ((j + 1) % segs), 1 + j);
    for (let k = 1; k < rings; k++) {
      const a0 = 1 + (k - 1) * segs;
      const b0 = 1 + k * segs;
      for (let j = 0; j < segs; j++) {
        const j1 = (j + 1) % segs;
        idx.push(a0 + j, a0 + j1, b0 + j, a0 + j1, b0 + j1, b0 + j);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    const tu = terrainUniforms(terrain);
    this.decals = [];
    for (let i = 0; i < 20; i++) {
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          ...atmosphere.uniforms,
          ...tu,
          uWTime: waterTime,
          uDecal: { value: new THREE.Vector4(0, 0, 1, -1e6) },
          uParams: { value: new THREE.Vector4(0, 1, 1, 0) },
          uColor: { value: new THREE.Color(1, 1, 1) },
        },
        vertexShader: DVERT,
        fragmentShader: DFRAG,
        transparent: true,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.renderOrder = 5;
      this.group.add(mesh);
      this.decals.push({ mesh, end: -1 });
    }
    this.decalCursor = 0;
  }

  /** Spawn a terrain-hugging decal. type: D.*, size = radius (m). */
  decal(type, x, z, size, duration, color = null, strength = 1) {
    const now = waterTime.value;
    // reuse a free slot, else the oldest
    let d = this.decals.find((e) => e.end < now);
    if (!d) d = this.decals[this.decalCursor++ % this.decals.length];
    const u = d.mesh.material.uniforms;
    u.uDecal.value.set(x, z, size, now);
    u.uParams.value.set(type, duration, strength, this.rand() * 100);
    if (color) u.uColor.value.copy(color);
    else u.uColor.value.setRGB(1, 1, 1);
    d.end = now + duration;
    d.mesh.visible = true;
  }

  /**
   * Emit one particle. All values in world units; birth = now.
   * opts: type, x,y,z, vx,vy,vz, life, size0, size1, gravity, drag, stretch, color (THREE.Color), alpha, additive
   */
  emit(type, x, y, z, vx, vy, vz, life, size0, size1, gravity, drag, stretch, color, alpha = 1, additive = 0) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    const o = i * 4;
    const now = waterTime.value;
    const p = this.aPos.array;
    p[o] = x;
    p[o + 1] = y;
    p[o + 2] = z;
    p[o + 3] = now;
    const v = this.aVel.array;
    v[o] = vx;
    v[o + 1] = vy;
    v[o + 2] = vz;
    v[o + 3] = life;
    const s = this.aSize.array;
    s[o] = size0;
    s[o + 1] = size1;
    s[o + 2] = gravity;
    s[o + 3] = drag;
    const m = this.aMisc.array;
    m[o] = type;
    m[o + 1] = stretch;
    m[o + 2] = this.rand();
    m[o + 3] = additive;
    const c = this.aColor.array;
    c[o] = color.r;
    c[o + 1] = color.g;
    c[o + 2] = color.b;
    c[o + 3] = alpha;
    if (i < this.dirtyLo) this.dirtyLo = i;
    if (i > this.dirtyHi) this.dirtyHi = i;
  }

  /** Scale an emission count by the quality budget, with stochastic rounding. */
  count(n) {
    const v = n * this.budget;
    const f = Math.floor(v);
    return f + (this.rand() < v - f ? 1 : 0);
  }

  update() {
    const now = waterTime.value;
    for (const d of this.decals) if (d.mesh.visible && d.end < now) d.mesh.visible = false;
    if (this.dirtyHi < 0) return;
    const lo = this.dirtyLo;
    const hi = this.dirtyHi;
    for (const a of this.attrs) {
      a.clearUpdateRanges();
      a.addUpdateRange(lo * 4, (hi - lo + 1) * 4);
      a.needsUpdate = true;
    }
  }

  reset() {
    const p = this.aPos.array;
    for (let i = 0; i < this.capacity; i++) p[i * 4 + 3] = -1e6;
    this.dirtyLo = 0;
    this.dirtyHi = this.capacity - 1;
    for (const d of this.decals) {
      d.mesh.visible = false;
      d.end = -1;
    }
  }
}
