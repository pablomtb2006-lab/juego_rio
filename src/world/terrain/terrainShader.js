// GLSL injected into MeshStandardMaterial (and its shadow depth twin) by TerrainRenderer.
// Vertex: CDLOD morph + bicubic height + detail noise (bit-for-bit the CPU heightAt formula).
// Fragment: stylised layered material (meadow, dry alpine grass, forest floor, valley dirt,
// faceted triplanar rock with strata, orange coastal rock, snow, sand, wet shores, lake beds
// and sea floor). Lighting, shadows and fog stay three.js' own.

import * as THREE from 'three';
import { DETAIL_GLSL } from './detail.js';

/** sRGB hex → linear vec3 literal. */
const lin = (hex) => {
  const c = new THREE.Color().setHex(hex); // ColorManagement converts sRGB → linear
  return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;
};

export const TERRAIN_VERTEX_PARS = /* glsl */ `
attribute vec4 aNode;            // node origin xz, node size, LOD level
uniform highp sampler2D tHeight; // R32F heights (texelFetch only)
uniform sampler2D tMask;         // RGBA8: detail amount, coast, water, forest
uniform sampler2D tInfo;         // RGBA16F: dh/dx, dh/dz, flow, ao
uniform vec4 uTerrain;           // size, res, cell, res-1
uniform vec3 uLodCam;
uniform float uLodR0;
uniform float uPatchN;
varying vec3 vTPos;
${DETAIL_GLSL}

float tH(int x, int y) { return texelFetch(tHeight, ivec2(x, y), 0).r; }
vec4 crW(float t) {
  float t2 = t * t;
  float t3 = t2 * t;
  return vec4(-0.5 * t3 + t2 - 0.5 * t, 1.5 * t3 - 2.5 * t2 + 1.0, -1.5 * t3 + 2.0 * t2 + 0.5 * t, 0.5 * t3 - 0.5 * t2);
}
// Catmull-Rom bicubic on the height grid (same clamping as gen/grid.js sampleBicubic)
float terrainBase(vec2 g) {
  float mx = uTerrain.w;
  g = clamp(g, vec2(0.0), vec2(mx));
  vec2 fi = min(floor(g), vec2(mx - 1.0));
  vec2 t = g - fi;
  vec4 wx = crW(t.x);
  vec4 wz = crW(t.y);
  int M = int(mx);
  ivec2 b = ivec2(fi);
  int x0 = max(b.x - 1, 0);
  int x1 = b.x;
  int x2 = min(b.x + 1, M);
  int x3 = min(b.x + 2, M);
  float s = 0.0;
  for (int r = 0; r < 4; r++) {
    int y = clamp(b.y - 1 + r, 0, M);
    float row = wx.x * tH(x0, y) + wx.y * tH(x1, y) + wx.z * tH(x2, y) + wx.w * tH(x3, y);
    s += wz[r] * row;
  }
  return s;
}
// bilinear on texel centres (same as sampleBilinear) of a texelFetch'd channel
float maskAmp(vec2 g) {
  float mx = uTerrain.w;
  g = clamp(g, vec2(0.0), vec2(mx));
  vec2 fi = min(floor(g), vec2(mx - 1.0));
  vec2 f = g - fi;
  ivec2 b = ivec2(fi);
  float a = texelFetch(tMask, b, 0).r;
  float c1 = texelFetch(tMask, b + ivec2(1, 0), 0).r;
  float c2 = texelFetch(tMask, b + ivec2(0, 1), 0).r;
  float c3 = texelFetch(tMask, b + ivec2(1, 1), 0).r;
  return (a + (c1 - a) * f.x) * (1.0 - f.y) + (c2 + (c3 - c2) * f.x) * f.y;
}
float terrainApprox(vec2 g) {
  float mx = uTerrain.w;
  g = clamp(g, vec2(0.0), vec2(mx));
  vec2 fi = min(floor(g), vec2(mx - 1.0));
  vec2 f = g - fi;
  ivec2 b = ivec2(fi);
  float a = tH(b.x, b.y);
  float c1 = tH(b.x + 1, b.y);
  float c2 = tH(b.x, b.y + 1);
  float c3 = tH(b.x + 1, b.y + 1);
  return (a + (c1 - a) * f.x) * (1.0 - f.y) + (c2 + (c3 - c2) * f.x) * f.y;
}
float terrainHeight(vec2 xz) {
  vec2 g = (xz / uTerrain.x + 0.5) * uTerrain.w;
  float h = terrainBase(g);
  float a = maskAmp(g);
  if (a > 0.0) h += a * DETAIL_MAX * detailValue(xz);
  return h;
}
void terrainVertex(out vec3 pos, out vec3 nrm) {
  vec2 gp = position.xz; // integer grid coordinates 0..N
  vec2 wxz = aNode.xy + gp / uPatchN * aNode.z;
  float hA = terrainApprox((wxz / uTerrain.x + 0.5) * uTerrain.w);
  float dist = distance(uLodCam, vec3(wxz.x, hA, wxz.y));
  float rEnd = uLodR0 * exp2(aNode.w);
  float mk = clamp((dist - 0.7 * rEnd) / (0.3 * rEnd), 0.0, 1.0);
  gp -= mod(gp, 2.0) * mk; // odd vertices slide onto the coarser grid
  wxz = aNode.xy + gp / uPatchN * aNode.z;
  pos = vec3(wxz.x, terrainHeight(wxz), wxz.y);
  vTPos = pos;
  vec2 uv = ((wxz / uTerrain.x + 0.5) * uTerrain.w + 0.5) / uTerrain.y;
  vec2 gr = textureLod(tInfo, uv, 0.0).xy;
  nrm = normalize(vec3(-gr.x, 1.0, -gr.y));
}
`;

export const TERRAIN_FRAGMENT_PARS = /* glsl */ `
uniform sampler2D tInfo;
uniform sampler2D tMask;
uniform sampler2D tNoise;
uniform sampler2D tRock;
uniform sampler2D tGround;
uniform vec4 uTerrain;
varying vec3 vTPos;
${DETAIL_GLSL}

const vec3 C_GRASS_COOL = ${lin(0x5dbb3a)};
const vec3 C_GRASS_WARM = ${lin(0x8ccb3f)};
const vec3 C_GRASS_LUSH = ${lin(0x3f9e33)};
const vec3 C_GRASS_DRY = ${lin(0xb9b45a)};
const vec3 C_ALPINE = ${lin(0x9fae55)};
const vec3 C_FOREST = ${lin(0x2f6a2f)};
const vec3 C_LITTER = ${lin(0x6b5a3a)};
const vec3 C_DIRT = ${lin(0x9a7f5c)};
const vec3 C_PEBBLE = ${lin(0xb3a68e)};
const vec3 C_ROCK = ${lin(0x8e8174)};
const vec3 C_ROCK_DARK = ${lin(0x5f554d)};
const vec3 C_ROCK_LIGHT = ${lin(0xb3a594)};
const vec3 C_ROCK_COAST = ${lin(0xd07a4a)};
const vec3 C_ROCK_COAST_DK = ${lin(0x9c4e2c)};
const vec3 C_SNOW = ${lin(0xf4f8ff)};
const vec3 C_SNOW_SHADE = ${lin(0xc9daf2)};
const vec3 C_SAND = ${lin(0xe8d3a0)};
const vec3 C_SAND_WET = ${lin(0xb39a6c)};
const vec3 C_SEABED_SHALLOW = ${lin(0xd9cb98)};
const vec3 C_SEABED_MID = ${lin(0x4fa79b)};
const vec3 C_SEABED_DEEP = ${lin(0x1c5a6e)};
const vec3 C_LAKEBED = ${lin(0x7d7d55)};
const vec3 C_FLOWER_A = ${lin(0xffe36e)};
const vec3 C_FLOWER_B = ${lin(0xffffff)};

// triplanar weights (sharp) for normal n
vec3 triW(vec3 n) {
  vec3 w = pow(abs(n), vec3(6.0));
  return w / (w.x + w.y + w.z);
}
// whiteout-blended triplanar tangent normal (Golus) — returns world normal
vec3 triNormal(sampler2D tex, vec3 p, vec3 n, float scale, float strength, out vec4 sampleAvg) {
  vec3 w = triW(n);
  vec4 sx = texture(tex, p.zy * scale);
  vec4 sy = texture(tex, p.xz * scale + 0.5);
  vec4 sz = texture(tex, p.xy * scale + 0.25);
  sampleAvg = sx * w.x + sy * w.y + sz * w.z;
  vec3 tx = vec3((sx.xy * 2.0 - 1.0) * strength, 1.0);
  vec3 ty = vec3((sy.xy * 2.0 - 1.0) * strength, 1.0);
  vec3 tz = vec3((sz.xy * 2.0 - 1.0) * strength, 1.0);
  tx = vec3(tx.xy + n.zy, abs(tx.z) * n.x);
  ty = vec3(ty.xy + n.xz, abs(ty.z) * n.y);
  tz = vec3(tz.xy + n.xy, abs(tz.z) * n.z);
  return normalize(tx.zyx * w.x + ty.xzy * w.y + tz.xyz * w.z);
}
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;

export const TERRAIN_FRAGMENT_MAIN = /* glsl */ `
vec3 P = vTPos;
vec2 tuv = ((P.xz / uTerrain.x + 0.5) * uTerrain.w + 0.5) / uTerrain.y;
vec4 info = texture(tInfo, tuv);
vec4 msk = texture(tMask, tuv);
float camDist = length(P - cameraPosition);
float near = 1.0 - smoothstep(120.0, 700.0, camDist);   // close-up detail fade
float mid = 1.0 - smoothstep(900.0, 4000.0, camDist);

// ---- geometric normal: macro gradient map + analytic detail layer ----
vec2 grad = info.xy;
#if TERRAIN_HQ
if (msk.r > 0.003 && camDist < 2500.0) grad += msk.r * DETAIL_MAX * detailNoise(P.xz).yz;
#endif
vec3 tNg = normalize(vec3(-grad.x, 1.0, -grad.y));
float slope = 1.0 - tNg.y;          // 0 flat · 0.13 ≈ 30° · 0.29 ≈ 45°
float h = P.y;
float flow = info.z;
float bakedAO = info.w;
float coast = msk.g;
float water = msk.b;
float forest = msk.a;

// ---- macro variation (anti-tiling, large warm/cool patches) ----
vec4 nM = texture(tNoise, P.xz / 2600.0);
vec4 nL = texture(tNoise, P.xz / 640.0 + 0.37);
vec4 nS = texture(tNoise, P.xz / 113.0 + 0.71);
vec4 nT = texture(tNoise, P.xz / 23.0 + 0.13);

// ---- meadow ----
vec4 g1 = texture(tGround, P.xz / 9.0);
vec4 g2 = texture(tGround, P.xz / 2.7 + 0.5);
float warm = smoothstep(0.3, 0.72, nM.r + (nL.g - 0.5) * 0.35);
vec3 grass = mix(C_GRASS_COOL, C_GRASS_WARM, warm);
grass = mix(grass, C_GRASS_LUSH, smoothstep(0.55, 0.8, nL.r) * 0.55);
grass *= 0.86 + 0.28 * mix(0.5, g1.a, near) + (nS.g - 0.5) * 0.18;
// altitude: alpine meadow → dry grass
float dry = smoothstep(650.0, 1150.0, h + (nL.b - 0.5) * 260.0);
grass = mix(grass, mix(C_ALPINE, C_GRASS_DRY, smoothstep(0.35, 0.7, nS.r)), dry);
// steeper grass a touch darker/cooler (reads the landform from far away)
grass *= 1.0 - smoothstep(0.05, 0.22, slope) * 0.18;
// forest floor (under the trees)
float fo = smoothstep(0.15, 0.85, forest + (nS.b - 0.5) * 0.3);
grass = mix(grass, mix(C_FOREST, C_LITTER, smoothstep(0.5, 0.85, nT.r) * 0.45), fo * 0.42);
// stylised flower specks close to the camera
float speck = smoothstep(0.62, 0.9, g2.a) * near * (1.0 - fo) * (1.0 - dry) * step(0.55, nL.g);
grass = mix(grass, mix(C_FLOWER_A, C_FLOWER_B, step(0.5, nT.g)), speck * 0.55);

// ---- valley floors: dirt + pale pebbles along the drainage lines ----
float bed = smoothstep(0.8, 0.97, flow + (nS.a - 0.5) * 0.1) * (1.0 - smoothstep(0.06, 0.16, slope));
vec3 dirt = mix(C_DIRT, C_PEBBLE, smoothstep(0.4, 0.7, nT.b));
vec3 col = mix(grass, dirt, bed * 0.65);

// ---- rock ----
float alpine = smoothstep(700.0, 1400.0, h);
float rockThr = mix(0.21, 0.13, alpine) - coast * 0.05;
float rockN = (nS.r - 0.5) * 0.10 + (nT.a - 0.5) * 0.05;
float rockAmt = smoothstep(rockThr - 0.015, rockThr + 0.015, slope + rockN);
rockAmt = max(rockAmt, smoothstep(0.06, 0.12, slope + rockN) * smoothstep(1550.0, 1700.0, h));
vec4 rs;
vec3 rockN1 = triNormal(tRock, P, tNg, 1.0 / 26.0, 1.0, rs);
vec4 rs2 = rs;
#if TERRAIN_HQ
vec3 rockN2 = triNormal(tRock, P, rockN1, 1.0 / 7.0, 0.7 * near, rs2);
rockN1 = normalize(mix(rockN1, rockN2, near));
#endif
float strata = sin((h + (nS.g - 0.5) * 40.0) * 0.55) * 0.5 + 0.5;
vec3 rock = mix(C_ROCK_DARK, C_ROCK_LIGHT, clamp(rs.a * 0.9 + strata * 0.25 + (nL.a - 0.5) * 0.4, 0.0, 1.0));
rock = mix(rock, C_ROCK, 0.35);
vec3 coastRock = mix(C_ROCK_COAST_DK, C_ROCK_COAST, clamp(rs.a * 1.1 + strata * 0.2, 0.0, 1.0));
float orange = smoothstep(0.45, 0.8, coast + (nL.r - 0.5) * 0.25) * (1.0 - smoothstep(180.0, 320.0, h));
rock = mix(rock, coastRock, orange);
float cav = mix(rs.b, rs2.b, near * 0.5);
rock *= 0.55 + 0.45 * cav;
// sunlit tops of facets slightly brighter (edge wear)
rock *= 1.0 + 0.12 * clamp(dot(rockN1, vec3(0.0, 1.0, 0.0)) - tNg.y, 0.0, 1.0);
col = mix(col, rock, rockAmt);

// ---- snow ----
float snowLine = 1460.0 + (nL.r - 0.5) * 220.0 + (nS.b - 0.5) * 70.0;
float snow = smoothstep(snowLine, snowLine + 40.0, h) * (1.0 - smoothstep(0.16, 0.2, slope + (nS.a - 0.5) * 0.08 + (nT.a - 0.5) * 0.05));
vec3 snowC = mix(C_SNOW_SHADE, C_SNOW, smoothstep(0.2, 0.8, g1.b * 0.6 + bakedAO * 0.6));
col = mix(col, snowC, snow);

// ---- beaches, lake shores, wet sand ----
float beach = (1.0 - smoothstep(2.5, 6.0, h + (nS.r - 0.5) * 3.0)) * (1.0 - smoothstep(0.12, 0.22, slope)) * step(-0.5, h);
col = mix(col, C_SAND * (0.92 + 0.16 * g1.a), beach * (1.0 - rockAmt * 0.7));
float shore = smoothstep(0.02, 0.5, water) * (1.0 - step(0.99, water));
col = mix(col, mix(C_SAND, C_PEBBLE, 0.5), shore * 0.75);
float wet = (1.0 - smoothstep(0.3, 1.6, h)) * step(-0.2, h) + smoothstep(0.35, 0.8, water) * (1.0 - step(0.99, water));
col = mix(col, col * 0.62, clamp(wet, 0.0, 1.0));

// ---- under still water / sea floor ----
float lakeBed = step(0.99, water);
col = mix(col, C_LAKEBED * (0.85 + 0.3 * nT.r), lakeBed);
float sub = smoothstep(0.2, -0.6, h);
vec3 seabed = mix(C_SEABED_SHALLOW, C_SEABED_MID, smoothstep(1.0, 14.0, -h));
seabed = mix(seabed, C_SEABED_DEEP, smoothstep(12.0, 70.0, -h));
seabed *= 0.85 + 0.3 * nS.r;
seabed = mix(seabed, rock * 0.8, rockAmt * 0.6);
col = mix(col, seabed, sub);

// ---- normal ----
vec3 gN = normalize(tNg + vec3(g1.x * 2.0 - 1.0, 0.0, g1.y * 2.0 - 1.0) * 0.35 * near + vec3(g2.x * 2.0 - 1.0, 0.0, g2.y * 2.0 - 1.0) * 0.25 * near);
vec3 tN = normalize(mix(gN, rockN1, rockAmt));
tN = normalize(mix(tN, tNg, max(snow * 0.7, sub * 0.6)));

// ---- roughness / occlusion ----
float tRough = mix(0.95, 0.8, rockAmt);
tRough = mix(tRough, 0.6, snow);
tRough = mix(tRough, 0.35, clamp(wet, 0.0, 1.0));
float tAO = mix(1.0, bakedAO, 0.85);
tAO *= mix(1.0, 0.6 + 0.4 * cav, rockAmt);
tAO *= mix(1.0, 0.75 + 0.25 * g1.b, near * (1.0 - rockAmt));
tAO *= 1.0 - fo * 0.25;

diffuseColor.rgb = col;
`;
