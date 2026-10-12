// Shared GLSL. Every custom ShaderMaterial in the game must:
//   1) spread `ctx.atmosphere.uniforms` into its uniforms
//   2) include ATMOSPHERE_PARS_GLSL in the fragment shader
//   3) finish with  gl_FragColor.rgb = applyAtmosphere(color, vWorldPos);
// so fog / aerial perspective / sun stay consistent across terrain, water and props.
// The render owner may change the *implementation* below, never the signatures.

export const ATMOSPHERE_PARS_GLSL = /* glsl */ `
uniform vec3 uSunDir;        // normalized, pointing *towards* the sun
uniform vec3 uSunColor;
uniform vec3 uSkyColor;      // zenith-ish ambient
uniform vec3 uGroundColor;   // hemisphere ground bounce
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uFogHeightFalloff;
uniform vec3 uCameraPos;
uniform float uTime;

vec3 applyAtmosphere(vec3 color, vec3 worldPos) {
  vec3 rd = worldPos - uCameraPos;
  float dist = length(rd);
  rd /= max(dist, 1e-4);
  // height fog (analytic integral of exp(-h * falloff))
  float h0 = max(uCameraPos.y, 0.0);
  float fh = uFogHeightFalloff;
  float fogAmt = uFogDensity * exp(-h0 * fh) * (1.0 - exp(-dist * rd.y * fh)) / max(rd.y * fh, 1e-4);
  if (abs(rd.y) < 1e-3) fogAmt = uFogDensity * exp(-h0 * fh) * dist;
  fogAmt = 1.0 - exp(-max(fogAmt, 0.0));
  float sunAmt = pow(max(dot(rd, uSunDir), 0.0), 8.0);
  vec3 fogCol = mix(uFogColor, uSunColor * 1.1, sunAmt * 0.5);
  return mix(color, fogCol, clamp(fogAmt, 0.0, 1.0));
}
`;
