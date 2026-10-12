import * as THREE from 'three';

/**
 * Sky, sun, lighting and fog. Owns the shared atmosphere uniforms
 * (see shaderChunks.js). Contract:
 *   atmosphere.uniforms        — shared uniform objects (spread into ShaderMaterials)
 *   atmosphere.sun             — THREE.DirectionalLight (casts shadows when quality.shadows)
 *   atmosphere.sunDirection    — THREE.Vector3 towards the sun
 *   atmosphere.envMap          — texture for MeshStandardMaterial.envMap (may be null)
 *   atmosphere.setTimeOfDay(t) — 0..1, 0.5 = noon (used by victory/lobby moods)
 *   atmosphere.update(dt, t)   — follows ctx.camera (shadow cascades, uniforms)
 */
export class Atmosphere {
  constructor(ctx) {
    this.ctx = ctx;
    const { scene } = ctx;

    this.sunDirection = new THREE.Vector3(0.45, 0.55, 0.35).normalize();
    this.uniforms = {
      uSunDir: { value: this.sunDirection },
      uSunColor: { value: new THREE.Color(1.0, 0.92, 0.8) },
      uSkyColor: { value: new THREE.Color(0.45, 0.65, 1.0) },
      uGroundColor: { value: new THREE.Color(0.35, 0.3, 0.22) },
      uFogColor: { value: new THREE.Color(0.62, 0.76, 0.92) },
      uFogDensity: { value: 0.00012 },
      uFogHeightFalloff: { value: 0.0012 },
      uCameraPos: { value: new THREE.Vector3() },
      uTime: { value: 0 },
    };

    scene.background = new THREE.Color(0x8ec3f0);
    scene.fog = new THREE.FogExp2(0x9ec2e6, 0.00009);

    this.hemi = new THREE.HemisphereLight(0xbfdcff, 0x5a4a32, 0.9);
    scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xfff0dd, 2.6);
    this.sun.castShadow = ctx.quality.shadows;
    this.sun.shadow.mapSize.set(ctx.quality.shadowMapSize, ctx.quality.shadowMapSize);
    const s = 400;
    Object.assign(this.sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 4000 });
    this.sun.shadow.bias = -0.0005;
    scene.add(this.sun, this.sun.target);

    this.envMap = null;
  }

  setTimeOfDay() {}

  update(dt, time) {
    const cam = this.ctx.camera;
    this.uniforms.uCameraPos.value.copy(cam.position);
    this.uniforms.uTime.value = time;
    // keep the shadow frustum around the camera focus
    const focus = this.ctx.game?.cameraDirector?.focus ?? cam.position;
    this.sun.target.position.copy(focus);
    this.sun.position.copy(focus).addScaledVector(this.sunDirection, 2000);
  }
}
