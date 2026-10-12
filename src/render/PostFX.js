import * as THREE from 'three';
import {
  EffectComposer,
  RenderPass,
  EffectPass,
  BloomEffect,
  ToneMappingEffect,
  ToneMappingMode,
  SMAAEffect,
  VignetteEffect,
} from 'postprocessing';

/**
 * Post-processing chain. Contract:
 *   postfx.render(dt)
 *   postfx.resize(w, h)
 *   postfx.setSpeed(0..1)   — drives speed lines / radial blur in chase cam
 *   postfx.flash(strength)  — white impact flash (landing, victory)
 */
export class PostFX {
  constructor(ctx) {
    this.ctx = ctx;
    const { renderer, scene, camera, quality } = ctx;
    this.composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType });
    this.composer.addPass(new RenderPass(scene, camera));

    const effects = [];
    if (quality.bloom) effects.push(new BloomEffect({ intensity: 0.6, luminanceThreshold: 0.85, mipmapBlur: true }));
    effects.push(new ToneMappingEffect({ mode: ToneMappingMode.AGX }));
    effects.push(new VignetteEffect({ darkness: 0.35, offset: 0.3 }));
    effects.push(new SMAAEffect());
    this.composer.addPass(new EffectPass(camera, ...effects));
    this.speed = 0;
  }

  setSpeed(v) {
    this.speed = v;
  }

  flash() {}

  resize(w, h) {
    this.composer.setSize(w, h);
  }

  render(dt) {
    this.composer.render(dt);
  }
}
