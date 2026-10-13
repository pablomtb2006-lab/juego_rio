import * as THREE from 'three';

/**
 * FieldView — debug visualisation of the physical fields, straight from the solver textures,
 * without touching the simulation (brief §14). Each particle is drawn as a sphere sprite
 * coloured by the selected field on a perceptual ramp.
 *   speed |v| (m/s) · pressure p (Pa) · vorticity |ω| (1/s) · density ρ/ρ0 · divergence ∇·v (1/s)
 *   · foam (0..1)
 */
export const FIELDS = {
  speed: { label: 'velocidad |v|', unit: 'm/s', range: [0, 6] },
  pressure: { label: 'presión p', unit: 'Pa', range: [0, 25000] },
  vorticity: { label: 'vorticidad |ω|', unit: '1/s', range: [0, 12] },
  density: { label: 'densidad ρ/ρ0', unit: '', range: [0.6, 1.05] },
  divergence: { label: 'divergencia ∇·v', unit: '1/s', range: [-4, 4] },
  foam: { label: 'espuma', unit: '0..1', range: [0, 1] },
};
const ORDER = Object.keys(FIELDS);

const VS = /* glsl */ `
precision highp float;
precision highp int;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform sampler2D uPos;
uniform sampler2D uVel;
uniform sampler2D uFields;
uniform int uTW;
uniform int uField;
uniform vec2 uRange;
uniform float uRho0;
uniform float uRadius;
uniform float uPointScale;
out float vT;
void main() {
  int i = gl_VertexID;
  ivec2 t = ivec2(i % uTW, i / uTW);
  vec4 P = texelFetch(uPos, t, 0);
  if (P.w < 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  vec4 V = texelFetch(uVel, t, 0);
  vec4 F = texelFetch(uFields, t, 0);
  float x = uField == 0 ? length(V.xyz) : uField == 1 ? F.z : uField == 2 ? F.w : uField == 3 ? F.y / uRho0 : uField == 4 ? F.x : V.w;
  vT = clamp((x - uRange.x) / (uRange.y - uRange.x), 0.0, 1.0);
  vec4 mv = modelViewMatrix * vec4(P.xyz, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(2.0 * uRadius * uPointScale / max(-mv.z, 0.01), 1.0, 128.0);
}`;

const FS = /* glsl */ `
precision highp float;
in float vT;
out vec4 fragColor;
// a turbo-like ramp: dark blue → cyan → green → yellow → red
vec3 ramp(float t) {
  vec3 a = vec3(0.13, 0.09, 0.42), b = vec3(0.12, 0.62, 0.85), c = vec3(0.35, 0.86, 0.38), d = vec3(0.98, 0.85, 0.2), e = vec3(0.86, 0.18, 0.12);
  return t < 0.25 ? mix(a, b, t * 4.0) : t < 0.5 ? mix(b, c, (t - 0.25) * 4.0) : t < 0.75 ? mix(c, d, (t - 0.5) * 4.0) : mix(d, e, (t - 0.75) * 4.0);
}
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  fragColor = vec4(ramp(vT) * (0.55 + 0.45 * sqrt(1.0 - r2)), 1.0);
}`;

export class FieldView {
  constructor(layout) {
    const N = layout.TW * layout.TH;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    geo.setDrawRange(0, N);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.tex = { pos: new THREE.ExternalTexture(null), vel: new THREE.ExternalTexture(null), fields: new THREE.ExternalTexture(null) };
    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        uPos: { value: this.tex.pos },
        uVel: { value: this.tex.vel },
        uFields: { value: this.tex.fields },
        uTW: { value: layout.TW },
        uField: { value: 0 },
        uRange: { value: new THREE.Vector2(0, 1) },
        uRho0: { value: 998.2 },
        uRadius: { value: 0.1 },
        uPointScale: { value: 1 },
      },
      vertexShader: VS,
      fragmentShader: FS,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.field = null; // null = off (normal water rendering)
  }

  cycle() {
    const i = this.field === null ? 0 : ORDER.indexOf(this.field) + 1;
    this.field = i >= ORDER.length ? null : ORDER[i];
    return this.field;
  }

  sync(sim, pointScale) {
    const u = this.material.uniforms;
    this.tex.pos.sourceTexture = sim.position;
    this.tex.vel.sourceTexture = sim.velocity;
    this.tex.fields.sourceTexture = sim.solver.fields;
    u.uField.value = ORDER.indexOf(this.field);
    u.uRange.value.fromArray(FIELDS[this.field].range);
    u.uRho0.value = sim.cfg.density;
    u.uRadius.value = sim.cfg.particleRadius;
    u.uPointScale.value = pointScale;
  }
}
