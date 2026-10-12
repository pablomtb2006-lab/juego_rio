import * as THREE from 'three';
import { ATMOSPHERE_PARS_GLSL } from '../../render/shaderChunks.js';
import { NOISE_GLSL, TERRAIN_GLSL, terrainUniforms, waterTime } from '../water/waterCommon.js';
import { HAZARD_TYPES } from '../../game/Hazards.js';

/**
 * Draws game/Hazards.js: one instanced disc per hazard, laid on the real terrain (the vertex
 * shader samples the same height field the ground uses, so nothing floats or sinks), plus a
 * plume for erupting geysers. One draw call for the patches, one for the plumes.
 *
 * Each type is drawn procedurally from its index, so there are no textures to load:
 *   0 lava · 1 geyser · 2 sand · 3 sinkhole · 4 sun · 5 ice · 6 rocks · 7 steam
 */
const KIND_INDEX = Object.fromEntries(Object.keys(HAZARD_TYPES).map((k, i) => [k, i]));
const RING = 28; // disc tessellation
const RINGS = 5;

const VERT = /* glsl */ `
${TERRAIN_GLSL}
attribute vec4 iInfo;   // x,z, radius, kind
attribute vec2 iPhase;  // phase, period
varying vec2 vUv;
varying float vKind;
varying float vPhase;
varying float vPeriod;
varying vec3 vWorldPos;
void main() {
  vUv = position.xz;
  vKind = iInfo.w;
  vPhase = iPhase.x;
  vPeriod = iPhase.y;
  vec2 xz = iInfo.xy + position.xz * iInfo.z;
  // a hair above the ground so it never z-fights, and it follows every bump
  vec3 wp = vec3(xz.x, terrainHeight(xz) + 0.35, xz.y);
  vWorldPos = wp;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const FRAG = /* glsl */ `
${ATMOSPHERE_PARS_GLSL}
${NOISE_GLSL}
uniform float uWTime;
varying vec2 vUv;
varying float vKind;
varying float vPhase;
varying float vPeriod;
varying vec3 vWorldPos;

void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  int k = int(vKind + 0.5);
  float t = uWTime;
  vec2 p = vUv * 6.0;
  vec3 col = vec3(0.5);
  float a = 1.0 - smoothstep(0.78, 1.0, r);
  float glow = 0.0;

  if (k == 0) {
    // lava: dark crust split by glowing cracks that breathe
    vec2 vc = voronoi(p * 1.4 + vPhase);
    float crack = 1.0 - smoothstep(0.0, 0.14, vc.y - vc.x);
    float pulse = 0.7 + 0.3 * sin(t * 2.2 + vPhase);
    col = mix(vec3(0.12, 0.07, 0.06), vec3(2.6, 0.55, 0.12) * pulse, crack);
    col += vec3(1.6, 0.35, 0.05) * smoothstep(0.75, 0.2, r) * 0.45 * pulse;
    glow = crack * 0.8;
  } else if (k == 1) {
    // geyser: a scalded vent that flares white when it blows
    float burst = fract(t / max(vPeriod, 0.1) + vPhase);
    float live = burst > 0.72 ? smoothstep(0.72, 0.8, burst) : 0.0;
    float ring = 1.0 - smoothstep(0.25, 0.55, abs(r - 0.6));
    col = mix(vec3(0.28, 0.26, 0.24), vec3(0.75, 0.8, 0.85), ring);
    col += vec3(1.4, 1.6, 1.8) * live * (1.0 - smoothstep(0.0, 0.8, r));
    glow = live;
    a *= 0.55 + 0.45 * live;
  } else if (k == 2) {
    // dry sand: pale, grainy, drinks you dry
    float g = vnoise(p * 7.0 + vPhase) * 0.5 + fbm2(p * 2.0) * 0.5;
    col = mix(vec3(0.78, 0.68, 0.44), vec3(0.93, 0.86, 0.66), g);
    a *= 0.85;
  } else if (k == 3) {
    // sinkhole: a black throat with a crumbling lip
    float lip = 1.0 - smoothstep(0.55, 0.95, r);
    col = mix(vec3(0.30, 0.25, 0.20), vec3(0.02, 0.015, 0.01), lip);
    a *= 0.95;
  } else if (k == 4) {
    // scorching sun: a shimmering bright patch you can see through
    float sh = fbm2(p * 1.4 + vec2(t * 0.25, -t * 0.2));
    col = vec3(1.5, 1.15, 0.5) * (0.5 + sh * 0.6);
    a *= (0.16 + 0.2 * sh) * (1.0 - smoothstep(0.4, 1.0, r));
    glow = 0.5;
  } else if (k == 5) {
    // ice: pale blue facets, slick underfoot
    vec2 vc = voronoi(p * 1.1 + vPhase);
    float edge = 1.0 - smoothstep(0.0, 0.07, vc.y - vc.x);
    col = mix(vec3(0.62, 0.84, 0.97), vec3(0.95, 0.99, 1.0), edge);
    a *= 0.8;
  } else if (k == 6) {
    // rock debris: dull, speckled, it just gets in the way
    float g = step(0.62, vnoise(p * 9.0 + vPhase));
    col = mix(vec3(0.33, 0.30, 0.27), vec3(0.58, 0.54, 0.49), g);
    a *= 0.9;
  } else {
    // steam: a soft cloud sitting on the ground
    float n = fbm2(p * 1.2 + vec2(t * 0.3, t * 0.18));
    col = vec3(0.86, 0.9, 0.94);
    a *= (0.3 + 0.35 * n) * (1.0 - smoothstep(0.1, 1.0, r));
  }

  col = applyAtmosphere(col, vWorldPos);
  col += col * glow * 0.5;
  if (!(a > 0.01)) discard;
  gl_FragColor = vec4(col, a);
}
`;

export class HazardField {
  constructor(ctx) {
    this.ctx = ctx;
    this.group = new THREE.Group();
    this.group.name = 'hazards';
    this.version = -1;
  }

  init() {}

  build() {
    const { terrain, scene } = this.ctx;
    const cap = 300;
    // a flat disc in local space; the vertex shader puts it on the ground
    const pos = [0, 0, 0];
    const idx = [];
    for (let ring = 1; ring <= RINGS; ring++) {
      const rr = ring / RINGS;
      for (let i = 0; i < RING; i++) {
        const a = (i / RING) * Math.PI * 2;
        pos.push(Math.cos(a) * rr, 0, Math.sin(a) * rr);
      }
    }
    for (let i = 0; i < RING; i++) idx.push(0, 1 + ((i + 1) % RING), 1 + i);
    for (let ring = 1; ring < RINGS; ring++) {
      const a0 = 1 + (ring - 1) * RING;
      const b0 = 1 + ring * RING;
      for (let i = 0; i < RING; i++) {
        const j = (i + 1) % RING;
        idx.push(a0 + i, a0 + j, b0 + i, a0 + j, b0 + j, b0 + i);
      }
    }
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    this.info = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    this.phase = new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2);
    geo.setAttribute('iInfo', this.info);
    geo.setAttribute('iPhase', this.phase);
    geo.instanceCount = 0;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const mat = new THREE.ShaderMaterial({
      name: 'HazardField',
      uniforms: { ...this.ctx.atmosphere.uniforms, ...terrainUniforms(terrain), uWTime: waterTime },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.group.add(this.mesh);
    scene.add(this.group);
    this.cap = cap;
    this.built = true;
  }

  sync() {
    const hz = this.ctx.game?.hazards;
    if (!hz || hz.version === this.version) return;
    this.version = hz.version;
    const n = Math.min(hz.list.length, this.cap);
    for (let i = 0; i < n; i++) {
      const h = hz.list[i];
      this.info.setXYZW(i, h.x, h.z, h.radius, KIND_INDEX[h.kind] ?? 0);
      this.phase.setXY(i, h.phase / (Math.PI * 2), h.period);
    }
    this.info.needsUpdate = true;
    this.phase.needsUpdate = true;
    this.mesh.geometry.instanceCount = n;
  }

  update() {
    if (!this.built) {
      if (!this.ctx.game?.hazards) return;
      this.build();
    }
    this.sync();
  }
}
