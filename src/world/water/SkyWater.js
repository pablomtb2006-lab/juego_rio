import * as THREE from 'three';
import { mulberry32 } from '../../core/random.js';
import { generateCumulus } from '../../render/Clouds.js';
import { ATMOSPHERE_PARS_GLSL, NOISE_GLSL } from '../../render/shaderChunks.js';

const MAX_CLOUDS = 48;

/**
 * Rain clouds you can fly through during the DROP phase to gain water.
 * Same body contract as Lakes (Rules treats both generically):
 *   skyWater.bodies: [{ id, kind: 'cloud', x, y, z, radius, volume, maxVolume }]
 *   skyWater.drain(body, litres) -> litres removed
 *   skyWater.reset()
 *
 * Visuals: dense blue-grey cumulus (rendered by ctx.atmosphere.clouds, so they sort with
 * the ambient sky), a streaky rain shaft under each one and falling droplets. As a cloud
 * is drained it shrinks, gets sucked towards the stream that drinks it and its rain dries up.
 * Placement: a descending spiral of clouds around the player's drop column (the highest
 * peak) so the fall is a slalom of pickups, a pair over every likely rival drop peak, and
 * a scatter over the rest of the island.
 */
export class SkyWater {
  constructor(ctx) {
    this.ctx = ctx;
    this.bodies = [];
    this.group = new THREE.Group();
    this.group.name = 'SkyWater';
    ctx.scene.add(this.group);
  }

  init() {
    const { terrain, quality } = this.ctx;
    const rand = mulberry32(terrain.seed * 31 + 5);
    const peaks = terrain.peaks.length ? terrain.peaks : [{ x: 0, y: 800, z: 0 }];
    const sites = [];
    const minClear = (x, z, r) => Math.max(terrain.heightAt(x, z), 0) + r * 2.2 + 280;
    const add = (x, z, y, radius) => {
      const lim = terrain.size * 0.42;
      x = THREE.MathUtils.clamp(x, -lim, lim);
      z = THREE.MathUtils.clamp(z, -lim, lim);
      if (sites.some((s) => Math.hypot(s.x - x, s.z - z) < (s.radius + radius) * 1.6 && Math.abs(s.y - y) < (s.radius + radius) * 1.8)) return false;
      sites.push({ x, z, y: Math.max(y, minClear(x, z, radius)), radius });
      return true;
    };

    // 1) the player's drop column: a slalom spiral from just under the start altitude
    const p0 = peaks[0];
    for (let i = 0; i < 9; i++) {
      const a = i * 2.39996 + rand() * 0.4;
      const r = 170 + i * 115 + rand() * 60;
      add(p0.x + Math.cos(a) * r, p0.z + Math.sin(a) * r, 2980 - i * 130 - rand() * 40, 52 + rand() * 30);
    }
    // 2) over the other likely drop peaks (rivals aim for the top 12)
    for (let k = 1; k < Math.min(peaks.length, 12); k++) {
      const p = peaks[k];
      for (let j = 0; j < 2; j++) {
        const a = rand() * Math.PI * 2;
        const r = 150 + rand() * 350;
        add(p.x + Math.cos(a) * r, p.z + Math.sin(a) * r, 1900 + rand() * 900, 45 + rand() * 40);
      }
    }
    // 3) scatter
    let tries = 0;
    while (sites.length < 40 && tries++ < 400) {
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(rand()) * terrain.size * 0.36;
      add(Math.cos(a) * r, Math.sin(a) * r, 1700 + rand() * 1300, 40 + rand() * 60);
    }

    const clouds = this.ctx.atmosphere?.clouds;
    const puffMul = quality.clouds ?? 1;
    sites.slice(0, MAX_CLOUDS).forEach((s, id) => {
      const volume = Math.round(s.radius * s.radius * 900);
      const body = { id, kind: 'cloud', x: s.x, y: s.y, z: s.z, radius: s.radius, volume, maxVolume: volume, drainedBy: null };
      if (clouds) {
        const width = s.radius * 2.7;
        const height = s.radius * 1.55;
        const shape = generateCumulus(rand, { width, height, depth: width * 0.85, count: Math.round(17 * puffMul), towers: 1 });
        body.cloud = clouds.addCloud({ x: s.x, y: s.y - height * 0.42, z: s.z, ...shape, style: 1, drift: false });
        body.cloudBaseY = s.y - height * 0.42;
      }
      body.rain = 1;
      body.shaftLength = Math.min(1100, Math.max(250, (body.cloudBaseY ?? s.y) - Math.max(terrain.heightAt(s.x, s.z), 0) - 60));
      body.wobble = rand() * Math.PI * 2;
      body.lastVolume = volume;
      body.drainVis = 0;
      this.bodies.push(body);
    });

    this.buildRain(rand);
  }

  // --- rain shafts + droplets -----------------------------------------------------------

  buildRain(rand) {
    const { quality } = this.ctx;
    const atmo = this.ctx.atmosphere;
    const n = this.bodies.length;
    this.shaftData = new Float32Array(MAX_CLOUDS * 4);
    this.shaftData2 = new Float32Array(MAX_CLOUDS * 4);
    const shaftUniforms = {
      ...(atmo?.uniforms ?? {}),
      uShaft: { value: Array.from({ length: MAX_CLOUDS }, () => new THREE.Vector4()) },
      uShaft2: { value: Array.from({ length: MAX_CLOUDS }, () => new THREE.Vector4()) },
      uRainColor: { value: new THREE.Color(0.5, 0.56, 0.68) },
      uPointScale: { value: 400 },
    };
    this.shaftUniforms = shaftUniforms;

    // shafts: one axial billboard per cloud, all in one draw
    const seg = 10;
    const pos = [];
    const idx = [];
    const cloudIdx = [];
    for (let c = 0; c < n; c++) {
      const base = pos.length / 3;
      for (let j = 0; j <= seg; j++) {
        const y = j / seg;
        pos.push(-1, y, 0, 1, y, 0);
        cloudIdx.push(c, c);
        if (j < seg) {
          const k = base + j * 2;
          idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
        }
      }
    }
    const shaftGeo = new THREE.BufferGeometry();
    shaftGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    shaftGeo.setAttribute('aCloud', new THREE.Float32BufferAttribute(cloudIdx, 1));
    shaftGeo.setIndex(idx);
    this.shafts = new THREE.Mesh(
      shaftGeo,
      new THREE.ShaderMaterial({
        name: 'RainShafts',
        uniforms: shaftUniforms,
        vertexShader: SHAFT_VERT,
        fragmentShader: SHAFT_FRAG,
        transparent: true,
        depthWrite: false,
        premultipliedAlpha: true,
        blending: THREE.CustomBlending,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
        side: THREE.DoubleSide,
        fog: false,
      }),
    );
    this.shafts.frustumCulled = false;
    this.group.add(this.shafts);

    // droplets: streak sprites falling inside each shaft (more near the top of the column)
    const per = Math.round(110 * (quality.particles ?? 1));
    const total = per * n;
    const drop = new Float32Array(total * 4);
    const dCloud = new Float32Array(total);
    for (let c = 0; c < n; c++) {
      for (let i = 0; i < per; i++) {
        const k = c * per + i;
        const a = rand() * Math.PI * 2;
        const r = Math.sqrt(rand()) * 0.85;
        drop[k * 4] = Math.cos(a) * r;
        drop[k * 4 + 1] = Math.sin(a) * r;
        drop[k * 4 + 2] = rand();
        drop[k * 4 + 3] = 55 + rand() * 30; // m/s
        dCloud[k] = c;
      }
    }
    const dropGeo = new THREE.BufferGeometry();
    dropGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(total * 3), 3));
    dropGeo.setAttribute('aDrop', new THREE.Float32BufferAttribute(drop, 4));
    dropGeo.setAttribute('aCloud', new THREE.Float32BufferAttribute(dCloud, 1));
    this.drops = new THREE.Points(
      dropGeo,
      new THREE.ShaderMaterial({
        name: 'RainDrops',
        uniforms: shaftUniforms,
        vertexShader: DROP_VERT,
        fragmentShader: DROP_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.NormalBlending,
        fog: false,
      }),
    );
    this.drops.frustumCulled = false;
    this.group.add(this.drops);
  }

  drain(body, litres) {
    const taken = Math.min(body.volume, litres);
    body.volume -= taken;
    return taken;
  }

  reset() {
    for (const b of this.bodies) {
      b.volume = b.maxVolume;
      b.lastVolume = b.maxVolume;
      b.drainedBy = null;
      b.drainVis = 0;
      if (b.cloud) {
        b.cloud.visible = true;
        b.cloud.scale = 1;
        b.cloud.alpha = 1;
        b.cloud.pull = null;
        b.cloud.pullAmount = 0;
      }
    }
  }

  update(dt = 1 / 60, time = 0) {
    const cam = this.ctx.camera;
    const atmo = this.ctx.atmosphere;
    const u = this.shaftUniforms;
    if (!u) return;
    // rain clouds are match pickups: hidden in the menu, they gather when the match starts
    const phase = this.ctx.game?.state;
    const show = phase && phase !== 'menu' ? 1 : 0;
    this.show = (this.show ?? show) + (show - (this.show ?? show)) * (1 - Math.exp(-dt * 1.5));
    for (const b of this.bodies) {
      const f = Math.max(b.volume / b.maxVolume, 0);
      const draining = b.volume < b.lastVolume - 1;
      b.lastVolume = b.volume;
      b.drainVis += ((draining ? 1 : 0) - b.drainVis) * (1 - Math.exp(-dt * (draining ? 10 : 3)));
      if (b.cloud) {
        const c = b.cloud;
        // shrink with the remaining water, quick puff-out at the very end
        const wob = 1 + 0.06 * b.drainVis * Math.sin(time * 22 + b.wobble);
        c.scale = (0.3 + 0.7 * Math.sqrt(f)) * wob;
        c.alpha = THREE.MathUtils.smoothstep(f, 0.0, 0.12) * this.show;
        c.visible = f > 0.002 && this.show > 0.01;
        if (b.drainedBy && f < 1) {
          c.pull ??= new THREE.Vector3();
          c.pull.copy(b.drainedBy.pos);
          c.pullAmount = Math.min(0.6, (1 - f) * 0.55 + b.drainVis * 0.15);
        } else {
          c.pullAmount = 0;
        }
      }
      // rain dries up with the cloud
      b.rain = THREE.MathUtils.smoothstep(f, 0.02, 0.5) * this.show;
      const i = b.id;
      const top = (b.cloudBaseY ?? b.y) + b.radius * 0.25;
      const sc = b.cloud ? b.cloud.scale : 1;
      u.uShaft.value[i].set(b.x, top, b.z, b.radius * 0.95 * sc);
      u.uShaft2.value[i].set(b.shaftLength, b.rain, b.wobble, 0);
    }
    // rain color follows the time of day
    if (atmo?.cloudColors) {
      u.uRainColor.value.copy(atmo.cloudColors.rainShade).lerp(atmo.cloudColors.rainLit, 0.45);
    }
    const h = this.ctx.renderer.getDrawingBufferSize(_size).y;
    u.uPointScale.value = h * 0.5 / Math.tan(THREE.MathUtils.degToRad(cam.fov * 0.5));
    // shafts render just before the clouds so cloud bellies cover the shaft tops
    if (atmo?.clouds) {
      this.shafts.renderOrder = atmo.clouds.mesh.renderOrder - 1;
      this.drops.renderOrder = atmo.clouds.mesh.renderOrder - 2;
    }
    // droplets only matter during the drop
    this.drops.visible = phase === 'drop';
    this.shafts.visible = this.show > 0.01;
  }
}

const _size = new THREE.Vector2();

const SHAFT_VERT = /* glsl */ `
#define MAX_CLOUDS ${MAX_CLOUDS}
uniform vec4 uShaft[MAX_CLOUDS];   // x, yTop, z, radius
uniform vec4 uShaft2[MAX_CLOUDS];  // length, rain 0..1, seed
attribute float aCloud;
varying vec2 vUv;
varying vec3 vWorld;
varying float vRain;
varying float vSeed;
varying float vLen;
void main() {
  int i = int(aCloud + 0.5);
  vec4 s = uShaft[i];
  vec4 s2 = uShaft2[i];
  vec3 top = s.xyz;
  vec3 toCam = cameraPosition - top;
  vec3 right = normalize(vec3(toCam.z, 0.0, -toCam.x) + vec3(1e-4, 0.0, 0.0));
  float widen = 1.0 + 0.35 * position.y;
  vec3 wp = top + right * position.x * s.w * widen - vec3(0.0, position.y * s2.x, 0.0);
  vUv = position.xy;
  vWorld = wp;
  vRain = s2.y;
  vSeed = s2.z;
  vLen = s2.x;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const SHAFT_FRAG = /* glsl */ `
${ATMOSPHERE_PARS_GLSL}
${NOISE_GLSL}
uniform vec3 uRainColor;
varying vec2 vUv;
varying vec3 vWorld;
varying float vRain;
varying float vSeed;
varying float vLen;
void main() {
  if (vRain < 0.01) discard;
  float x = vUv.x;
  float y = vUv.y;
  float body = sqrt(max(1.0 - x * x, 0.0));
  float tm = uTime;
  vec2 q = vec2(x * 7.0 + vSeed * 5.0, y * vLen / 140.0 - tm * 0.9);
  float streak = rioNoise2(q * vec2(1.0, 0.35)) * 0.65 + rioNoise2(q * vec2(2.6, 0.9) + 3.1) * 0.35;
  float curtain = 0.55 + 0.45 * rioNoise2(vec2(x * 2.0 + vSeed, y * 1.5 - tm * 0.15));
  float fadeTop = smoothstep(0.0, 0.06, y);
  float fadeBottom = 1.0 - smoothstep(0.35, 1.0, y);
  float a = body * mix(0.35, 1.0, streak) * curtain * fadeTop * fadeBottom * vRain * 0.34;
  // the shaft dissolves when the camera is inside it (droplets take over)
  a *= smoothstep(15.0, 120.0, distance(cameraPosition, vWorld));
  vec3 rd = normalize(vWorld - cameraPosition);
  // a vertical curtain seen from straight above degenerates into a line: fade it out
  a *= 1.0 - smoothstep(0.45, 0.8, abs(rd.y));
  vec3 col = uRainColor * (0.9 + 0.25 * pow(max(dot(rd, uSunDir), 0.0), 4.0));
  col = mix(col, atmoHaze(rd), min(atmoFogAmount(cameraPosition, vWorld), 0.8));
  gl_FragColor = vec4(col * a, a);
}
`;

const DROP_VERT = /* glsl */ `
#define MAX_CLOUDS ${MAX_CLOUDS}
uniform vec4 uShaft[MAX_CLOUDS];
uniform vec4 uShaft2[MAX_CLOUDS];
uniform float uTime;
uniform float uPointScale;
attribute vec4 aDrop;   // offset x/z (shaft radii), phase, speed (m/s)
attribute float aCloud;
varying float vAlpha;
void main() {
  int i = int(aCloud + 0.5);
  vec4 s = uShaft[i];
  vec4 s2 = uShaft2[i];
  float len = s2.x * 0.7;
  float t = fract(aDrop.z + uTime * aDrop.w / len);
  float spread = s.w * (1.0 + 0.25 * t);
  vec3 wp = vec3(s.x + aDrop.x * spread, s.y - t * len, s.z + aDrop.y * spread);
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  float size = uPointScale * 2.6 / max(-mv.z, 1.0);
  vAlpha = s2.y * smoothstep(0.0, 0.04, t) * (1.0 - smoothstep(0.55, 1.0, t)) * smoothstep(0.8, 2.5, size);
  gl_PointSize = clamp(size, 0.0, 26.0);
  gl_Position = projectionMatrix * mv;
}
`;

const DROP_FRAG = /* glsl */ `
uniform vec3 uRainColor;
varying float vAlpha;
void main() {
  vec2 p = gl_PointCoord - 0.5;
  // thin vertical streak inside the point sprite
  float a = (1.0 - smoothstep(0.03, 0.09, abs(p.x))) * (1.0 - smoothstep(0.2, 0.5, abs(p.y)));
  a *= vAlpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(mix(uRainColor, vec3(0.92, 0.97, 1.0), 0.6), a * 0.85);
}
`;
