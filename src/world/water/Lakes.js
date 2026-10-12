import * as THREE from 'three';
import { ATMOSPHERE_PARS_GLSL } from '../../render/shaderChunks.js';
import { NOISE_GLSL, LIGHT_GLSL, envUniforms, syncEnv, waterTime } from './waterCommon.js';

/**
 * Still water you can swallow (lakes + puddles). Contract used by game/Rules.js:
 *   lakes.bodies: [{ id, kind: 'lake'|'puddle', x, y, z, radius, volume, maxVolume, drainedBy }]
 *     (x, y, z) = centre of the water surface (y = CURRENT surface height); radius in metres; volume in litres.
 *   lakes.drain(body, litres) -> litres actually removed (also animates the surface).
 *   lakes.reset() refills everything for a new match.
 * A body is "empty" when volume <= 0; the renderer shows it as a wet lakebed that dries.
 *
 * Rendering: each body is a polar grid that conforms to the terrain. Vertices below the water
 * level sit on the (flat) surface, the others lie on the ground, so a single mesh draws the
 * real basin shoreline, the foam contact line, the wet shore and — once drained — the muddy bed.
 */

const VERT = /* glsl */ `
attribute float aTerrainH;
uniform float uLevel;
uniform float uRadius;
uniform float uDrain;
uniform vec2 uVortex;
uniform float uWTime;
varying vec3 vWorldPos;
varying float vTerrainH;
varying float vWaterY;
varying vec2 vLocal;

void main() {
  vec2 local = position.xz;
  float r = length(local) / uRadius;
  vec2 dv = local - uVortex;
  float funnelR = uRadius * 0.35;
  float funnel = uDrain * min(uRadius * 0.06, 4.0) * exp(-dot(dv, dv) / (funnelR * funnelR));
  float water = uLevel - funnel;
  float inside = step(r, 1.12);
  float y = inside > 0.5 ? max(water, aTerrainH + 0.15) : aTerrainH + 0.15;
  vec4 wp = modelMatrix * vec4(local.x, y, local.y, 1.0);
  vWorldPos = wp.xyz;
  vTerrainH = aTerrainH;
  vWaterY = water;
  vLocal = local;
  vec4 mv = viewMatrix * wp;
  float d = length(mv.xyz);
  mv.xyz *= 1.0 - min((0.3 + d * 0.0025) / d, 0.5); // pull towards the camera: wins vs terrain LOD
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
${ATMOSPHERE_PARS_GLSL}
${NOISE_GLSL}
${LIGHT_GLSL}
uniform float uWTime;
uniform float uLevel;
uniform float uFullLevel;
uniform float uRadius;
uniform float uDrain;
uniform float uDry;
uniform float uSeed;
uniform vec2 uVortex;
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform vec3 uMud;
varying vec3 vWorldPos;
varying float vTerrainH;
varying float vWaterY;
varying vec2 vLocal;

void main() {
  float t = uWTime;
  vec2 xz = vWorldPos.xz;
  vec3 toCam = uCameraPos - vWorldPos;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  float fp = max(length(fwidth(xz)), 1e-3);
  float r = length(vLocal) / uRadius;
  float edgeN = fbm2(vLocal * (3.0 / uRadius) + uSeed);
  float basin = 1.0 - smoothstep(0.92, 1.08, r + (edgeN - 0.5) * 0.18);
  float depth = vWaterY - vTerrainH;

  // ---- whirlpool frame
  vec2 dv = vLocal - uVortex;
  float vr = length(dv);
  float ang = atan(dv.y, dv.x);
  float swirl = uDrain * 6.0 / (1.0 + vr * 0.12);
  float ca = cos(swirl * t * 0.3), sa = sin(swirl * t * 0.3);

  // ---- ripples
  vec2 p = xz;
  vec3 n1 = gnoised(p * 0.18 + vec2(t * 0.12, t * 0.07));
  vec3 n2 = gnoised(p * 0.55 + vec2(-t * 0.25, t * 0.21));
  float f1 = 1.0 - smoothstep(1.5, 10.0, fp);
  float f2 = 1.0 - smoothstep(0.4, 2.5, fp);
  vec2 g = n1.yz * 0.18 * 0.12 * f1 + n2.yz * 0.55 * 0.035 * f2;
  // radial pull + tangential swirl slope while draining
  vec2 tang = vec2(-dv.y, dv.x) / max(vr, 1e-3);
  g += uDrain * (dv / max(vr, 1e-3)) * 0.25 * exp(-vr / (uRadius * 0.4));
  g += uDrain * tang * sin(ang * 3.0 + log(vr + 1.0) * 5.0 - t * 7.0) * 0.12;
  vec3 N = normalize(vec3(-g.x, 1.0, -g.y));
  float NdV = max(dot(N, V), 0.0);

  // ---- water colour
  vec3 col = mix(uShallow, uDeep, smoothstep(0.2, 6.0, depth));
  col = mix(col, uDeep * 0.55, uDrain * exp(-vr / (uRadius * 0.18))); // dark throat of the whirlpool
  col *= waterBodyLight(N);
  vec3 R = reflect(-V, N);
  float F = min(fresnelSchlick(NdV, 0.04), 0.7);
  col = mix(col, skyReflection(R, 0.1), F);
  col += sunSpecular(N, V, 700.0, 50.0);
  col += uSunColor * sunGlints(xz, 1.4, N, V, t) * 8.0 * f2;

  // ---- foam: contact line + whirlpool spiral arms
  float fn = vnoise(xz * 0.35 + vec2(t * 0.2, -t * 0.15));
  float contact = 1.0 - aastep(0.35 + fn * 0.45 + fp * 0.8, depth);
  float spiral = sin(ang * 3.0 + log(vr + 1.0) * 6.0 - t * (4.0 + 8.0 * uDrain));
  float arms = aastep(0.55, spiral * 0.5 + 0.5 + (fn - 0.5) * 0.5) * uDrain * (1.0 - smoothstep(uRadius * 0.15, uRadius * 0.9, vr));
  float foam = max(contact, arms * 0.9);
  // churn ring around the throat
  foam = max(foam, uDrain * smoothstep(0.5, 0.8, fn) * (1.0 - smoothstep(0.0, uRadius * 0.25, abs(vr - uRadius * 0.12))));
  col = mix(col, vec3(1.22, 1.3, 1.36), foam);

  float waterA = aastep(0.0, depth) * basin;
  float alphaW = mix(0.55, 0.95, smoothstep(0.1, 3.0, depth));
  alphaW = max(alphaW, foam);

  // ---- ground under / around the water: wet shore when full, muddy bed when drained
  float exposedBed = step(vTerrainH, uFullLevel + 0.05) * basin;
  vec2 cr = voronoi(xz * 0.35 + uSeed);
  float cracks = 1.0 - smoothstep(0.0, 0.08, cr.y - cr.x);
  vec3 mud = uMud * waterBodyLight(vec3(0.0, 1.0, 0.0)) * 0.9;
  vec3 dryMud = mix(uMud * 2.2, vec3(0.62, 0.55, 0.44), 0.4) * waterBodyLight(vec3(0.0, 1.0, 0.0));
  vec3 bed = mix(mud, dryMud, uDry);
  bed = mix(bed, bed * 0.55, cracks * uDry * f2);
  // glossy wet sheen + leftover puddles in the bed
  float puddle = smoothstep(0.55, 0.7, vnoise(xz * 0.08 + uSeed)) * (1.0 - uDry);
  float gloss = (1.0 - uDry) * 0.6 + puddle * 0.4;
  bed = mix(bed, skyReflection(reflect(-V, vec3(0, 1, 0)), 0.3) * 0.7, gloss * fresnelSchlick(V.y, 0.06));
  bed += sunSpecular(normalize(vec3(n2.y * 0.05, 1.0, n2.z * 0.05)), V, 300.0, 30.0) * gloss * 0.5;
  float bedA = exposedBed * mix(0.85, 0.55, uDry);
  float shoreH = vTerrainH - uFullLevel;
  float wetShore = (1.0 - smoothstep(0.0, 1.6 + fn, shoreH)) * step(0.0, shoreH) * basin;
  vec3 shoreCol = mud * 0.8;
  float shoreA = wetShore * 0.35;

  vec3 groundCol = exposedBed > 0.5 ? bed : shoreCol;
  float groundA = max(bedA, shoreA);
  vec3 outCol = mix(groundCol, col, waterA);
  float outA = mix(groundA, alphaW, waterA);
  if (outA < 0.004) discard;
  gl_FragColor = vec4(applyAtmosphere(outCol, vWorldPos), outA);
}
`;

export class Lakes {
  constructor(ctx) {
    this.ctx = ctx;
    this.bodies = [];
    this.group = new THREE.Group();
    ctx.scene.add(this.group);
  }

  init() {
    const { terrain, atmosphere } = this.ctx;
    const sites = [
      ...terrain.lakeSites.map((s) => ({ ...s, kind: 'lake' })),
      ...terrain.puddleSites.map((s) => ({ ...s, kind: 'puddle' })),
    ];
    sites.forEach((s, id) => {
      const extent = s.radius * 1.2;
      const rings = s.kind === 'lake' ? 36 : 18;
      const segs = s.kind === 'lake' ? 84 : 44;
      const pos = [0, 0, 0];
      const th = [terrain.heightAt(s.x, s.z)];
      let bed = th[0];
      for (let k = 1; k <= rings; k++) {
        const rr = extent * Math.pow(k / rings, 0.85);
        for (let j = 0; j < segs; j++) {
          const a = (j / segs) * Math.PI * 2;
          const lx = Math.cos(a) * rr;
          const lz = Math.sin(a) * rr;
          const h = terrain.heightAt(s.x + lx, s.z + lz);
          pos.push(lx, 0, lz);
          th.push(h);
          if (rr <= s.radius) bed = Math.min(bed, h);
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
      geo.setAttribute('aTerrainH', new THREE.Float32BufferAttribute(th, 1));
      geo.setIndex(idx);
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, s.level, 0), extent + 30);

      const mat = new THREE.ShaderMaterial({
        uniforms: {
          ...atmosphere.uniforms,
          ...envUniforms(),
          uWTime: waterTime,
          uLevel: { value: s.level },
          uFullLevel: { value: s.level },
          uRadius: { value: s.radius },
          uDrain: { value: 0 },
          uDry: { value: 0 },
          uSeed: { value: id * 7.31 },
          uVortex: { value: new THREE.Vector2() },
          uShallow: { value: new THREE.Color(0x35d0d6) },
          uDeep: { value: new THREE.Color(0x0b6e8a) },
          uMud: { value: new THREE.Color(0x2e2519) },
        },
        defines: {},
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
      });
      syncEnv(mat, atmosphere.envMap);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(s.x, 0, s.z);
      mesh.renderOrder = -1;
      this.group.add(mesh);
      bed = Math.min(bed, s.level - 0.5);
      this.bodies.push({
        id,
        kind: s.kind,
        x: s.x,
        y: s.level,
        z: s.z,
        radius: s.radius,
        volume: s.volume,
        maxVolume: s.volume,
        drainedBy: null,
        mesh,
        // render state (not part of the contract)
        fullLevel: s.level,
        bedLevel: bed,
        visLevel: s.level,
        swirl: 0,
        lastDrainAt: -1e9,
        emptiedAt: -1,
        vortex: new THREE.Vector2(),
      });
    });
  }

  /** Remove up to `litres`; lowers the body's current surface (body.y). */
  drain(body, litres) {
    const taken = Math.min(body.volume, litres);
    if (taken <= 0) return 0;
    body.volume -= taken;
    const f = Math.max(0, body.volume / body.maxVolume);
    body.y = body.bedLevel + (body.fullLevel - body.bedLevel) * Math.sqrt(f);
    body.lastDrainAt = this.ctx.time ?? 0;
    if (body.volume <= 0) body.emptiedAt = this.ctx.time ?? 0;
    return taken;
  }

  reset() {
    for (const b of this.bodies) {
      b.volume = b.maxVolume;
      b.drainedBy = null;
      b.y = b.fullLevel;
      b.visLevel = b.fullLevel;
      b.swirl = 0;
      b.lastDrainAt = -1e9;
      b.emptiedAt = -1;
    }
  }

  update(dt, time) {
    waterTime.value = time;
    const env = this.ctx.atmosphere.envMap;
    for (const b of this.bodies) {
      const u = b.mesh.material.uniforms;
      // the level eases towards the true surface so a 1-second swallow reads as a drain
      b.visLevel += (b.y - b.visLevel) * (1 - Math.exp(-dt * 2.5));
      const draining = time - b.lastDrainAt < 0.35 && b.volume > 0;
      const target = draining ? 1 : 0;
      b.swirl += (target - b.swirl) * (1 - Math.exp(-dt * (draining ? 4 : 1.2)));
      if (b.drainedBy) {
        const s = b.drainedBy;
        const dx = s.pos.x - b.x;
        const dz = s.pos.z - b.z;
        const d = Math.hypot(dx, dz) || 1;
        const off = Math.min(d * 0.3, b.radius * 0.35);
        b.vortex.set((dx / d) * off, (dz / d) * off);
      }
      u.uLevel.value = b.visLevel;
      u.uDrain.value = b.swirl;
      u.uVortex.value.copy(b.vortex);
      u.uDry.value = b.emptiedAt >= 0 ? Math.min(1, (time - b.emptiedAt) / 9) : 0;
      syncEnv(b.mesh.material, env);
    }
  }
}
