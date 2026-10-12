import * as THREE from 'three';
import { ATMOSPHERE_PARS_GLSL } from '../../render/shaderChunks.js';
import { NOISE_GLSL, LIGHT_GLSL, TERRAIN_GLSL, terrainUniforms, getSeaFieldTexture, envUniforms, syncEnv, waterTime } from './waterCommon.js';

const MAX_RINGS = 4;

const VERT = /* glsl */ `
${TERRAIN_GLSL}
uniform sampler2D uSeaTex;
uniform float uWTime;
varying vec3 vWorldPos;
varying vec2 vSea;

float swellH(vec2 p, float t) {
  return 0.32 * sin(dot(p, vec2(0.036, 0.021)) + t * 0.9)
       + 0.18 * sin(dot(p, vec2(-0.025, 0.052)) + t * 1.3)
       + 0.10 * sin(dot(p, vec2(0.071, -0.043)) + t * 1.9);
}

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec2 sea = textureLod(uSeaTex, terrainUV(wp.xz), 0.0).rg;
  vSea = sea;
  float damp = smoothstep(0.3, 10.0, sea.x) * (1.0 - smoothstep(1500.0, 6000.0, length(wp.xyz - cameraPosition)));
  wp.y += swellH(wp.xz, uWTime) * damp;
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = /* glsl */ `
${ATMOSPHERE_PARS_GLSL}
${NOISE_GLSL}
${LIGHT_GLSL}
uniform sampler2D uSeaTex;
uniform vec3 uTerrainInfo;
uniform vec3 uShallow;
uniform vec3 uMid;
uniform vec3 uDeep;
uniform vec3 uLagoon;
uniform vec4 uRings[${MAX_RINGS}];
varying vec3 vWorldPos;
varying vec2 vSea;

vec2 seaUV(vec2 xz) {
  float res = uTerrainInfo.y;
  return ((xz / uTerrainInfo.x + 0.5) * (res - 1.0) + 0.5) / res;
}

vec2 swellGrad(vec2 p, float t) {
  vec2 g = vec2(0.0);
  g += 0.32 * cos(dot(p, vec2(0.036, 0.021)) + t * 0.9) * vec2(0.036, 0.021);
  g += 0.18 * cos(dot(p, vec2(-0.025, 0.052)) + t * 1.3) * vec2(-0.025, 0.052);
  g += 0.10 * cos(dot(p, vec2(0.071, -0.043)) + t * 1.9) * vec2(0.071, -0.043);
  return g;
}

uniform float uWTime;

void main() {
  float t = uWTime;
  vec2 xz = vWorldPos.xz;
  vec3 toCam = uCameraPos - vWorldPos;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  vec2 sea = texture(uSeaTex, seaUV(xz)).rg;
  float depth = sea.x;
  float sd = sea.y;
  // metres per pixel: drives every level-of-detail fade (no shimmering from 3000 m up)
  float fp = max(length(fwidth(xz)), 1e-3);

  // ---- normal: swell + three scrolling detail octaves, each fading with pixel footprint
  vec2 g = swellGrad(xz, t) * smoothstep(0.3, 10.0, depth) * (1.0 - smoothstep(6.0, 30.0, fp));
  vec3 n1 = gnoised(xz * 0.045 + vec2(t * 0.040, t * 0.025));
  vec3 n2 = gnoised(xz * 0.16 + vec2(-t * 0.07, t * 0.09) + n1.yz * 0.3);
  vec3 n3 = gnoised(xz * 0.62 + vec2(t * 0.21, -t * 0.17));
  float f1 = 1.0 - smoothstep(4.0, 30.0, fp);
  float f2 = 1.0 - smoothstep(1.2, 8.0, fp);
  float f3 = 1.0 - smoothstep(0.3, 2.0, fp);
  g += n1.yz * 0.045 * 0.55 * f1;
  g += n2.yz * 0.16 * 0.22 * f2;
  g += n3.yz * 0.62 * 0.05 * f3;
  // calmer right at the shore
  g *= mix(0.45, 1.0, smoothstep(0.0, 4.0, depth));
  vec3 N = normalize(vec3(-g.x, 1.0, -g.y));
  float NdV = max(dot(N, V), 0.0);

  // ---- body colour by depth (stylized gradient), with broad tonal variation
  float big = fbm2(xz * 0.0012 + 3.7);
  float dd = max(depth, 0.0) * (0.85 + big * 0.3);
  vec3 col = mix(uLagoon, uShallow, smoothstep(0.0, 3.0, dd));
  col = mix(col, uMid, smoothstep(2.0, 22.0, dd));
  col = mix(col, uDeep, smoothstep(14.0, 90.0, dd));
  // light scattering through wave crests facing the sun
  float crest = clamp(dot(g, -normalize(uSunDir.xz + 1e-4)) * 3.0, 0.0, 1.0);
  col += uShallow * crest * 0.25 * (1.0 - smoothstep(30.0, 120.0, dd));
  col *= waterBodyLight(N);

  // ---- reflection
  vec3 R = reflect(-V, N);
  float F = fresnelSchlick(NdV, 0.04);
  F = min(F, 0.75);
  vec3 sky = skyReflection(R, 0.15);
  col = mix(col, sky, F);
  col += sunSpecular(N, V, 900.0, 60.0) * (0.6 + 0.4 * f2);
  float gl = sunGlints(xz, 2.2, N, V, t) * f3 + sunGlints(xz + 31.0, 9.0, N, V, t * 0.8) * f1 * (1.0 - f3);
  col += uSunColor * gl * 9.0;

  // ---- shoreline foam: crisp contact line + bands rolling in, widened from altitude
  float fn = fbm2(xz * 0.035 + vec2(t * 0.03, -t * 0.02));
  float fn2 = vnoise(xz * 0.14 + vec2(-t * 0.1, t * 0.07));
  float edge = 2.2 + fn * 3.5 + fp * 1.6;
  float contact = 1.0 - aastep(edge, sd + fn2 * 1.2);
  // lighter "wet sand" fringe just outside the foam line
  float fringe = (1.0 - smoothstep(edge, edge + 10.0 + fp * 3.0, sd)) * (1.0 - contact);
  float lambda = 15.0;
  float ph = sd / lambda + t * 0.16 + fn * 0.9;
  float band = fract(ph);
  float bandW = mix(0.16, 0.05, smoothstep(0.0, 55.0, sd));
  float bands = aastep(1.0 - bandW, band) * (1.0 - aastep(0.995, band));
  bands *= smoothstep(0.35, 0.6, fn2 + 0.25 * fn) ;
  bands *= (1.0 - smoothstep(25.0, 75.0, sd)) * step(edge, sd);
  bands *= 1.0 - smoothstep(lambda * 0.08, lambda * 0.3, fp);
  float foam = max(contact, bands * 0.95);
  // speckled foam remnants between bands
  float speck = step(0.78, vnoise(xz * 0.6 + vec2(t * 0.3, 0.0))) * (1.0 - smoothstep(6.0, 30.0, sd)) * step(edge, sd) * f3;
  foam = max(foam, speck * 0.7);
  col = mix(col, col + uLagoon * 0.35, fringe * 0.6);

  // ---- finish shockwave rings (white ring racing out over the sea)
  float ringFoam = 0.0;
  float ringGlow = 0.0;
  for (int i = 0; i < ${MAX_RINGS}; i++) {
    vec4 r = uRings[i];
    if (r.w <= 0.0) continue;
    float age = t - r.z;
    if (age < 0.0 || age > 9.0) continue;
    vec2 dvec = xz - r.xy;
    float d = length(dvec);
    float rad = 260.0 * r.w * (1.0 - exp(-age * 0.55));
    float w = (3.0 + age * 1.5) * r.w + fp * 1.5;
    float k = 1.0 - smoothstep(w * 0.4, w, abs(d - rad + fn2 * 3.0));
    float fade = 1.0 - smoothstep(4.0, 9.0, age);
    ringFoam = max(ringFoam, k * fade);
    // radial speed streaks + bright disc inside the ring
    float ang = atan(dvec.y, dvec.x);
    float streak = smoothstep(0.75, 1.0, vnoise(vec2(ang * 90.0, d * 0.004 - age * 0.6)));
    ringGlow += (streak * 0.35 + 0.25) * (1.0 - smoothstep(rad * 0.2, rad, d)) * step(d, rad) * fade * r.w * 0.6;
  }
  col += uShallow * ringGlow;
  foam = max(foam, ringFoam);

  vec3 foamCol = vec3(1.25) * (0.8 + 0.2 * max(dot(N, uSunDir), 0.0));
  col = mix(col, foamCol, foam);

  float alpha = mix(0.55, 1.0, smoothstep(0.0, 4.5, depth));
  alpha = max(alpha, foam);
  alpha *= smoothstep(-1.5, 0.3, sd + 2.0); // never spill onto land

  gl_FragColor = vec4(applyAtmosphere(col, vWorldPos), alpha);
}
`;

/** The sea around the island (the finish line): stylized depth-tinted water. */
export class Ocean {
  constructor(ctx) {
    this.ctx = ctx;
    this.rings = [];
    this.ringCursor = 0;
  }

  init() {
    const { terrain, scene, atmosphere, bus } = this.ctx;
    const seaTex = getSeaFieldTexture(terrain);

    // camera-centred radial grid: dense near the viewer, reaching the far plane
    const K = 110;
    const S = 192;
    const pos = [];
    const idx = [];
    pos.push(0, 0, 0);
    for (let k = 1; k <= K; k++) {
      const r = Math.pow(k / K, 2.6);
      for (let s = 0; s < S; s++) {
        const a = (s / S) * Math.PI * 2;
        pos.push(Math.cos(a) * r, 0, Math.sin(a) * r);
      }
    }
    for (let s = 0; s < S; s++) idx.push(0, 1 + ((s + 1) % S), 1 + s);
    for (let k = 1; k < K; k++) {
      const a0 = 1 + (k - 1) * S;
      const b0 = 1 + k * S;
      for (let s = 0; s < S; s++) {
        const s1 = (s + 1) % S;
        idx.push(a0 + s, a0 + s1, b0 + s, a0 + s1, b0 + s1, b0 + s);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);

    const rings = [];
    for (let i = 0; i < MAX_RINGS; i++) rings.push(new THREE.Vector4(0, 0, 0, 0));
    this.ringUniform = rings;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        ...atmosphere.uniforms,
        ...terrainUniforms(terrain),
        ...envUniforms(),
        uSeaTex: { value: seaTex },
        uShallow: { value: new THREE.Color(0x3fd9e0) },
        uMid: { value: new THREE.Color(0x1aa0c8) },
        uDeep: { value: new THREE.Color(0x0a5c8f) },
        uLagoon: { value: new THREE.Color(0x8ff2e6) },
        uRings: { value: rings },
        uWTime: waterTime,
      },
      defines: {},
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: true,
    });
    syncEnv(this.material, atmosphere.envMap);

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -2; // first of the transparent water layers
    this.mesh.position.y = terrain.seaLevel;
    scene.add(this.mesh);

    bus.on('finished', ({ stream, place }) => this.shockwave(stream.pos.x, stream.pos.z, stream.isPlayer ? 1.0 : place === 1 ? 0.8 : 0.45));
  }

  /** White shockwave ring on the sea (victory / any stream reaching the sea). */
  shockwave(x, z, strength = 1) {
    const r = this.ringUniform[this.ringCursor++ % MAX_RINGS];
    r.set(x, z, waterTime.value, strength);
  }

  reset() {
    for (const r of this.ringUniform ?? []) r.w = 0;
  }

  update(dt, time) {
    waterTime.value = time;
    const cam = this.ctx.camera;
    const R = cam.far * 0.97;
    this.mesh.position.x = cam.position.x;
    this.mesh.position.z = cam.position.z;
    this.mesh.scale.set(R, 1, R);
    syncEnv(this.material, this.ctx.atmosphere.envMap);
  }
}
