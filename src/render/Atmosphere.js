import * as THREE from 'three';
import { SunLight } from 'three/addons/lights/SunLight.js';
import { FittedSunShadow } from './SunShadow.js';
import { createSky, createEnvSky } from './Sky.js';
import { CloudRenderer, generateCumulus } from './Clouds.js';
import { sampleTimeOfDay, MOODS } from './TimeOfDay.js';
import { FOG_PARS_VERTEX, FOG_VERTEX, FOG_PARS_FRAGMENT, FOG_FRAGMENT, SUN_CLOUD_SHADOW_GLSL } from './shaderChunks.js';
import { mulberry32 } from '../core/random.js';

const SUN_DISK_DEG = 1.15;
const VEC3_UNIFORMS = ['uSunDir', 'uSunColor', 'uSkyColor', 'uGroundColor', 'uFogColor', 'uCameraPos', 'uZenithColor', 'uHorizonColor', 'uSunGlow'];
const VEC4_UNIFORMS = ['uAtmoFog', 'uAtmoMisc', 'uCloudShadowParams', 'uCloudShadowParams2'];

/**
 * Sky, sun, lighting, shadows, environment, clouds and fog. Owns the shared atmosphere
 * uniforms (see shaderChunks.js). Contract:
 *   atmosphere.uniforms        — shared uniform objects (spread into ShaderMaterials)
 *   atmosphere.sun             — the sun light (three r186 SunLight: 2-cascade shadows; has
 *                                .color/.intensity/.position like a DirectionalLight, plus a
 *                                dummy .target for compatibility)
 *   atmosphere.sunDirection    — THREE.Vector3 towards the sun
 *   atmosphere.envMap          — PMREM texture of the sky (also scene.environment)
 *   atmosphere.setTimeOfDay(t, seconds?) — 0..1, 0.5 = noon; optional blend time
 *   atmosphere.setMood(name, seconds?)   — 'day' | 'menu' | 'victory' | 'dusk'
 *   atmosphere.update(dt, t)   — follows ctx.camera (shadow cascades, uniforms, clouds)
 *   atmosphere.clouds          — CloudRenderer (SkyWater adds its rain clouds here)
 *   atmosphere.state           — current sampled time-of-day state (colours, grade, exposure)
 * Moods switch automatically from bus events (menu → late afternoon, match → day,
 * win → golden hour) unless `atmosphere.autoMood = false`.
 */
const _tint = new THREE.Color();

export class Atmosphere {
  constructor(ctx) {
    this.ctx = ctx;
    const { scene, renderer, quality } = ctx;
    this.autoMood = true;
    this.sunDirection = new THREE.Vector3(0.45, 0.55, 0.35).normalize();

    this.uniforms = {
      uSunDir: { value: this.sunDirection },
      uSunColor: { value: new THREE.Color(1.0, 0.92, 0.8) },
      uSkyColor: { value: new THREE.Color(0.45, 0.65, 1.0) },
      uGroundColor: { value: new THREE.Color(0.35, 0.3, 0.22) },
      uFogColor: { value: new THREE.Color(0.62, 0.76, 0.92) },
      uFogDensity: { value: 0.00012 },
      uFogHeightFalloff: { value: 0.001 },
      uCameraPos: { value: new THREE.Vector3() },
      uTime: { value: 0 },
      uZenithColor: { value: new THREE.Color() },
      uHorizonColor: { value: new THREE.Color() },
      uSunGlow: { value: new THREE.Color() },
      uAtmoFog: { value: new THREE.Vector4() },
      uAtmoMisc: { value: new THREE.Vector4() },
      uCloudShadowParams: { value: new THREE.Vector4() },
      uCloudShadowParams2: { value: new THREE.Vector4() },
      uCloudShadowMap: { value: null },
      // sky only
      uNight: { value: 0 },
      uCirrusColor: { value: new THREE.Color(1, 1, 1) },
    };

    // --- fog for built-in materials -------------------------------------------------
    scene.fog = new THREE.FogExp2(0x9ec2e6, 0.00009);
    this.builtin = this.createBuiltinUniforms();
    this.patchBuiltinChunks();

    // --- renderer -------------------------------------------------------------------
    // r186 removed PCFSoftShadowMap: hardware PCF + Vogel disk (5 taps × 4) is the soft option
    renderer.shadowMap.type = THREE.PCFShadowMap;

    // --- lights -----------------------------------------------------------------------
    this.hemi = new THREE.HemisphereLight(0xbfdcff, 0x5a4a32, 0.4);
    scene.add(this.hemi);

    this.sun = new SunLight(0xfff0dd, 3.2);
    this.sun.name = 'Sun';
    this.sun.shadow = new FittedSunShadow();
    this.sun.target = new THREE.Object3D(); // compatibility with DirectionalLight users
    this.sun.castShadow = !!quality.shadows;
    const sms = quality.shadowMapSize ?? 2048;
    this.sun.shadow.mapSize.set(sms, sms);
    this.sun.shadow.radius = quality.shadowSoftness ?? 2.2;
    this.sun.shadow.bias = -0.0002;
    this.sun.shadow.normalBias = 0.6;
    this.sun.shadow.camera.near = 1;
    this.shadowDistance = quality.shadowDistance ?? 1400;
    scene.add(this.sun);

    // --- sky + clouds ------------------------------------------------------------------
    this.sky = createSky(this.uniforms);
    scene.add(this.sky);

    this.clouds = new CloudRenderer(this.uniforms, { maxPuffs: 4096 });
    scene.add(this.clouds.mesh);
    this.buildCloudField();

    // --- environment (PMREM of the sky) -----------------------------------------------
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envScene = new THREE.Scene();
    this.envScene.add(createEnvSky(this.uniforms));
    this.envMap = null;
    this.envRT = null;
    this.envDirty = true;
    this.envTimer = 0;

    // --- time of day ---------------------------------------------------------------------
    this.state = {};
    this.tod = MOODS.menu;
    this.todFrom = this.tod;
    this.todTarget = this.tod;
    this.todBlend = 1;
    this.todDuration = 0;
    this.applyTimeOfDay(this.tod);
    this.updateEnvironment();

    ctx.bus?.on('phase', ({ state }) => {
      if (!this.autoMood) return;
      if (state === 'menu') {
        this.setMood('menu', 1.5);
        this.restoreColumn();
      } else if (state === 'drop') {
        this.setTimeOfDay(ctx.game?.biome?.tod ?? MOODS.day, 2);
        const p = ctx.game?.player;
        if (p) this.clearColumn(p.pos.x, p.pos.z, 900);
      } else if (state === 'stream') this.setTimeOfDay(ctx.game?.biome?.tod ?? MOODS.day, 2);
    });
    ctx.bus?.on('matchEnd', ({ outcome }) => {
      if (!this.autoMood) return;
      if (outcome === 'win') this.setMood('victory', 2.2);
    });
  }

  // ---------------------------------------------------------------------------------
  // Built-in material integration
  // ---------------------------------------------------------------------------------

  /**
   * Uniform entries injected into every THREE.ShaderLib shader (and UniformsLib.fog).
   * Values are plain {x,y,z(,w)} objects: three clones THREE.Vector/Color uniform values per
   * material but copies plain objects by reference, so one write here reaches every
   * MeshStandardMaterial/MeshLambertMaterial/... in the scene.
   */
  createBuiltinUniforms() {
    const u = {};
    for (const name of VEC3_UNIFORMS) u[name] = { value: { x: 0, y: 0, z: 0 } };
    for (const name of VEC4_UNIFORMS) u[name] = { value: { x: 0, y: 0, z: 0, w: 0 } };
    this.cloudShadowTexture = new THREE.DataTexture(new Uint8Array(4), 2, 2, THREE.RedFormat);
    this.cloudShadowTexture.needsUpdate = true;
    u.uCloudShadowMap = { value: this.cloudShadowTexture };
    for (const id of Object.keys(THREE.ShaderLib)) {
      const sh = THREE.ShaderLib[id];
      if (sh.uniforms && 'fogColor' in sh.uniforms) Object.assign(sh.uniforms, u);
    }
    Object.assign(THREE.UniformsLib.fog, u);
    return u;
  }

  patchBuiltinChunks() {
    const C = THREE.ShaderChunk;
    if (C.__rioPatched) return;
    C.fog_pars_vertex = FOG_PARS_VERTEX;
    C.fog_vertex = FOG_VERTEX;
    C.fog_pars_fragment = FOG_PARS_FRAGMENT;
    C.fog_fragment = FOG_FRAGMENT;
    const anchor = 'getSunLightInfo( sunLight, directLight );';
    if (C.lights_fragment_begin.includes(anchor)) {
      C.lights_fragment_begin = C.lights_fragment_begin.replace(anchor, `${anchor}\n${SUN_CLOUD_SHADOW_GLSL}`);
    }
    C.__rioPatched = true;
  }

  syncBuiltinUniforms() {
    const b = this.builtin;
    for (const name of VEC3_UNIFORMS) {
      const src = this.uniforms[name].value;
      const dst = b[name].value;
      if (src.isColor) {
        dst.x = src.r;
        dst.y = src.g;
        dst.z = src.b;
      } else {
        dst.x = src.x;
        dst.y = src.y;
        dst.z = src.z;
      }
    }
    for (const name of VEC4_UNIFORMS) {
      const src = this.uniforms[name].value;
      const dst = b[name].value;
      dst.x = src.x;
      dst.y = src.y;
      dst.z = src.z;
      dst.w = src.w;
    }
  }

  // ---------------------------------------------------------------------------------
  // Clouds
  // ---------------------------------------------------------------------------------

  buildCloudField() {
    const q = this.ctx.quality;
    const density = q.clouds ?? 1;
    const rand = mulberry32((this.ctx.params?.seed ?? 7) * 7919 + 13);
    const island = 12000; // TerrainData.size (terrain is built after the atmosphere)
    const field = 32000;
    this.clouds.fieldSize = field;
    const placed = [];
    const tryPlace = (rMin, rMax, n, sizeMin, sizeMax, baseMin, baseMax) => {
      let tries = 0;
      let count = 0;
      while (count < n && tries < n * 60) {
        tries++;
        const a = rand() * Math.PI * 2;
        const r = rMin + Math.sqrt(rand()) * (rMax - rMin);
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        const w = sizeMin + rand() * (sizeMax - sizeMin);
        if (placed.some((p) => Math.hypot(p.x - x, p.z - z) < (p.w + w) * 0.62)) continue;
        placed.push({ x, z, w });
        const kind = rand();
        let h;
        let towers;
        if (kind < 0.25) {
          h = w * (0.7 + rand() * 0.25); // towering cumulus
          towers = 2 + Math.floor(rand() * 2);
        } else if (kind < 0.7) {
          h = w * (0.42 + rand() * 0.2);
          towers = rand() < 0.6 ? 1 : 0;
        } else {
          h = w * (0.26 + rand() * 0.1); // flatter fair-weather cumulus
          towers = 0;
        }
        const shape = generateCumulus(rand, {
          width: w,
          height: Math.min(h, 1500),
          depth: w * (0.65 + rand() * 0.3),
          count: Math.round(Math.min(Math.max(w / 32, 16), 56) * density),
          towers,
        });
        this.clouds.addCloud({ x, y: baseMin + rand() * (baseMax - baseMin), z, ...shape, style: 0, drift: true });
        count++;
      }
    };
    // over the island: medium cumulus around the drop altitude (you fall past / through them)
    tryPlace(0, island * 0.55, Math.round(15 * Math.min(density, 1.2)), 600, 1500, 1850, 2450);
    // outer ring: big towering cumulus framing the horizon
    tryPlace(island * 0.72, field * 0.5, Math.round(28 * Math.min(density, 1.2)), 1200, 3200, 1250, 2200);

    const tex = this.clouds.buildShadowMap(256);
    this.cloudShadowTexture.image = tex.image;
    this.cloudShadowTexture.format = THREE.RedFormat;
    this.cloudShadowTexture.wrapS = this.cloudShadowTexture.wrapT = THREE.RepeatWrapping;
    this.cloudShadowTexture.magFilter = this.cloudShadowTexture.minFilter = THREE.LinearFilter;
    this.cloudShadowTexture.generateMipmaps = false;
    this.cloudShadowTexture.needsUpdate = true;
    this.uniforms.uCloudShadowMap.value = this.cloudShadowTexture;
    this.cloudLayerHeight = 2250;
  }

  /** Hide drifting cumulus that sit in a vertical column (keeps the drop readable). */
  clearColumn(x, z, radius) {
    const p = new THREE.Vector3();
    for (const c of this.clouds.clouds) {
      if (!c.drift) continue;
      this.clouds.cloudPosition(c, p);
      const r = radius + c.width * 0.5;
      c.hiddenTarget = Math.hypot(p.x - x, p.z - z) < r ? 0 : 1;
    }
  }

  restoreColumn() {
    for (const c of this.clouds.clouds) c.hiddenTarget = 1;
  }

  // ---------------------------------------------------------------------------------
  // Time of day
  // ---------------------------------------------------------------------------------

  setTimeOfDay(t, seconds = 0) {
    this.todFrom = this.tod;
    this.todTarget = t;
    this.todDuration = seconds;
    this.todBlend = seconds > 0 ? 0 : 1;
    if (seconds <= 0) this.applyTimeOfDay(t);
  }

  setMood(name, seconds = 0) {
    const t = MOODS[name];
    if (t === undefined || Math.abs(t - this.todTarget) < 1e-4) return;
    this.setTimeOfDay(t, seconds);
  }

  applyTimeOfDay(t) {
    this.tod = t;
    const s = sampleTimeOfDay(t, this.state);
    // el bioma de la partida (game/biomes.js): the sky, the fog and the haze are pulled toward
    // the biome's colour, so a frozen island does not sit under a summer sky
    const b = this.ctx.game?.biome;
    if (b?.tintAmt) {
      _tint.set(b.tint);
      const k = b.tintAmt * 0.55;
      for (const key of ['fog', 'horizon', 'zenith', 'glow', 'skyAmb', 'groundAmb']) s[key]?.lerp(_tint, k);
      s.sunI *= b.bright ?? 1;
      if (b.sat !== undefined) s.grade.sat *= 0.45 + 0.55 * b.sat;
    }
    const u = this.uniforms;
    const el = THREE.MathUtils.degToRad(s.elev);
    const az = THREE.MathUtils.degToRad(s.az);
    // during the night the "sun" light is the moon, opposite-ish and high
    const night = THREE.MathUtils.smoothstep(-s.elev, 2, 12);
    const lightEl = s.elev > 2 ? el : THREE.MathUtils.lerp(el, THREE.MathUtils.degToRad(35), night);
    this.sunDirection.set(Math.cos(lightEl) * Math.cos(az), Math.sin(lightEl), Math.cos(lightEl) * Math.sin(az)).normalize();
    // the sky's sun disk follows the real sun (below the horizon at night)
    this.skySunDir = this.skySunDir ?? new THREE.Vector3();
    this.skySunDir.set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)).normalize();

    const sunI = s.sunI;
    this.sun.color.copy(s.sun);
    this.sun.intensity = sunI;
    this.sun.position.copy(this.sunDirection);
    // never toggle castShadow/visible at runtime (that recompiles every material): fade instead
    this.sun.shadow.intensity = THREE.MathUtils.smoothstep(this.sunDirection.y, 0.02, 0.14);

    this.hemi.color.copy(s.skyAmb);
    this.hemi.groundColor.copy(s.groundAmb);
    this.hemi.intensity = s.hemiI;
    this.ctx.scene.environmentIntensity = s.env;

    u.uSunColor.value.copy(s.sun).multiplyScalar(sunI / Math.PI);
    u.uSkyColor.value.copy(s.skyAmb).multiplyScalar(0.55 * s.env + 0.35 * s.hemiI);
    u.uGroundColor.value.copy(s.groundAmb).multiplyScalar(0.55 * s.env + 0.35 * s.hemiI);
    u.uZenithColor.value.copy(s.zenith);
    u.uHorizonColor.value.copy(s.horizon);
    u.uFogColor.value.copy(s.fog);
    u.uSunGlow.value.copy(s.glow).multiplyScalar(s.glowI);
    u.uFogDensity.value = s.density;
    u.uFogHeightFalloff.value = 1 / s.falloff;
    u.uAtmoFog.value.set(s.density, 1 / s.falloff, 0, 0.93);
    u.uAtmoMisc.value.x = s.aerial;
    u.uAtmoMisc.value.z = Math.cos(THREE.MathUtils.degToRad(SUN_DISK_DEG));
    u.uNight.value = night;
    u.uCirrusColor.value.copy(s.cloudLit).lerp(s.horizon, 0.35);
    this.ctx.scene.fog.color.copy(s.fog);
    this.ctx.scene.fog.density = Math.sqrt(s.density * 0.6);

    // cloud palette (rain clouds: denser, blue-grey, a touch of cyan — they're pickups)
    this.cloudColors ??= { lit: new THREE.Color(), shade: new THREE.Color(), rainLit: new THREE.Color(), rainShade: new THREE.Color() };
    const cc = this.cloudColors;
    const sunScale = 0.55 + 0.45 * Math.min(sunI / 3.3, 1.1);
    cc.lit.copy(s.cloudLit).multiplyScalar(1.18 * sunScale);
    cc.shade.copy(s.cloudShade).multiplyScalar(0.92);
    cc.rainLit.copy(s.cloudLit).multiply(_tmpC.setRGB(0.7, 0.78, 0.92)).multiplyScalar(1.05 * sunScale);
    cc.rainShade.copy(s.cloudShade).multiply(_tmpC.setRGB(0.5, 0.58, 0.74));

    this.envDirty = true;
  }

  // ---------------------------------------------------------------------------------
  // Environment map
  // ---------------------------------------------------------------------------------

  updateEnvironment() {
    const size = this.ctx.quality.envMapSize ?? 128;
    // the env sky uses the real sun direction for its glow
    const prev = this.uniforms.uSunDir.value;
    this.uniforms.uSunDir.value = this.skySunDir ?? prev;
    const rt = this.pmrem.fromScene(this.envScene, 0, 0.1, 10, { size });
    this.uniforms.uSunDir.value = prev;
    const old = this.envRT;
    this.envRT = rt;
    this.envMap = rt.texture;
    this.ctx.scene.environment = this.envMap;
    old?.dispose();
    this.envDirty = false;
  }

  // ---------------------------------------------------------------------------------
  // Per frame
  // ---------------------------------------------------------------------------------

  update(dt, time) {
    const ctx = this.ctx;
    const cam = ctx.camera;
    const u = this.uniforms;

    // time-of-day transitions (sweeps the sun across the sky: cinematic time-lapse)
    if (this.todBlend < 1) {
      this.todBlend = Math.min(1, this.todBlend + dt / Math.max(this.todDuration, 1e-3));
      const f = this.todBlend * this.todBlend * (3 - 2 * this.todBlend);
      this.applyTimeOfDay(this.todFrom + (this.todTarget - this.todFrom) * f);
    }

    u.uCameraPos.value.copy(cam.position);
    u.uTime.value = time;
    u.uAtmoMisc.value.y = 1 / cam.far;
    u.uAtmoMisc.value.w = time;

    // shadows: fit both cascades to what the camera can actually see
    const terrain = ctx.terrain;
    const ground = terrain?.heightAt ? Math.max(terrain.heightAt(cam.position.x, cam.position.z), terrain.seaLevel ?? 0) : 0;
    const above = Math.max(cam.position.y - ground, 1);
    const sh = this.sun.shadow;
    sh.nearDistance = Math.max(cam.near, above * 0.55 - 30);
    const maxD = this.shadowDistance;
    sh.maxDistance = Math.min(Math.max(maxD, above * 4.2), maxD * 11);
    sh.lambda = above > 400 ? 0.55 : 0.82;
    sh.casterHeight = Math.max(1600, above * 0.5);
    // dummy target kept in front of the light for code that reads it
    this.sun.target.position.copy(cam.position);
    this.sun.updateMatrixWorld();

    // clouds: fade cleared columns, drift, sort, palette
    for (const c of this.clouds.clouds) {
      if (c.hiddenTarget === undefined) continue;
      c.alpha += (c.hiddenTarget - c.alpha) * (1 - Math.exp(-dt * 2.5));
      c.visible = c.alpha > 0.01;
    }
    this.clouds.update(dt, cam, this.cloudColors);
    // draw order: above the cloud base the clouds are in front of the water, below behind it
    this.clouds.mesh.renderOrder = cam.position.y > this.cloudLayerHeight - 500 ? 50 : -50;
    this.cloudVeil = this.clouds.veil;

    // cloud shadows on the ground (drift with the cumulus)
    const field = this.clouds.fieldSize;
    const sunUp = THREE.MathUtils.smoothstep(this.sunDirection.y, 0.05, 0.25);
    u.uCloudShadowParams.value.set(this.clouds.drift.x, this.clouds.drift.y, 1 / field, (this.ctx.quality.cloudShadows ?? 0.55) * sunUp);
    u.uCloudShadowParams2.value.set(this.cloudLayerHeight, 0, 0, 0);

    this.syncBuiltinUniforms();

    // environment: re-bake while the light changes (throttled)
    this.envTimer -= dt;
    if (this.envDirty && this.envTimer <= 0) {
      this.updateEnvironment();
      this.envTimer = 0.35;
    }
  }
}

const _tmpC = new THREE.Color();
