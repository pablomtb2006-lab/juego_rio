import { ATMOSPHERE_PARS_GLSL } from '../../render/shaderChunks.js';
import { NOISE_GLSL, LIGHT_GLSL, TERRAIN_GLSL } from './waterCommon.js';

/**
 * River shaders. One program family is shared by the trail ribbon and the head wave
 * (define HEAD), specialised per skin with SKIN_FX (0 plain, 1 magma, 2 galaxy, 3 gold,
 * 4 toxic, 5 glacier).
 */

export const EXT = 1.22; // ribbon reaches EXT × half-width (wet bank + foam rim)

export const RIVER_VERT = /* glsl */ `
${TERRAIN_GLSL}
attribute vec4 aFlow; // s (m along trail), lateral t (-EXT..EXT, × half-width), flow phase (m), steepness
attribute vec4 aMisc; // half-width, cut mask, tangent.xz
uniform float uWTime;
#ifdef HEAD
uniform vec3 uHeadPos;
uniform vec2 uHeadDir;
uniform float uHeadR;
uniform float uHeadS;
uniform float uHeadPhi;
uniform float uSpeedF;
uniform float uCrest;
uniform float uSteepHead;
varying vec2 vAB;
#endif
varying vec4 vFlow;
varying vec4 vMisc;
varying vec3 vN;
varying vec3 vWorldPos;

#ifdef HEAD
const float EXT = ${EXT.toFixed(3)};
vec3 headPoint(vec2 ab, out vec4 flow) {
  float a = clamp(ab.x, -1.0, 1.0);
  float b = clamp(ab.y, -1.0, 1.0);
  float r = uHeadR;
  float Lb = 2.8 * r;
  float Lf = 1.25 * r;
  float along = a < 0.0 ? a * Lb : a * Lf;
  float wf = a > 0.0 ? sqrt(max(1.0 - a * a, 0.0)) : 1.0;
  float tl = b * EXT * wf;
  vec2 dir = uHeadDir;
  vec2 perp = vec2(-dir.y, dir.x);
  vec2 cxz = uHeadPos.xz + dir * along;
  vec2 xz = cxz + perp * tl * r;
  float sea = uTerrainInfo.z - 0.3;
  float h = max(terrainHeight(xz), sea);
  float hc = max(terrainHeight(cxz), sea);
  float depth = clamp(0.2 * r, 0.6, 3.5);
  float prof = max(1.0 - b * b, 0.0) * sqrt(wf);
  float y = max(h + 0.12, min(hc + depth, h + depth * prof));
  float crestA = smoothstep(-0.75, 0.3, a) * (1.0 - smoothstep(0.3, 1.0, a));
  float wobble = 0.12 * sin(b * 7.0 + uWTime * 6.0) * crestA;
  y += uCrest * r * crestA * prof * (1.0 + wobble);
  flow = vec4(uHeadS + along, tl, uHeadPhi + along / uSpeedF, uSteepHead);
  return vec3(xz.x, y, xz.y);
}
#endif

void main() {
#ifdef HEAD
  vec4 flow;
  vec4 f2;
  vec3 p = headPoint(position.xy, flow);
  vec3 pa = headPoint(position.xy + vec2(0.03, 0.0), f2) - headPoint(position.xy - vec2(0.03, 0.0), f2);
  vec3 pb = headPoint(position.xy + vec2(0.0, 0.05), f2) - headPoint(position.xy - vec2(0.0, 0.05), f2);
  vec3 n = cross(pb, pa);
  n = dot(n, n) > 1e-10 ? normalize(n) : vec3(0.0, 1.0, 0.0);
  if (n.y < 0.0) n = -n;
  vFlow = flow;
  vMisc = vec4(uHeadR, 0.0, uHeadDir);
  vAB = position.xy;
  vec4 wp = vec4(p, 1.0);
#else
  vec3 n = normal;
  vFlow = aFlow;
  vMisc = aMisc;
  vec4 wp = modelMatrix * vec4(position, 1.0);
#endif
  vN = n;
  vWorldPos = wp.xyz;
  vec4 mv = viewMatrix * wp;
  float d = length(mv.xyz);
  mv.xyz *= 1.0 - min((0.5 + d * 0.004) / max(d, 1e-3), 0.5);
  gl_Position = projectionMatrix * mv;
}
`;

export const RIVER_FRAG = /* glsl */ `
${ATMOSPHERE_PARS_GLSL}
${NOISE_GLSL}
${LIGHT_GLSL}
uniform float uWTime;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform vec3 uFoam;
uniform vec3 uGlow;
uniform vec3 uTint;
uniform float uRival;
uniform float uFlowSpeed;
uniform float uHeadS;
uniform float uDeadT;
uniform float uSurge;
#ifdef HEAD
varying vec2 vAB;
#endif
varying vec4 vFlow;
varying vec4 vMisc;
varying vec3 vN;
varying vec3 vWorldPos;
const float EXT = ${EXT.toFixed(3)};

void main() {
  float t = uWTime;
  float s = vFlow.x;
  float tl = vFlow.y;
  float phi = vFlow.z;
  float steep = vFlow.w;
  float w = vMisc.x;
  float cut = vMisc.y;
  float at = abs(tl);
  vec3 toCam = uCameraPos - vWorldPos;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  float u = phi - t * uFlowSpeed;
  float lat = tl * w;
  float fp = max(length(fwidth(vWorldPos.xz)), 1e-3);
  float lod1 = 1.0 - smoothstep(1.5, 8.0, fp);
  float lod2 = 1.0 - smoothstep(0.35, 2.0, fp);

  // tangent frame (T along the flow)
  vec3 N0 = normalize(vN);
  vec3 T = vec3(vMisc.z, 0.0, vMisc.w);
  T = normalize(T - N0 * dot(T, N0) + 1e-5);
  vec3 B = cross(N0, T);

  float rapids = smoothstep(0.12, 0.5, steep);
  float nearHead = 1.0 - smoothstep(0.0, 7.0 * w, uHeadS - s);
  float agit = clamp(max(nearHead * 0.85, rapids) + uSurge * 0.3, 0.0, 1.0);

  // flowing ripples, stretched along the flow
  vec3 r1 = gnoised(vec2(lat * 0.28, u * 0.09));
  vec3 r2 = gnoised(vec2(lat * 0.8 + 7.3, u * 0.3));
  float rough = 0.5 + agit * 0.9;
  vec2 gr = (r1.yz * vec2(0.28, 0.09) * 1.1 * lod1 + r2.yz * vec2(0.8, 0.3) * 0.38 * lod2) * rough;
  vec3 N = normalize(N0 - B * gr.x - T * gr.y);
  float NdV = max(dot(N, V), 0.0);

  // ---- body colour
  float core = 1.0 - smoothstep(0.0, 1.0, at);
  float band = vnoise(vec2(lat * 0.2, u * 0.03));
  float lstreak = smoothstep(0.5, 0.85, vnoise(vec2(lat * 0.45 + 2.0, u * 0.055)));
  vec3 col = mix(uShallow, uDeep, clamp(core * 0.8 + (band - 0.5) * 0.35, 0.0, 1.0));
  col = mix(col, uShallow * 1.2, lstreak * 0.4 * (1.0 - agit * 0.5));
  vec3 lightB = waterBodyLight(N);
  col *= lightB;
  vec3 R = reflect(-V, N);
  float F = min(fresnelSchlick(NdV, 0.04), 0.7);
  vec3 sky = skyReflection(R, 0.2);

  // ---- foam
  float fnA = vnoise(vec2(lat * 0.5, u * 0.045));
  float fnB = vnoise(vec2(lat * 1.3 + 3.0, u * 0.13));
  float streaks = fnA * 0.62 + fnB * 0.38;
  float streakFoam = aastep(mix(0.72, 0.40, agit), streaks);
  float lam = 2.4 + w * 0.3;
  float arcPh = (u + 0.6 * w * tl * tl) / lam + fnA * 0.7;
  float arcs = aastep(mix(0.93, 0.68, agit), fract(arcPh)) * aastep(0.42 - agit * 0.2, fnB);
  float edgeN = vnoise(vec2(lat * 0.7, u * 0.18) + 11.0);
  float edge = aastep(0.8 - edgeN * 0.25 - agit * 0.12, at);
  float foam = max(max(streakFoam * mix(0.6, 1.0, agit), arcs * mix(0.6, 1.0, agit)), edge);
  // sparse speckles everywhere (bubbles)
  foam = max(foam, aastep(0.86, vnoise(vec2(lat * 2.2, u * 0.9))) * 0.75 * lod2);

  // the cut: a gap with frothy edges where a bigger river crossed
  float gap = smoothstep(0.4, 0.8, cut);
  foam = max(foam, smoothstep(0.08, 0.35, cut) * (1.0 - gap));

#ifdef HEAD
  {
    float a = vAB.x;
    float front = smoothstep(-0.3, 0.55, a);
    float ds = s - uHeadS;
    float c1 = vnoise3(vec3(lat * 0.32, ds * 0.32 - t * 2.4, t * 1.6));
    float c2 = vnoise3(vec3(lat * 0.85, ds * 0.85 - t * 4.2, t * 2.2) + 5.0);
    float hf = aastep(mix(0.78, 0.28, front), c1 * 0.6 + c2 * 0.4);
    foam = max(foam, hf);
  }
#endif

  vec3 foamCol = uFoam * (uSkyColor * 0.3 + uSunColor * 0.85) * 1.2;
  float alpha = mix(0.8, 0.94, core);

#if SKIN_FX == 1
  // MAGMA: dark cooling crust floating on glowing lava, white-hot cracks
  vec2 vc = voronoi(vec2(lat * 0.22, u * 0.09));
  float crack = 1.0 - smoothstep(0.0, 0.13, vc.y - vc.x);
  float pulse = 0.75 + 0.25 * sin(t * 3.2 + s * 0.07);
  vec3 crust = uDeep * 0.5 * lightB + sky * F * 0.25;
  vec3 hot = mix(uShallow * 1.6, vec3(3.2, 2.0, 0.6), crack * 0.6);
  float lava = max(crack, smoothstep(0.55, 0.9, band + agit * 0.4));
  col = mix(crust, hot * pulse, lava);
  col += uGlow * 1.2 * (1.0 - core) ;
  foamCol = mix(vec3(3.0, 1.7, 0.45), uFoam * 2.2, 0.4);
  foam *= 0.85;
  alpha = 0.97;
#elif SKIN_FX == 2
  // GALAXY: nebula water full of twinkling stars
  float neb = fbm2(vec2(lat * 0.07, u * 0.025) + 4.0);
  float neb2 = fbm2(vec2(lat * 0.15 - 3.0, u * 0.05));
  vec3 cosmos = mix(uDeep * 0.8, uShallow * 0.9, smoothstep(0.35, 0.8, neb));
  cosmos = mix(cosmos, vec3(1.0, 0.35, 0.85), smoothstep(0.62, 0.9, neb2) * 0.55);
  cosmos = mix(cosmos, vec3(0.2, 0.9, 1.1), smoothstep(0.7, 0.95, neb) * 0.35);
  vec2 sc = vec2(lat, phi - t * uFlowSpeed * 0.6) * 0.9;
  vec2 si = floor(sc);
  vec2 so = hash22(si);
  float tw = 0.5 + 0.5 * sin(t * (2.0 + so.x * 4.0) + so.y * 30.0);
  float star = (1.0 - smoothstep(0.0, 0.12, length(fract(sc) - so))) * step(0.55, hash12(si + 3.0)) * tw;
  col = cosmos * (0.65 + 0.35 * lightB) + vec3(1.6, 1.5, 2.2) * star * lod2;
  col += uGlow * 1.5 * (1.0 - core);
  foamCol = mix(uFoam * 1.4, vec3(1.3, 1.0, 2.2), 0.4);
  foam *= 0.8;
#elif SKIN_FX == 3
  // GOLD: molten metal — strong tinted reflections + glints
  col = mix(col, uShallow * sky * 1.6, 0.55);
  col += uSunColor * sunGlints(vec2(lat, u), 0.8, N, V, t) * 10.0 * lod2;
#elif SKIN_FX == 4
  // TOXIC: radioactive glow and bubbles
  col += uShallow * 0.6 * (0.6 + 0.4 * sin(t * 4.0 + s * 0.2)) * (0.4 + core);
  vec2 bb = voronoi(vec2(lat * 0.6, u * 0.4));
  foam = max(foam, (1.0 - smoothstep(0.04, 0.1, abs(bb.x - 0.3))) * 0.8 * lod2);
#elif SKIN_FX == 5
  // GLACIER: icy facets
  vec2 ic = voronoi(vec2(lat * 0.3, u * 0.1));
  col += vec3(0.5, 0.7, 0.9) * (1.0 - smoothstep(0.0, 0.08, ic.y - ic.x)) * 0.5 * lod1;
#endif

#if SKIN_FX != 1 && SKIN_FX != 2
  col = mix(col, sky, F * 0.85);
#endif
  col += sunSpecular(N, V, 500.0, 40.0) * 0.9;
#if SKIN_FX == 0 || SKIN_FX == 5
  col += uSunColor * sunGlints(vec2(lat, u), 1.1, N, V, t) * 6.0 * lod2;
#endif
  // rivals: a thin glowing line of their colour along the banks for instant readability
  col = mix(col, uTint * 1.4, uRival * (1.0 - smoothstep(0.0, 0.06, abs(at - 0.7))) * 0.0);

  col = mix(col, foamCol, foam);
  alpha = max(alpha, foam);
  alpha *= 1.0 - smoothstep(0.98, EXT, at + (edgeN - 0.5) * 0.15);
  alpha *= 1.0 - gap;

  // eliminated: water drains back from the head, leaving a wet stain that dries
  if (uDeadT >= 0.0) {
    float front = uHeadS - uDeadT * 140.0;
    float dryAge = (s - front) / 140.0;
    float alive = 1.0 - smoothstep(-0.05, 0.25, dryAge);
    float wet = smoothstep(-0.05, 0.1, dryAge) * (1.0 - smoothstep(1.0, 7.0, dryAge));
    float rim = (1.0 - smoothstep(0.0, 0.1, abs(dryAge - 0.03))) * step(at, 1.0);
    col = mix(vec3(0.045, 0.04, 0.035), col, alive);
    col = mix(col, foamCol, rim * 0.9);
    alpha = max(mix(wet * 0.45 * (1.0 - smoothstep(0.9, EXT, at)), alpha, alive), rim * 0.9);
  }
#ifdef HEAD
  alpha *= smoothstep(-1.0, -0.5, vAB.x);
#endif
  if (!(alpha >= 0.004)) discard;
  col = applyAtmosphere(col, vWorldPos);
  if (any(isnan(col))) col = vec3(0.0);
  gl_FragColor = vec4(col, min(alpha, 1.0));
}
`;

export const BLOB_VERT = /* glsl */ `
${NOISE_GLSL}
uniform vec3 uCenter;
uniform float uR;
uniform vec3 uVelDir;
uniform float uStretch;
uniform float uSquash;
uniform float uWTime;
uniform float uSeed;
varying vec3 vN;
varying vec3 vWorldPos;
varying vec3 vObj;

vec3 blobPoint(vec3 n) {
  float t = uWTime + uSeed;
  float wob = (vnoise3(n * 1.7 + vec3(t * 0.8, -t * 0.6, t * 0.5)) - 0.5) * 0.2
            + sin(n.x * 3.0 + t * 3.7) * sin(n.z * 2.0 + t * 2.9) * 0.05
            + sin(n.y * 4.0 + t * 5.1) * 0.03;
  vec3 p = n * (1.0 + wob * (1.0 - uSquash * 0.5));
  float al = dot(p, uVelDir);
  p += uVelDir * al * uStretch * (al < 0.0 ? 1.25 : 0.45);
  p.y *= 1.0 - uSquash * 0.82;
  p.xz *= 1.0 + uSquash * 1.4;
  return p;
}

void main() {
  vec3 n = normalize(position);
  vec3 tA = normalize(cross(n, abs(n.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 tB = cross(n, tA);
  vec3 p = blobPoint(n);
  vec3 pa = blobPoint(normalize(n + tA * 0.03));
  vec3 pb = blobPoint(normalize(n + tB * 0.03));
  vec3 nn = cross(pa - p, pb - p);
  nn = dot(nn, nn) > 1e-12 ? normalize(nn) : n;
  if (dot(nn, n) < 0.0) nn = -nn;
  vN = nn;
  vObj = n;
  vec3 wp = uCenter + p * uR;
  vWorldPos = wp;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

export const BLOB_FRAG = /* glsl */ `
${ATMOSPHERE_PARS_GLSL}
${NOISE_GLSL}
${LIGHT_GLSL}
uniform float uWTime;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform vec3 uFoam;
uniform vec3 uGlow;
uniform vec3 uVelDir;
uniform float uAlpha;
uniform float uSquash;
varying vec3 vN;
varying vec3 vWorldPos;
varying vec3 vObj;

void main() {
  float t = uWTime;
  vec3 N = normalize(vN);
  vec3 V = normalize(uCameraPos - vWorldPos);
  float NdV = max(dot(N, V), 0.0);
  vec3 ax = uVelDir;
  vec3 o = normalize(vObj);
  vec3 ref = abs(ax.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 e1 = normalize(cross(ax, ref));
  vec3 e2 = cross(ax, e1);
  float lon = atan(dot(o, e2), dot(o, e1));
  float lat = acos(clamp(dot(o, ax), -1.0, 1.0));

  // transmissive core (bright where the drop is thick), deep tinted rim
  float thick = pow(NdV, 0.7);
  vec3 col = mix(uDeep * 0.85, uShallow * 1.35, thick);
  vec2 vc = voronoi(vec2(lon * 1.6, lat * 2.6) + vec2(t * 0.35, -t * 0.25));
  col += uShallow * 0.35 * (1.0 - smoothstep(0.0, 0.25, vc.y - vc.x)) * thick;
  col *= waterBodyLight(N) * 1.05;

  // white foam seams swirling over the surface, converging at the poles
  float wn = vnoise(vec2(lon * 2.5, lat * 3.5 + t * 0.7));
  float swirl = lon * 7.0 + lat * 3.0 - t * 1.6 + (wn - 0.5) * 2.2;
  float seam = 0.5 + 0.5 * sin(swirl);
  float stripes = aastep(0.83 - 0.1 * smoothstep(1.8, 3.1, lat), seam);
  float cap = aastep(0.6, vnoise(vec2(lon * 4.0, lat * 6.0) - t * 0.8)) * smoothstep(2.0, 2.9, lat);
  float foam = max(stripes * (0.6 + 0.4 * wn), cap * 0.9);
  foam = max(foam, uSquash * aastep(0.45, wn));

  vec3 R = reflect(-V, N);
  float F = fresnelSchlick(NdV, 0.04);
  col = mix(col, skyReflection(R, 0.05), min(F * 1.1, 0.85));
  col += sunSpecular(N, V, 350.0, 25.0) * 1.4;
  col += uShallow * pow(1.0 - NdV, 3.0) * 0.7;
  col += uGlow * 2.0 * (0.4 + 0.6 * pow(1.0 - NdV, 2.0));
  vec3 foamCol = uFoam * (uSkyColor * 0.3 + uSunColor * 0.85) * 1.25;
  col = mix(col, foamCol, foam);
  float alpha = mix(0.84, 1.0, max(F, foam)) * uAlpha;
  gl_FragColor = vec4(applyAtmosphere(col, vWorldPos), alpha);
}
`;
