import * as THREE from 'three';
import {
  EffectComposer,
  RenderPass,
  EffectPass,
  BloomEffect,
  BlendFunction,
  SMAAEffect,
  SMAAPreset,
  EdgeDetectionMode,
  FXAAEffect,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import { SpeedEffect, GradeEffect } from './effects.js';

/**
 * Post-processing chain (pmndrs/postprocessing, HalfFloat HDR buffers):
 *   RenderPass → [N8AO] → EffectPass(speed blur/CA, bloom, AgX tone map + grade + vignette
 *   + speed lines + flash) → EffectPass(SMAA | FXAA) on the display-referred image.
 * Contract:
 *   postfx.render(dt)
 *   postfx.resize(w, h)
 *   postfx.setSpeed(0..1)   — drives speed lines / radial blur in chase cam
 *   postfx.flash(strength)  — white impact flash (landing, victory), fast decay
 * Extras: postfx.pulse(strength, color?) — edge glow (absorbing water),
 *         postfx.composer, postfx.ao (N8AOPostPass | null), postfx.grade (GradeEffect).
 * Listens to the bus for the player's 'landed' / 'finished' / 'absorb' to self-trigger
 * flash and pulse; the exposure and grade follow ctx.atmosphere.state (time of day).
 */
export class PostFX {
  constructor(ctx) {
    this.ctx = ctx;
    const { renderer, scene, camera, quality } = ctx;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    this.composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType, multisampling: 0 });
    this.composer.addPass(new RenderPass(scene, camera));

    this.ao = null;
    if (quality.ao) {
      const ao = new N8AOPostPass(scene, camera, size.x, size.y);
      ao.setQualityMode(quality.aoQuality ?? 'Medium');
      ao.configuration.aoRadius = quality.aoRadius ?? 6;
      ao.configuration.distanceFalloff = 1.2;
      ao.configuration.intensity = 2.4;
      ao.configuration.color = new THREE.Color(0x141a33);
      ao.configuration.halfRes = quality.aoHalfRes ?? true;
      ao.configuration.transparencyAware = false;
      ao.configuration.gammaCorrection = false;
      ao.configuration.accumulate = false;
      this.composer.addPass(ao);
      this.ao = ao;
    }

    this.speedFx = new SpeedEffect();
    this.grade = new GradeEffect();
    const effects = [this.speedFx];
    this.bloom = null;
    if (quality.bloom) {
      this.bloom = new BloomEffect({
        blendFunction: BlendFunction.ADD,
        intensity: 0.42,
        luminanceThreshold: 1.05,
        luminanceSmoothing: 0.35,
        mipmapBlur: true,
        radius: 0.7,
        levels: quality.bloomLevels ?? 6,
      });
      effects.push(this.bloom);
    }
    effects.push(this.grade);
    this.mainPass = new EffectPass(camera, ...effects);
    this.mainPass.dithering = true; // no banding in the sky gradient
    this.composer.addPass(this.mainPass);

    const aa = quality.antialias ?? 'smaa';
    if (aa === 'smaa') {
      this.aaPass = new EffectPass(camera, new SMAAEffect({ preset: SMAAPreset.HIGH, edgeDetectionMode: EdgeDetectionMode.COLOR }));
      this.composer.addPass(this.aaPass);
    } else if (aa === 'fxaa') {
      this.aaPass = new EffectPass(camera, new FXAAEffect());
      this.composer.addPass(this.aaPass);
    }

    this.speed = 0;
    this.speedSmooth = 0;
    this.flashAmt = 0;
    this.pulseAmt = 0;
    this.linesTime = 0;
    this.veil = 0;

    const bus = ctx.bus;
    bus?.on('landed', ({ stream }) => {
      if (stream?.isPlayer) this.flash(0.45);
    });
    bus?.on('finished', ({ stream }) => {
      if (stream?.isPlayer) this.flash(0.75);
    });
    bus?.on('absorb', ({ stream, amount }) => {
      if (!stream?.isPlayer) return;
      this.pulse(Math.min(0.06 + amount / 400000, 0.35));
    });
  }

  setSpeed(v) {
    this.speed = Math.min(Math.max(v || 0, 0), 1);
  }

  flash(strength = 1, color = null) {
    this.flashAmt = Math.max(this.flashAmt, Math.min(strength, 1));
    this.grade.uniforms.get('uFlashColor').value.copy(color ? _c.set(color) : _white);
  }

  pulse(strength = 0.3, color = null) {
    this.pulseAmt = Math.min(1, Math.max(this.pulseAmt, strength));
    if (color) this.grade.uniforms.get('uPulseColor').value.set(color);
  }

  resize(w, h) {
    this.composer.setSize(w, h);
  }

  /** Time-based state (smoothing, flash/veil decay). Runs every simulation tick, rendered or not. */
  update(dt) {
    const ctx = this.ctx;
    const g = this.grade.uniforms;

    // speed: chase speed from CameraDirector, plus free-fall in the drop phase
    let speed = this.speed;
    const p = ctx.game?.player;
    let falling = 0;
    if (p && p.phase === 'drop' && ctx.game.cameraDirector?.mode === 'drop') {
      falling = THREE.MathUtils.smoothstep(-p.vel.y, 35, 85);
      speed = Math.max(speed, falling * 0.75);
    }
    const k = 1 - Math.exp(-dt * 4);
    this.speedSmooth += (speed - this.speedSmooth) * k;
    const s = this.speedSmooth;
    this.speedFx.uniforms.get('uBlur').value = THREE.MathUtils.smoothstep(s, 0.35, 1.0) * 0.9;
    this.speedFx.uniforms.get('uAberration').value = THREE.MathUtils.smoothstep(s, 0.75, 1.0) * 0.8;
    g.get('uSpeedLines').value = THREE.MathUtils.smoothstep(s, 0.45, 1.0);
    this.linesTime += dt;
    g.get('uLinesTime').value = this.linesTime;

    // time-of-day driven exposure + grade
    const st = ctx.atmosphere?.state;
    if (st?.grade) {
      g.get('uExposure').value = st.exposure;
      g.get('uGrade').value.set(st.grade.warm, st.grade.cool, st.grade.sat, st.grade.contrast);
    }

    // flying through a cloud: soft whiteout (HDR, before tone mapping)
    const atmo = ctx.atmosphere;
    const blinded = ctx.game?.player?.blinded ?? 0;
    const veilTarget = Math.max(atmo?.cloudVeil ?? 0, blinded * 0.85);
    this.veil += (veilTarget - this.veil) * (1 - Math.exp(-dt * 6));
    if (atmo?.clouds) g.get('uVeil').value.set(atmo.clouds.veilColor.r, atmo.clouds.veilColor.g, atmo.clouds.veilColor.b, this.veil * 0.78);

    // impact flash / absorb pulse decay
    g.get('uFlash').value = this.flashAmt;
    g.get('uPulse').value = this.pulseAmt;
    this.flashAmt *= Math.exp(-dt * 7);
    this.pulseAmt *= Math.exp(-dt * 5);
    if (this.flashAmt < 0.002) this.flashAmt = 0;
    if (this.pulseAmt < 0.002) this.pulseAmt = 0;
  }

  render(dt) {
    this.composer.render(dt);
  }
}

const _white = new THREE.Color(1, 1, 1);
const _c = new THREE.Color();
