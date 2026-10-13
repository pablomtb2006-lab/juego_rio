import * as THREE from 'three';

/**
 * FoamAndSpray — draws the foam carried by the water particles.
 *
 * WHAT IT IS: a visual layer. No air is simulated. The foam value of each particle is computed
 * by the solver from measured quantities (vorticity × kinetic energy = trapped air; low density at
 * a free surface × speed = wave crest / spray), persists with a lifetime and travels with the
 * particle (FluidSolver, xsph pass). This class only renders it: white sprites at the surface,
 * fainter bubbles when submerged (seen through the water), hidden behind solids.
 * Spray that leaves the water is simply water particles in flight: they fall ballistically
 * because they ARE the fluid, and they keep their mass in the books.
 */
const VS = /* glsl */ `
precision highp float;
precision highp int;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform sampler2D uPos;
uniform sampler2D uVel;
uniform int uTW;
uniform float uSize;
uniform float uPointScale;
out float vFoam;
out vec3 vView;
out float vSeed;
float hash(float n) { return fract(sin(n) * 43758.5453); }
void main() {
  int i = gl_VertexID;
  ivec2 t = ivec2(i % uTW, i / uTW);
  vec4 P = texelFetch(uPos, t, 0);
  float foam = texelFetch(uVel, t, 0).w;
  if (P.w < 0.0 || foam < 0.04) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  vSeed = hash(P.w);
  // jitter inside the particle so foam does not sit on a lattice
  vec3 j = vec3(hash(P.w * 1.7), hash(P.w * 2.3), hash(P.w * 3.1)) - 0.5;
  vec4 mv = modelViewMatrix * vec4(P.xyz + j * uSize * 1.5, 1.0);
  vView = mv.xyz;
  vFoam = foam;
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(uSize * (0.6 + 0.8 * vSeed) * uPointScale / max(-mv.z, 0.01), 1.0, 64.0);
}`;

const FS = /* glsl */ `
precision highp float;
uniform sampler2D uSurface;   // smoothed water depth (view distance)
uniform sampler2D uSceneDepth;
uniform vec2 uRes;
uniform float uNear;
uniform float uFar;
uniform float uSize;
uniform vec3 uLight;
in float vFoam;
in vec3 vView;
in float vSeed;
out vec4 fragColor;
float sceneViewDepth(vec2 uv) {
  float d = texture(uSceneDepth, uv).r * 2.0 - 1.0;
  return 2.0 * uNear * uFar / (uFar + uNear - d * (uFar - uNear));
}
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  vec2 uv = gl_FragCoord.xy / uRes;
  float z = -vView.z;
  if (z > sceneViewDepth(uv)) discard; // behind a solid
  float surf = texture(uSurface, uv).r;
  // under the surface: a bubble seen through water, fading with depth
  float under = surf > 0.0 ? max(z - surf - uSize, 0.0) : 0.0;
  float a = (1.0 - r2) * vFoam * exp(-under * 3.5);
  if (a < 0.01) discard;
  vec3 col = uLight * (0.85 + 0.15 * vSeed);
  fragColor = vec4(col, a * 0.42);
}`;

export class FoamAndSpray {
  constructor(layout) {
    const N = layout.TW * layout.TH;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    geo.setDrawRange(0, N);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.pos = new THREE.ExternalTexture(null);
    this.vel = new THREE.ExternalTexture(null);
    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        uPos: { value: this.pos },
        uVel: { value: this.vel },
        uTW: { value: layout.TW },
        uSize: { value: 0.1 },
        uPointScale: { value: 1 },
        uSurface: { value: null },
        uSceneDepth: { value: null },
        uRes: { value: new THREE.Vector2() },
        uNear: { value: 0.1 },
        uFar: { value: 1000 },
        uLight: { value: new THREE.Vector3(0.95, 0.97, 1.0) },
      },
      vertexShader: VS,
      fragmentShader: FS,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.points);
    this.enabled = true;
  }

  render(renderer, camera, sim, surface, sceneDepth, w, h) {
    if (!this.enabled) return;
    const u = this.material.uniforms;
    this.pos.sourceTexture = sim.position;
    this.vel.sourceTexture = sim.velocity;
    u.uSize.value = sim.cfg.particleRadius * 0.8;
    u.uPointScale.value = surface.pointScale;
    u.uSurface.value = surface.depth;
    u.uSceneDepth.value = sceneDepth;
    u.uRes.value.set(w, h);
    u.uNear.value = camera.near;
    u.uFar.value = camera.far;
    const auto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(this.scene, camera);
    renderer.autoClear = auto;
  }
}
