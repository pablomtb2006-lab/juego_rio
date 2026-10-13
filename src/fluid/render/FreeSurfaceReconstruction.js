import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

/**
 * FreeSurfaceReconstruction — turns the particle state into a continuous water surface,
 * every frame, in screen space (van der Laan, Green & Sainz 2009):
 *
 *   1. depth      every particle is splatted as a sphere; the nearest one per pixel wins
 *   2. thickness  how much water a view ray crosses (additive, half resolution); rgb carries the
 *                 dye's optical depth Σ σ·chord of each river's water (Beer–Lambert is additive in
 *                 optical depth, so mixing waters of different colour along a ray is exact)
 *   3. smoothing  a depth-aware (bilateral) separable filter melts the spheres into one surface
 *                 without blurring across silhouettes; the thickness gets a plain Gaussian
 *   4. normals    rebuilt from the smoothed depth by the compositor (WaterRendering)
 *
 * LAYERS (brief §11): this surface is a RECONSTRUCTION of the physical state — the particles are
 * the physics. The smoothing radius is a visual choice (it can hide waves smaller than ~2 particle
 * spacings, never create them). No volume is added: the splat radius is the only "inflation" and
 * it is reported in the panel.
 */
// Ellipsoid splats: anisotropy textures from FluidSolver.anisotropy() give, per particle, two
// axes + three radii + a smoothed centre. The fragment shader intersects the pixel's view ray
// with that ellipsoid analytically: exact depth for the depth pass, exact chord for thickness.
const SPLAT_VS = /* glsl */ `
precision highp float;
precision highp int;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform sampler2D uPos;
uniform sampler2D uAnA;
uniform sampler2D uAnB;
uniform sampler2D uAnC;
uniform sampler2D uId;
uniform int uTW;
uniform float uPointScale;
out vec3 vC;
flat out vec3 vSigma;
flat out vec3 vM0;
flat out vec3 vM1;
flat out vec3 vM2;
void main() {
  int i = gl_VertexID;
  ivec2 t = ivec2(i % uTW, i / uTW);
  vec4 P = texelFetch(uPos, t, 0);
  if (P.w < 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  vec4 A = texelFetch(uAnA, t, 0);
  vec4 B = texelFetch(uAnB, t, 0);
  vec4 C = texelFetch(uAnC, t, 0);
  vSigma = texelFetch(uId, t, 0).rgb; // dye absorbance of this particle (rivers; 0 otherwise)
  vec3 s = max(vec3(A.w, B.w, C.w), vec3(1e-4));
  mat3 V = mat3(modelViewMatrix);
  vec3 a3 = cross(A.xyz, B.xyz);
  vec4 mv = modelViewMatrix * vec4(C.xyz, 1.0);
  vC = mv.xyz;
  vM0 = (V * A.xyz) / s.x;
  vM1 = (V * B.xyz) / s.y;
  vM2 = (V * a3) / s.z;
  gl_Position = projectionMatrix * mv;
  float R = max(s.x, max(s.y, s.z));
  gl_PointSize = clamp(2.2 * R * uPointScale / max(-mv.z, 0.01), 1.0, 256.0);
}`;

const SPHERE_FS = (body) => /* glsl */ `
precision highp float;
uniform mat4 projectionMatrix;
uniform mat4 uProjInv;
uniform sampler2D uSceneDepth;
uniform vec2 uRes;
in vec3 vC;
flat in vec3 vM0;
flat in vec3 vM1;
flat in vec3 vM2;
flat in vec3 vSigma;
out vec4 fragColor;
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec4 v = uProjInv * vec4(uv * 2.0 - 1.0, -1.0, 1.0);
  vec3 d = v.xyz / v.w; // view ray through this pixel (origin = camera)
  vec3 a = -vec3(dot(vM0, vC), dot(vM1, vC), dot(vM2, vC));
  vec3 b = vec3(dot(vM0, d), dot(vM1, d), dot(vM2, d));
  float qa = dot(b, b);
  float qb = 2.0 * dot(a, b);
  float qc = dot(a, a) - 1.0;
  float disc = qb * qb - 4.0 * qa * qc;
  if (disc < 0.0) discard;
  float sq = sqrt(disc);
  float t = (-qb - sq) / (2.0 * qa);
  if (t <= 0.0) discard;
  vec3 p = t * d;
  vec4 clip = projectionMatrix * vec4(p, 1.0);
  float dd = clip.z / clip.w * 0.5 + 0.5;
  if (dd > texture(uSceneDepth, uv).r) discard; // hidden by solid geometry
  float chord = sq / qa * length(d);
  ${body}
}`;

const FULL_VS = /* glsl */ `
precision highp float;
in vec3 position;
in vec2 uv;
out vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const BILATERAL_FS = /* glsl */ `
precision highp float;
uniform sampler2D uDepth;
uniform vec2 uRes;
uniform float uWorldRadius;
uniform float uPointScale;
uniform float uFalloff;
uniform float uJitter;
in vec2 vUv;
out vec4 fragColor;
// 2D bilateral on a sparse 9×9 grid scaled to the filter radius. A separable bilateral is not
// separable at all at depth edges and leaves row/column streaks; this one does not.
void main() {
  float z = texture(uDepth, vUv).r;
  if (z <= 0.0) { fragColor = vec4(0.0); return; }
  float rpx = clamp(uWorldRadius * uPointScale / z, 1.0, 40.0);
  float stepPx = rpx / 4.0;
  float sigma = rpx * 0.5;
  float sum = 0.0;
  float wsum = 0.0;
  // rotate the grid per pixel so the sparse taps do not print a pattern
  float a = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) * 6.2831 * uJitter;
  mat2 rot = mat2(cos(a), sin(a), -sin(a), cos(a));
  for (int y = -4; y <= 4; y++) {
    for (int x = -4; x <= 4; x++) {
      vec2 o = rot * vec2(float(x), float(y)) * stepPx;
      float s = texture(uDepth, vUv + o / uRes).r;
      if (s <= 0.0) continue;
      float dz = (s - z) / uFalloff;
      float w = exp(-dot(o, o) / (2.0 * sigma * sigma)) * exp(-dz * dz);
      sum += s * w;
      wsum += w;
    }
  }
  fragColor = vec4(sum / wsum, 0.0, 0.0, 1.0);
}`;

const GAUSS_FS = /* glsl */ `
precision highp float;
uniform sampler2D uTex;
uniform vec2 uDir;
uniform vec2 uRes;
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec4 sum = vec4(0.0);
  float wsum = 0.0;
  for (int k = -6; k <= 6; k++) {
    float w = exp(-float(k * k) / 18.0);
    sum += texture(uTex, vUv + uDir * float(k) / uRes) * w;
    wsum += w;
  }
  fragColor = sum / wsum;
}`;

export class FreeSurfaceReconstruction {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {{TW:number, TH:number}} layout   particle texture layout of the simulation
   * @param {number} particleRadius            m
   */
  constructor(renderer, layout, particleRadius) {
    this.renderer = renderer;
    this.layout = layout;
    this.params = {
      splatScale: 1.5, // splat radius / particle radius (closes the gaps between spheres)
      smoothing: 4, // bilateral radius, in particle radii (the ellipsoids already do most of the work)
      iterations: 2,
    };
    this.particleRadius = particleRadius;
    this.posTex = new THREE.ExternalTexture(null);

    const N = layout.TW * layout.TH;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    geo.setDrawRange(0, N);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.anTex = [new THREE.ExternalTexture(null), new THREE.ExternalTexture(null), new THREE.ExternalTexture(null)];
    this.idTex = new THREE.ExternalTexture(null);
    const common = {
      uPos: { value: this.posTex },
      uAnA: { value: this.anTex[0] },
      uAnB: { value: this.anTex[1] },
      uAnC: { value: this.anTex[2] },
      uId: { value: this.idTex },
      uTW: { value: layout.TW },
      uPointScale: { value: 1 },
      uSceneDepth: { value: null },
      uRes: { value: new THREE.Vector2(1, 1) },
      uProjInv: { value: new THREE.Matrix4() },
    };
    this.common = common;
    this.depthMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: common,
      vertexShader: SPLAT_VS,
      fragmentShader: SPHERE_FS(`gl_FragDepth = dd; fragColor = vec4(-p.z, 0.0, 0.0, 1.0);`),
      depthTest: true,
      depthWrite: true,
    });
    this.thickMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { ...common, uRes: { value: new THREE.Vector2(1, 1) }, uPointScale: { value: 1 } }, // half-res pass: own size and scale
      vertexShader: SPLAT_VS,
      fragmentShader: SPHERE_FS(`fragColor = vec4(vSigma * chord, chord);`),
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendEquation: THREE.AddEquation,
    });
    this.points = new THREE.Points(geo, this.depthMat);
    this.points.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.points);

    this.bilateral = new FullScreenQuad(
      new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        uniforms: { uDepth: { value: null }, uRes: { value: new THREE.Vector2() }, uWorldRadius: { value: 0.2 }, uPointScale: { value: 1 }, uFalloff: { value: 0.2 }, uJitter: { value: 0 } },
        vertexShader: FULL_VS,
        fragmentShader: BILATERAL_FS,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.gauss = new FullScreenQuad(
      new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        uniforms: { uTex: { value: null }, uDir: { value: new THREE.Vector2() }, uRes: { value: new THREE.Vector2() } },
        vertexShader: FULL_VS,
        fragmentShader: GAUSS_FS,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.setSize(2, 2);
  }

  setSize(w, h) {
    this.w = w;
    this.h = h;
    const f = { type: THREE.FloatType, format: THREE.RedFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter };
    this.depthRT?.dispose();
    this.smoothRT?.forEach((r) => r.dispose());
    this.thickRT?.forEach((r) => r.dispose());
    this.depthRT = new THREE.WebGLRenderTarget(w, h, { ...f, depthBuffer: true });
    this.smoothRT = [new THREE.WebGLRenderTarget(w, h, { ...f, depthBuffer: false }), new THREE.WebGLRenderTarget(w, h, { ...f, depthBuffer: false })];
    const hw = Math.max(1, w >> 1);
    const hh = Math.max(1, h >> 1);
    // rgb: dye optical depth (dimensionless), a: water thickness (m)
    const hf = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false };
    this.thickRT = [new THREE.WebGLRenderTarget(hw, hh, hf), new THREE.WebGLRenderTarget(hw, hh, hf)];
  }

  /**
   * @param {THREE.PerspectiveCamera} camera
   * @param {WebGLTexture} positionTexture   the simulation's current particle positions
   * @param {THREE.DepthTexture} sceneDepth  depth of the solid scene (occludes the water)
   * @returns {{depth: THREE.Texture, thickness: THREE.Texture, radius: number}}
   */
  /** Splat radius the anisotropy pass should use (m). */
  get splatRadius() {
    return this.particleRadius * this.params.splatScale;
  }

  render(camera, positionTexture, sceneDepth, aniso, identityTexture) {
    const r = this.renderer;
    const p = this.params;
    this.posTex.sourceTexture = positionTexture;
    this.idTex.sourceTexture = identityTexture;
    for (let k = 0; k < 3; k++) this.anTex[k].sourceTexture = aniso[k];
    const radius = this.splatRadius;
    const scale = this.h / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    const c = this.common;
    c.uPointScale.value = scale;
    c.uProjInv.value.copy(camera.projectionMatrixInverse);
    c.uSceneDepth.value = sceneDepth;
    c.uRes.value.set(this.w, this.h);

    const prevClear = r.getClearColor(new THREE.Color());
    const prevAlpha = r.getClearAlpha();
    r.setClearColor(0x000000, 0);

    // 1. depth
    this.points.material = this.depthMat;
    r.setRenderTarget(this.depthRT);
    r.clear(true, true, false);
    r.render(this.scene, camera);

    // 2. thickness (half resolution)
    this.points.material = this.thickMat;
    this.thickMat.uniforms.uRes.value.set(this.thickRT[0].width, this.thickRT[0].height); // gl_FragCoord is half-res here
    this.thickMat.uniforms.uPointScale.value = scale * 0.5;
    r.setRenderTarget(this.thickRT[0]);
    r.clear(true, false, false);
    r.render(this.scene, camera);

    // 3. smoothing: bilateral on depth, Gaussian on thickness
    const b = this.bilateral.material.uniforms;
    b.uRes.value.set(this.w, this.h);
    b.uWorldRadius.value = this.particleRadius * p.smoothing;
    b.uPointScale.value = scale;
    b.uFalloff.value = this.particleRadius * 4;
    let src = this.depthRT.texture;
    for (let i = 0; i < p.iterations; i++) {
      b.uDepth.value = src;
      const dst = this.smoothRT[i & 1];
      r.setRenderTarget(dst);
      this.bilateral.render(r);
      src = dst.texture;
    }
    const g = this.gauss.material.uniforms;
    g.uRes.value.set(this.thickRT[0].width, this.thickRT[0].height);
    g.uTex.value = this.thickRT[0].texture;
    g.uDir.value.set(1, 0);
    r.setRenderTarget(this.thickRT[1]);
    this.gauss.render(r);
    g.uTex.value = this.thickRT[1].texture;
    g.uDir.value.set(0, 1);
    r.setRenderTarget(this.thickRT[0]);
    this.gauss.render(r);

    r.setClearColor(prevClear, prevAlpha);
    return { depth: src, rawDepth: this.depthRT.texture, thickness: this.thickRT[0].texture, radius, pointScale: scale };
  }
}
