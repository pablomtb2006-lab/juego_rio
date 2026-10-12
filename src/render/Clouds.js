import * as THREE from 'three';
import { ATMOSPHERE_PARS_GLSL } from './shaderChunks.js';
import { mulberry32, createNoise2D, fbm } from '../core/random.js';

/**
 * Stylized cumulus made of camera-facing "puff" impostors: each puff samples a baked
 * lumpy-sphere texture (density + normal), is lit with a wrapped sun term blended with
 * the cloud-level normal (bright sunlit tops, lavender undersides, silver lining when
 * backlit) and receives the shared aerial perspective. All puffs of all clouds live in a
 * single instanced mesh sorted back-to-front every frame, so ambient cumulus and the
 * gameplay rain clouds (SkyWater) blend correctly with each other.
 *
 *   const cloud = clouds.addCloud({ x, y, z, puffs, style: 0 | 1, drift: true })
 *   cloud.scale / cloud.alpha / cloud.pull (Vector3|null) / cloud.pullAmount  — animated by owners
 *   clouds.removeCloud(cloud)
 *   clouds.veil, clouds.veilColor   camera-inside-cloud whiteout (read by PostFX)
 */

const VERT = /* glsl */ `
attribute vec4 iPosSize;   // world centre, half size (m)
attribute vec4 iShape;     // cloud-level normal (xyz), height in cloud 0..1 (w)
attribute vec4 iParams;    // alpha, rain amount, rotation (rad), atlas variant
varying vec2 vUv;
varying vec2 vRot;
varying vec4 vShape;
varying vec4 vParams;
varying vec3 vWorld;
varying float vFade;
void main() {
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec2 c = position.xy;
  vec3 wp = iPosSize.xyz + (right * c.x + up * c.y) * iPosSize.w;
  float cr = cos(iParams.z);
  float sr = sin(iParams.z);
  vUv = vec2(cr * c.x + sr * c.y, -sr * c.x + cr * c.y);
  vRot = vec2(cr, sr);
  vShape = iShape;
  vParams = iParams;
  vWorld = wp;
  float d = distance(cameraPosition, iPosSize.xyz);
  float vz = -(viewMatrix * vec4(iPosSize.xyz, 1.0)).z;
  // fade puffs the camera is flying through (no screen-filling cards)
  vFade = iParams.x * smoothstep(iPosSize.w * 0.3, iPosSize.w * 1.25, d) * smoothstep(iPosSize.w * 0.08, iPosSize.w * 0.45, vz);
  if (vz < 1.0 || vFade < 0.002) {
    // camera-parallel quad at/behind the eye would project to infinity: drop it
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec4 clip = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  clip.z = min(clip.z, clip.w * 0.99999); // far clouds are never clipped by the far plane
  gl_Position = clip;
}
`;

const FRAG = /* glsl */ `
${ATMOSPHERE_PARS_GLSL}
uniform sampler2D uPuffTex;
uniform vec3 uCloudLit;
uniform vec3 uCloudShade;
uniform vec3 uRainLit;
uniform vec3 uRainShade;
uniform float uFogCap;
varying vec2 vUv;
varying vec2 vRot;
varying vec4 vShape;
varying vec4 vParams;
varying vec3 vWorld;
varying float vFade;
void main() {
  if (abs(vUv.x) > 1.0 || abs(vUv.y) > 1.0) discard;
  // round: an interpolated 1.99999 would otherwise jump a whole atlas cell
  float variant = floor(vParams.w + 0.5);
  vec2 cell = vec2(mod(variant, 2.0), floor(variant * 0.5));
  vec4 tx = texture2D(uPuffTex, (vUv * 0.5 + 0.5 + cell) * 0.5);
  // radial window: low mips of the atlas must never reach the quad border
  float alpha = tx.r * vFade * (1.0 - smoothstep(0.8, 0.97, length(vUv)));
  if (alpha < 0.003) discard;

  // puff normal: texture space → quad space (undo the uv rotation) → world
  vec2 n2 = tx.gb * 2.0 - 1.0;
  n2 = vec2(vRot.x * n2.x - vRot.y * n2.y, vRot.y * n2.x + vRot.x * n2.y);
  float nz = sqrt(max(1.0 - dot(n2, n2), 0.0));
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 back = vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
  vec3 Np = normalize(right * n2.x + up * n2.y + back * nz);
  vec3 Nc = normalize(vShape.xyz);
  vec3 N = normalize(Np * 0.45 + Nc * 0.9);
  float h = vShape.w;
  float rain = vParams.y;
  float thick = tx.a;

  // stylized two-tone lighting: wrapped sun term, darker bellies
  float ndl = dot(N, uSunDir);
  float sunVis = smoothstep(-0.45, 0.75, ndl);
  sunVis *= mix(0.6, 1.0, smoothstep(0.05, 0.75, h));
  vec3 lit = mix(uCloudLit, uRainLit, rain);
  vec3 shade = mix(uCloudShade, uRainShade, rain);
  vec3 col = mix(shade, lit, sunVis);
  // skylight: tops pick up the zenith, bellies the ground bounce
  col += uZenithColor * 0.10 * smoothstep(0.0, 1.0, N.y);
  col *= mix(0.84, 1.0, smoothstep(-0.7, 0.3, N.y));

  vec3 rd = normalize(vWorld - cameraPosition);
  // silver lining: thin edges glow when the sun is behind the cloud
  float fwd = pow(max(dot(rd, uSunDir), 0.0), 5.0);
  col += uSunColor * fwd * (1.0 - thick) * 0.9 * (1.0 - rain * 0.6);
  // rim brightening on the sunny side (keeps silhouettes crisp)
  col += lit * 0.12 * pow(1.0 - nz, 3.0) * max(ndl, 0.0);

  // aerial perspective, capped so the far ring still reads against the sky
  vec3 d = vWorld - cameraPosition;
  float dist = length(d);
  float k = max(uAtmoFog.y, 1e-6);
  float t = k * d.y;
  float f = abs(t) > 1e-3 ? (1.0 - exp(-t)) / t : 1.0 - 0.5 * t;
  float od = uAtmoFog.x * exp(-k * (cameraPosition.y - uAtmoFog.z)) * dist * f + uAtmoMisc.x * dist;
  float fog = min(1.0 - exp(-max(od, 0.0)), uFogCap);
  col = mix(col, atmoHaze(rd), fog);

  gl_FragColor = vec4(col * alpha, alpha);
}
`;

/** 2×2 atlas of lumpy puffs: R = density, GB = normal xy, A = thickness. */
export function createPuffTexture(seed = 11) {
  const N = 128;
  const A = N * 2;
  const data = new Uint8Array(A * A * 4);
  const rand = mulberry32(seed);
  const noise = createNoise2D(rand);
  const H = new Float32Array(N * N);
  const S = new Float32Array(N * N);
  for (let v = 0; v < 4; v++) {
    const ox = (v % 2) * N;
    const oy = Math.floor(v / 2) * N;
    const blobs = [{ x: 0, y: -0.06, r: 0.46 + rand() * 0.08 }];
    const n = 7 + Math.floor(rand() * 5);
    for (let i = 0; i < n; i++) {
      const a = rand() * Math.PI * 2;
      const d = 0.2 + rand() * 0.3;
      let r = 0.16 + rand() * 0.2;
      const x = Math.cos(a) * d;
      const y = Math.sin(a) * d * 0.75 + 0.05;
      r = Math.min(r, 0.84 - Math.hypot(x, y));
      if (r > 0.07) blobs.push({ x, y, r });
    }
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const px = ((i + 0.5) / N) * 2 - 1;
        const py = ((j + 0.5) / N) * 2 - 1;
        let h = 0; // sphere-cap height field → normals
        let sf = 0; // linear "cone" field → soft silhouette
        for (const b of blobs) {
          const d2 = (px - b.x) ** 2 + (py - b.y) ** 2;
          if (d2 < b.r * b.r) h = Math.max(h, Math.sqrt(b.r * b.r - d2));
          sf = Math.max(sf, 1 - Math.sqrt(d2) / b.r);
        }
        const detail = fbm(noise, px * 3.2 + v * 13.1, py * 3.2 - v * 7.7, 4);
        H[j * N + i] = Math.max(0, h + 0.03 * detail);
        S[j * N + i] = sf;
      }
    }
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const h = H[j * N + i];
        const hx0 = H[j * N + Math.max(i - 1, 0)];
        const hx1 = H[j * N + Math.min(i + 1, N - 1)];
        const hy0 = H[Math.max(j - 1, 0) * N + i];
        const hy1 = H[Math.min(j + 1, N - 1) * N + i];
        const s = N / 4; // (2 texels) / (2 / N units)
        let nx = -(hx1 - hx0) * s;
        let ny = -(hy1 - hy0) * s;
        const l = Math.hypot(nx, ny, 1);
        nx /= l;
        ny /= l;
        const px = ((i + 0.5) / N) * 2 - 1;
        const py = ((j + 0.5) / N) * 2 - 1;
        // soft, slightly eroded silhouette (cauliflower lumps stay readable)
        const wisp = fbm(noise, px * 6 + v * 3.3, py * 6 + 11.1, 4);
        const sf = S[j * N + i];
        let dens = sf > 0 ? smoothstep01((sf + wisp * 0.09 * Math.min(sf * 4, 1) - 0.02) / 0.42) : 0;
        dens = Math.pow(dens, 0.85);
        // fade fully before the cell border (mip bleeding between atlas cells)
        dens *= 1 - smoothstep01((Math.hypot(px, py) - 0.84) / 0.12);
        const o = ((oy + j) * A + ox + i) * 4;
        data[o] = Math.round(dens * 255);
        data[o + 1] = Math.round((nx * 0.5 + 0.5) * 255);
        data[o + 2] = Math.round((ny * 0.5 + 0.5) * 255);
        data[o + 3] = Math.round(Math.min(h / 0.5, 1) * 255);
      }
    }
  }
  const tex = new THREE.DataTexture(data, A, A, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

function smoothstep01(x) {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
}

/**
 * Generates the puffs of one cumulus: a wide base layer, a domed body and 1–3 towers.
 * Returns { puffs: [{x,y,z,r,nx,ny,nz,h,rot,variant}], width, height, depth } in local
 * metres (y = 0 at the cloud base).
 */
export function generateCumulus(rand, { width = 900, height = 450, depth = width * 0.75, count = 30, towers = 2 } = {}) {
  const puffs = [];
  const W = width / 2;
  const D = depth / 2;
  const push = (x, y, z, r) => {
    const nx = x / W;
    const ny = ((y - height * 0.38) / height) * 1.5;
    const nz = z / D;
    const l = Math.hypot(nx, ny, nz) || 1;
    puffs.push({ x, y, z, r, nx: nx / l, ny: ny / l, nz: nz / l, h: Math.min(Math.max(y / height, 0), 1), rot: rand() * Math.PI * 2, variant: Math.floor(rand() * 4) });
  };
  const nBase = Math.max(3, Math.round(count * 0.38));
  for (let i = 0; i < nBase; i++) {
    const a = rand() * Math.PI * 2;
    const d = Math.sqrt(rand());
    const r = (0.17 + rand() * 0.09) * width * (1 - 0.3 * d);
    push(Math.cos(a) * d * W * 0.78, r * 0.45 + rand() * height * 0.06, Math.sin(a) * d * D * 0.78, r);
  }
  const nTower = towers > 0 ? Math.round(count * 0.18) : 0;
  const nDome = Math.max(2, count - nBase - nTower);
  for (let i = 0; i < nDome; i++) {
    const a = rand() * Math.PI * 2;
    const d = Math.sqrt(rand());
    const prof = Math.sqrt(Math.max(0, 1 - d * d));
    const y = height * (0.22 + 0.6 * prof * (0.55 + 0.45 * rand()));
    const r = (0.12 + rand() * 0.1) * width * (0.65 + 0.35 * prof);
    push(Math.cos(a) * d * W * 0.62, y, Math.sin(a) * d * D * 0.62, r);
  }
  for (let t = 0; t < towers && nTower > 0; t++) {
    const a = rand() * Math.PI * 2;
    const d = rand() * 0.35;
    const tx = Math.cos(a) * d * W;
    const tz = Math.sin(a) * d * D;
    const per = Math.ceil(nTower / towers);
    for (let i = 0; i < per; i++) {
      const f = (i + 1) / per;
      const r = width * (0.13 - 0.05 * f) * (0.8 + 0.4 * rand());
      push(tx + (rand() - 0.5) * r, height * (0.55 + 0.45 * f), tz + (rand() - 0.5) * r, r);
    }
  }
  return { puffs, width, height, depth };
}

export class CloudRenderer {
  constructor(uniforms, { maxPuffs = 4096 } = {}) {
    this.clouds = [];
    this.maxPuffs = maxPuffs;
    this.veil = 0;
    this.veilColor = new THREE.Color(1, 1, 1);
    this.wind = new THREE.Vector2(3.5, 1.2); // m/s drift of ambient cumulus
    this.drift = new THREE.Vector2();
    this.fieldSize = 0; // wrap size for drifting clouds (0 = no wrap)
    this.puffTexture = createPuffTexture();

    const base = new THREE.PlaneGeometry(2, 2);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.getAttribute('position'));
    this.aPosSize = new THREE.InstancedBufferAttribute(new Float32Array(maxPuffs * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aShape = new THREE.InstancedBufferAttribute(new Float32Array(maxPuffs * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aParams = new THREE.InstancedBufferAttribute(new Float32Array(maxPuffs * 4), 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iPosSize', this.aPosSize);
    geo.setAttribute('iShape', this.aShape);
    geo.setAttribute('iParams', this.aParams);
    geo.instanceCount = 0;
    this.geometry = geo;

    this.material = new THREE.ShaderMaterial({
      name: 'RioClouds',
      uniforms: {
        ...uniforms,
        uPuffTex: { value: this.puffTexture },
        uCloudLit: { value: new THREE.Color(1, 1, 1) },
        uCloudShade: { value: new THREE.Color(0.5, 0.55, 0.8) },
        uRainLit: { value: new THREE.Color(0.7, 0.75, 0.85) },
        uRainShade: { value: new THREE.Color(0.25, 0.3, 0.45) },
        uFogCap: { value: 0.82 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      premultipliedAlpha: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      fog: false,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'Clouds';
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;

    // scratch for sorting
    this._keys = new Float32Array(maxPuffs);
    this._order = new Uint32Array(maxPuffs);
    this._wx = new Float32Array(maxPuffs);
    this._wy = new Float32Array(maxPuffs);
    this._wz = new Float32Array(maxPuffs);
    this._ws = new Float32Array(maxPuffs);
    this._ref = new Array(maxPuffs);
    this._refPuff = new Array(maxPuffs);
  }

  get puffCount() {
    let n = 0;
    for (const c of this.clouds) n += c.puffs.length;
    return n;
  }

  /** puffs: from generateCumulus().puffs (local metres). style 0 = fair-weather, 1 = rain. */
  addCloud({ x, y, z, puffs, width, height, depth, style = 0, drift = false, sizeScale = 1 / 0.78 }) {
    const cloud = {
      x, y, z, puffs, width, height, depth: depth ?? width, style, drift,
      sizeScale, scale: 1, alpha: 1, pull: null, pullAmount: 0, visible: true,
    };
    this.clouds.push(cloud);
    return cloud;
  }

  removeCloud(cloud) {
    const i = this.clouds.indexOf(cloud);
    if (i >= 0) this.clouds.splice(i, 1);
  }

  /** Centre of a (possibly drifting) cloud in world space. */
  cloudPosition(cloud, out = new THREE.Vector3()) {
    let x = cloud.x;
    let z = cloud.z;
    if (cloud.drift) {
      x += this.drift.x;
      z += this.drift.y;
      if (this.fieldSize > 0) {
        const s = this.fieldSize;
        x = ((((x + s / 2) % s) + s) % s) - s / 2;
        z = ((((z + s / 2) % s) + s) % s) - s / 2;
      }
    }
    return out.set(x, cloud.y, z);
  }

  update(dt, camera, colors) {
    this.drift.addScaledVector(this.wind, dt);
    const u = this.material.uniforms;
    if (colors) {
      u.uCloudLit.value.copy(colors.lit);
      u.uCloudShade.value.copy(colors.shade);
      u.uRainLit.value.copy(colors.rainLit);
      u.uRainShade.value.copy(colors.rainShade);
    }

    const cx = camera.position.x;
    const cy = camera.position.y;
    const cz = camera.position.z;
    const e = camera.matrixWorld.elements;
    const fx = -e[8];
    const fy = -e[9];
    const fz = -e[10];
    const keys = this._keys;
    const order = this._order;
    const wx = this._wx;
    const wy = this._wy;
    const wz = this._wz;
    const ws = this._ws;
    const ref = this._ref;
    const refPuff = this._refPuff;
    let n = 0;
    let veil = 0;
    let veilRain = 0;
    const p = _v;
    for (const c of this.clouds) {
      if (!c.visible || c.alpha <= 0.002 || c.scale <= 0.01) continue;
      this.cloudPosition(c, p);
      // camera-inside-cloud veil (ellipsoid around the cloud body)
      const rx = c.width * 0.42 * c.scale;
      const ry = c.height * 0.5 * c.scale;
      const rz = c.depth * 0.42 * c.scale;
      const dx = (cx - p.x) / rx;
      const dy = (cy - (p.y + c.height * 0.42 * c.scale)) / ry;
      const dz = (cz - p.z) / rz;
      const de = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (de < 1.1) {
        const v = (1 - smoothstep01((de - 0.45) / 0.6)) * c.alpha;
        if (v > veil) {
          veil = v;
          veilRain = c.style;
        }
      }
      const pullX = c.pull ? c.pull.x : 0;
      const pullY = c.pull ? c.pull.y : 0;
      const pullZ = c.pull ? c.pull.z : 0;
      const pa = c.pull ? c.pullAmount : 0;
      for (const pf of c.puffs) {
        if (n >= this.maxPuffs) break;
        let x = p.x + pf.x * c.scale;
        let y = p.y + pf.y * c.scale;
        let z = p.z + pf.z * c.scale;
        if (pa > 0) {
          x += (pullX - x) * pa;
          y += (pullY - y) * pa;
          z += (pullZ - z) * pa;
        }
        const s = pf.r * c.sizeScale * c.scale;
        const ox = x - cx;
        const oy = y - cy;
        const oz = z - cz;
        // at / behind the eye plane → skip (a camera-parallel card there is degenerate)
        if (ox * fx + oy * fy + oz * fz < Math.max(1, s * 0.08)) continue;
        keys[n] = ox * ox + oy * oy + oz * oz;
        wx[n] = x;
        wy[n] = y;
        wz[n] = z;
        ws[n] = s;
        ref[n] = c;
        refPuff[n] = pf;
        order[n] = n;
        n++;
      }
    }
    this.veil = veil;
    this.veilColor.copy(veilRain ? u.uRainLit.value : u.uCloudLit.value).lerp(u.uCloudShade.value, veilRain ? 0.5 : 0.25);

    const idx = order.subarray(0, n);
    idx.sort((a, b) => keys[b] - keys[a]);

    const P = this.aPosSize.array;
    const S = this.aShape.array;
    const Q = this.aParams.array;
    for (let i = 0; i < n; i++) {
      const k = idx[i];
      const c = ref[k];
      const pf = refPuff[k];
      const o = i * 4;
      P[o] = wx[k];
      P[o + 1] = wy[k];
      P[o + 2] = wz[k];
      P[o + 3] = ws[k];
      S[o] = pf.nx;
      S[o + 1] = pf.ny;
      S[o + 2] = pf.nz;
      S[o + 3] = pf.h;
      Q[o] = c.alpha * (pf.alpha ?? 1);
      Q[o + 1] = c.style;
      Q[o + 2] = pf.rot;
      Q[o + 3] = pf.variant;
    }
    this.geometry.instanceCount = n;
    this.aPosSize.needsUpdate = true;
    this.aShape.needsUpdate = true;
    this.aParams.needsUpdate = true;
    this.aPosSize.clearUpdateRanges();
    this.aShape.clearUpdateRanges();
    this.aParams.clearUpdateRanges();
    if (n > 0) {
      this.aPosSize.addUpdateRange(0, n * 4);
      this.aShape.addUpdateRange(0, n * 4);
      this.aParams.addUpdateRange(0, n * 4);
    }
  }

  /**
   * Soft top-down coverage of the drifting cumulus (R8, repeat-wrapped over fieldSize),
   * sampled by atmoCloudShadow() to put moving cloud shadows on the landscape.
   */
  buildShadowMap(res = 256) {
    const size = this.fieldSize;
    const data = new Uint8Array(res * res);
    const acc = new Float32Array(res * res);
    const noise = createNoise2D(mulberry32(91));
    for (const c of this.clouds) {
      if (!c.drift) continue;
      for (const pf of c.puffs) {
        // project puffs to the ground plane, weight by size (bigger = darker core)
        const r = pf.r * 1.05;
        const px = c.x + pf.x;
        const pz = c.z + pf.z;
        const i0 = Math.floor(((px - r) / size + 0.5) * res);
        const i1 = Math.ceil(((px + r) / size + 0.5) * res);
        const j0 = Math.floor(((pz - r) / size + 0.5) * res);
        const j1 = Math.ceil(((pz + r) / size + 0.5) * res);
        for (let j = j0; j <= j1; j++) {
          for (let i = i0; i <= i1; i++) {
            const x = (i / res - 0.5) * size;
            const z = (j / res - 0.5) * size;
            const d = Math.hypot(x - px, z - pz) / r;
            if (d >= 1) continue;
            const ii = ((i % res) + res) % res;
            const jj = ((j % res) + res) % res;
            acc[jj * res + ii] += (1 - d * d) * 0.45;
          }
        }
      }
    }
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const k = j * res + i;
        const n = fbm(noise, i * 0.09, j * 0.09, 3) * 0.25;
        const v = smoothstep01((acc[k] + n - 0.15) / 0.55);
        data[k] = Math.round(v * 255);
      }
    }
    const tex = new THREE.DataTexture(data, res, res, THREE.RedFormat, THREE.UnsignedByteType);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
  }
}

const _v = new THREE.Vector3();
