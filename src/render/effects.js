import * as THREE from 'three';
import { Effect, EffectAttribute, BlendFunction } from 'postprocessing';
import { NOISE_GLSL } from './shaderChunks.js';

/**
 * Radial speed blur + chromatic aberration at the screen edges. Samples the input buffer
 * (convolution) so it must be the first effect of its EffectPass — postprocessing sorts
 * convolution effects first automatically.
 */
const SPEED_FRAG = /* glsl */ `
uniform float uBlur;        // 0..1 radial blur strength
uniform float uAberration;  // 0..1 chromatic aberration strength
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec2 d = uv - 0.5;
  vec2 da = vec2(d.x * aspect, d.y);
  float r = length(da);
  float mask = smoothstep(0.22, 0.78, r);
  float blur = uBlur * mask;
  vec3 col = inputColor.rgb;
  if (blur > 0.004) {
    vec2 stepUv = d * (0.07 * blur / 7.0);
    vec3 acc = col;
    for (int i = 1; i <= 7; i++) acc += texture2D(inputBuffer, uv - stepUv * float(i)).rgb;
    col = acc / 8.0;
  }
  float ca = uAberration * mask;
  if (ca > 0.004) {
    vec2 off = d * ca * 0.016;
    col.r = mix(col.r, texture2D(inputBuffer, uv + off).r, 0.75);
    col.b = mix(col.b, texture2D(inputBuffer, uv - off).b, 0.75);
  }
  outputColor = vec4(col, inputColor.a);
}
`;

export class SpeedEffect extends Effect {
  constructor() {
    super('RioSpeedEffect', SPEED_FRAG, {
      attributes: EffectAttribute.CONVOLUTION,
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map([
        ['uBlur', new THREE.Uniform(0)],
        ['uAberration', new THREE.Uniform(0)],
      ]),
    });
  }
}

/**
 * Tone mapping (AgX + "punchy" look) and the whole stylized grade in one pass:
 * cloud veil (HDR) → exposure → AgX → split-tone (cool shadows / warm highlights) →
 * contrast → vibrance/saturation → speed lines → absorb pulse → vignette → flash.
 */
const GRADE_FRAG = /* glsl */ `
${NOISE_GLSL}
uniform float uExposure;
uniform vec4 uGrade;        // x warm, y cool, z saturation, w contrast
uniform vec2 uLook;         // AgX look: x power, y saturation
uniform vec3 uWarmTint;
uniform vec3 uCoolTint;
uniform vec4 uVeil;         // rgb colour (linear HDR), a amount
uniform vec2 uVignette;     // x darkness, y smoothness exponent
uniform float uFlash;
uniform vec3 uFlashColor;
uniform float uSpeedLines;
uniform float uPulse;
uniform vec3 uPulseColor;
uniform float uLinesTime;

const mat3 AGX_IN = mat3(
  vec3(0.856627153315983, 0.137318972929847, 0.11189821299995),
  vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
  vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
const mat3 AGX_OUT = mat3(
  vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
  vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294),
  vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
const mat3 SRGB_TO_2020 = mat3(
  vec3(0.6274, 0.0691, 0.0164), vec3(0.3293, 0.9195, 0.0880), vec3(0.0433, 0.0113, 0.8956));
const mat3 REC2020_TO_SRGB = mat3(
  vec3(1.6605, -0.1246, -0.0182), vec3(-0.5876, 1.1329, -0.1006), vec3(-0.0728, -0.0083, 1.1187));

vec3 agxContrast(vec3 x) {
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

vec3 agxTonemap(vec3 color) {
  color = SRGB_TO_2020 * color;
  color = AGX_IN * color;
  color = max(color, 1e-10);
  color = clamp((log2(color) + 12.47393) / 16.5, 0.0, 1.0);
  color = agxContrast(color);
  // ASC CDL look (Blender "Punchy"-style), applied in AgX space
  color = pow(max(color, 0.0), vec3(uLook.x));
  float l = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color = l + uLook.y * (color - l);
  color = AGX_OUT * color;
  color = pow(max(color, 0.0), vec3(2.2));
  color = REC2020_TO_SRGB * color;
  return clamp(color, 0.0, 1.0);
}

float speedLines(vec2 uv, float t) {
  vec2 d = uv - 0.5;
  d.x *= aspect;
  float r = length(d);
  float ang = atan(d.y, d.x) / 6.2831853 + 0.5;
  float a = ang * 110.0;
  float id = floor(a);
  float fa = fract(a);
  float h = rioHash12(vec2(id, 3.7));
  float width = 0.08 + 0.12 * h;
  float line = 1.0 - smoothstep(0.0, width, abs(fa - 0.5));
  float seg = fract(r * (1.2 + h) - t * (1.4 + 1.8 * h) + h * 17.0);
  float dash = smoothstep(0.0, 0.08, seg) * (1.0 - smoothstep(0.25, 0.55, seg));
  float on = step(0.5, rioHash12(vec2(id, floor(t * 4.0 + h * 9.0))));
  return line * dash * on * smoothstep(0.3, 0.72, r);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = max(inputColor.rgb, 0.0);
  c = mix(c, uVeil.rgb, uVeil.a);
  c = agxTonemap(c * uExposure);

  // grade in a perceptual (gamma 2.2) space
  vec3 g = pow(c, vec3(1.0 / 2.2));
  float l = dot(g, vec3(0.2126, 0.7152, 0.0722));
  float sh = 1.0 - smoothstep(0.0, 0.6, l);
  float hi = smoothstep(0.35, 1.0, l);
  g += (uCoolTint - 0.5) * 0.16 * uGrade.y * sh * sh;
  g += (uWarmTint - 0.5) * 0.14 * uGrade.x * hi;
  g = (g - 0.42) * uGrade.w + 0.42;
  float l2 = dot(g, vec3(0.2126, 0.7152, 0.0722));
  float chroma = max(max(g.r, g.g), g.b) - min(min(g.r, g.g), g.b);
  // vibrance: boost muted colours more than already saturated ones
  float sat = uGrade.z * (1.0 + 0.25 * (1.0 - smoothstep(0.0, 0.5, chroma)) * (uGrade.z - 1.0) * 4.0);
  g = l2 + (g - l2) * sat;
  g = clamp(g, 0.0, 1.0);

  // speed lines (display space so they stay crisp white)
  if (uSpeedLines > 0.01) g = mix(g, vec3(1.0), speedLines(uv, uLinesTime) * uSpeedLines * 0.55);

  vec2 d = uv - 0.5;
  d.x *= aspect;
  float r = length(d);
  // absorb pulse: cyan glow creeping in from the edges
  if (uPulse > 0.001) g += uPulseColor * uPulse * smoothstep(0.25, 0.9, r) * 0.35;

  // vignette (elliptical, soft)
  vec2 vv = uv * (1.0 - uv);
  float vig = pow(clamp(16.0 * vv.x * vv.y, 0.0, 1.0), uVignette.y);
  g *= mix(1.0 - uVignette.x, 1.0, vig);

  c = pow(clamp(g, 0.0, 1.0), vec3(2.2));
  c = mix(c, uFlashColor, clamp(uFlash, 0.0, 1.0));
  outputColor = vec4(c, inputColor.a);
}
`;

export class GradeEffect extends Effect {
  constructor() {
    super('RioGradeEffect', GRADE_FRAG, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map([
        ['uExposure', new THREE.Uniform(1)],
        ['uGrade', new THREE.Uniform(new THREE.Vector4(0.3, 0.45, 1.1, 1.06))],
        ['uLook', new THREE.Uniform(new THREE.Vector2(1.2, 1.32))],
        ['uWarmTint', new THREE.Uniform(new THREE.Color(1.0, 0.78, 0.5))],
        ['uCoolTint', new THREE.Uniform(new THREE.Color(0.32, 0.42, 0.75))],
        ['uVeil', new THREE.Uniform(new THREE.Vector4(1, 1, 1, 0))],
        ['uVignette', new THREE.Uniform(new THREE.Vector2(0.3, 0.22))],
        ['uFlash', new THREE.Uniform(0)],
        ['uFlashColor', new THREE.Uniform(new THREE.Color(1, 1, 1))],
        ['uSpeedLines', new THREE.Uniform(0)],
        ['uPulse', new THREE.Uniform(0)],
        ['uPulseColor', new THREE.Uniform(new THREE.Color(0.25, 0.85, 1.0))],
        ['uLinesTime', new THREE.Uniform(0)],
      ]),
    });
  }
}
