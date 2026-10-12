import * as THREE from 'three';
import { EventBus } from './EventBus.js';
import { detectQuality } from './Quality.js';
import { params } from './debug.js';
import { Atmosphere } from '../render/Atmosphere.js';
import { PostFX } from '../render/PostFX.js';
import { TerrainData } from '../world/terrain/TerrainData.js';
import { World } from '../world/World.js';
import { Game } from '../game/Game.js';
import { UI } from '../ui/UI.js';
import { AudioSystem } from '../audio/Audio.js';
import { createServices } from '../services/index.js';

export const FIXED_DT = 1 / 60;

/**
 * Owns the renderer and the main loop, and builds the shared `ctx` object every
 * subsystem receives. Subsystem lifecycle (all optional except constructor):
 *   constructor(ctx)            — create objects, add to ctx.scene
 *   async init(onProgress)      — heavy work (generation, shader warm-up)
 *   fixedUpdate(dt)             — deterministic simulation step (game only)
 *   update(dt, time)            — per-frame visuals
 *   resize(w, h)
 */
export class Engine {
  constructor(container) {
    this.container = container;
    this.params = params;
    this.time = 0;
    this.accumulator = 0;
    this.running = false;
  }

  async init(onProgress = () => {}) {
    const quality = detectQuality(params.quality);
    const renderer = new THREE.WebGLRenderer({
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      preserveDrawingBuffer: params.capture,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.pixelRatio));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping; // tone mapping happens in PostFX
    renderer.shadowMap.enabled = quality.shadows;
    this.container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.5, quality.drawDistance * 1.5);

    const ctx = {
      engine: this,
      renderer,
      scene,
      camera,
      bus: new EventBus(),
      quality,
      params,
      time: 0,
      dt: 0,
    };
    this.ctx = ctx;
    window.__engine = this;

    onProgress(0.02, 'Preparando el cielo');
    ctx.services = createServices(ctx);
    ctx.atmosphere = new Atmosphere(ctx);
    await ctx.atmosphere.init?.();

    onProgress(0.05, 'Formando la isla');
    ctx.terrain = new TerrainData(ctx);
    await ctx.terrain.init((p, label) => onProgress(0.05 + p * 0.55, label ?? 'Formando la isla'));

    onProgress(0.6, 'Llenando lagos y bosques');
    ctx.world = new World(ctx);
    await ctx.world.init((p, label) => onProgress(0.6 + p * 0.25, label ?? 'Llenando lagos y bosques'));

    onProgress(0.85, 'Despertando a los rivales');
    ctx.audio = new AudioSystem(ctx);
    ctx.game = new Game(ctx);
    await ctx.game.init?.();
    ctx.ui = new UI(ctx);
    await ctx.ui.init?.();

    onProgress(0.92, 'Puliendo la luz');
    ctx.postfx = new PostFX(ctx);
    await ctx.postfx.init?.();

    window.addEventListener('resize', () => this.resize());
    this.resize();

    if (params.scene) await ctx.game.startScenario(params.scene);
    onProgress(1, 'Listo');
  }

  resize() {
    const { renderer, camera, postfx, ui } = this.ctx;
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    postfx?.resize?.(w, h);
    ui?.resize?.(w, h);
  }

  start() {
    if (params.capture) return; // driven by step() from tools/capture.mjs
    this.running = true;
    this.last = performance.now();
    const loop = (now) => {
      if (!this.running) return;
      requestAnimationFrame(loop);
      const dt = Math.min((now - this.last) / 1000, 0.1);
      this.last = now;
      this.frame(dt);
    };
    requestAnimationFrame(loop);
  }

  /** Advance the simulation by `frames` fixed steps and render once (capture mode). */
  step(frames = 1, render = true) {
    for (let i = 0; i < frames; i++) this.tick(FIXED_DT);
    if (render) this.render(FIXED_DT);
  }

  frame(dt) {
    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < 5) {
      this.ctx.game.fixedUpdate(FIXED_DT);
      this.accumulator -= FIXED_DT;
      steps++;
    }
    if (steps === 5) this.accumulator = 0;
    this.update(dt);
    this.render(dt);
  }

  tick(dt) {
    this.ctx.game.fixedUpdate(dt);
    this.update(dt);
  }

  update(dt) {
    const ctx = this.ctx;
    this.time += dt;
    ctx.time = this.time;
    ctx.dt = dt;
    ctx.game.update(dt, this.time);
    ctx.world.update(dt, this.time);
    ctx.atmosphere.update(dt, this.time);
    ctx.ui.update(dt, this.time);
    ctx.audio.update(dt, this.time);
    ctx.postfx?.update?.(dt);
  }

  render(dt) {
    this.ctx.postfx.render(dt);
  }
}
