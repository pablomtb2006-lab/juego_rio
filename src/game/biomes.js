import * as THREE from 'three';

/**
 * EL BIOMA DE LA PARTIDA (TRAMO G) — la misma isla, otro mundo cada carrera.
 *
 * The island's geometry never changes (it is the thing the whole game is built on: hydrology,
 * routes, forks, dams). What changes is everything you can SEE and a handful of things you can
 * FEEL: the hour of the day, the colour of the ground and the sky, whether there is snow on it,
 * which traps the island grows, how well you grip and how fast you dry out.
 *
 * That is the honest way to kill the monotony without rebuilding the map: one seed, one world.
 *
 * Every field is optional; what is missing means "as it always was".
 *   tod       0..1 time of day (0.5 = noon) — drives the sun, the sky, the fog, the grade
 *   tint      colour the ground, the props and the sky are pulled toward
 *   tintAmt   how hard (0..1)
 *   sat       saturation multiplier on the ground (1 = untouched)
 *   bright    brightness multiplier on the ground
 *   snow      0..1 snow cover down the whole mountain
 *   ember     colour glowed into the valley floors (lava cracks), or null
 *   veil      0..1 permanent screen veil (storm, ash)
 *   hazards   per-kind weight multipliers for game/Hazards.js
 *   grip      multiplier on how fast you can turn
 *   evap      multiplier on evaporation
 *   inflow    multiplier on what the valleys feed you
 *   weight    how often it comes up in the draw
 *
 * Contract: `game.biome` is set in startMatch before anything reads it. Nothing else may
 * decide "this match looks different" — add a field here instead.
 */
export const BIOMES = {
  templado: {
    id: 'templado',
    icon: '🌤️',
    tod: 0.5,
    tint: 0x9bcb32,
    tintAmt: 0,
    sat: 1,
    bright: 1,
    snow: 0,
    ember: null,
    veil: 0,
    hazards: {},
    grip: 1,
    evap: 1,
    inflow: 1,
    weight: 2.0, // the baseline look: the one you see most
  },
  alba: {
    id: 'alba',
    icon: '🌅',
    tod: 0.3, // dawn: long shadows, the whole island amber
    tint: 0xffb46a,
    tintAmt: 0.17,
    sat: 1.04,
    bright: 1.02,
    snow: 0,
    ember: null,
    veil: 0,
    hazards: { sun: 1.9, steam: 1.5, ice: 0.3 },
    grip: 1,
    evap: 0.9,
    inflow: 1,
    weight: 1.2,
  },
  hielo: {
    id: 'hielo',
    icon: '🧊',
    tod: 0.42,
    tint: 0xbfe2f5,
    tintAmt: 0.26,
    sat: 0.58, // the colour drains out of the island
    bright: 1.0,
    snow: 0.6,
    ember: null,
    veil: 0.12,
    hazards: { ice: 5, steam: 2.2, sand: 0.1, lava: 0.15, sun: 0.1 },
    grip: 0.74, // you slide: every bend has to be taken early
    evap: 0.72, //  …but nothing dries out in the cold
    inflow: 0.92,
    weight: 1.1,
  },
  volcan: {
    id: 'volcan',
    icon: '🌋',
    tod: 0.69, // late afternoon, so the embers read without the island going black
    tint: 0x4a3630,
    tintAmt: 0.34, // scorched basalt instead of grass
    sat: 0.55,
    bright: 1.02,
    snow: 0,
    ember: 0x8c2a06, // glowing cracks down the valley floors
    veil: 0.12,
    hazards: { lava: 5, geyser: 3, rocks: 1.6, ice: 0.05, sun: 1.4, sand: 0.5 },
    grip: 1,
    evap: 1.4, // the stone cooks you
    inflow: 0.95,
    weight: 1.1,
  },
  selva: {
    id: 'selva',
    icon: '🌴',
    tod: 0.47,
    tint: 0x1d6b34,
    tintAmt: 0.24,
    sat: 1.3, // everything greener and heavier
    bright: 0.94,
    snow: 0,
    ember: null,
    veil: 0.1,
    hazards: { sinkhole: 2.4, steam: 2, rocks: 1.5, sun: 0.3, ice: 0.05 },
    grip: 1,
    evap: 0.78, // humid
    inflow: 1.18, //  …and every valley runs full
    weight: 1.1,
  },
  tormenta: {
    id: 'tormenta',
    icon: '⛈️',
    tod: 0.7, // the light goes, but you still have to see where you are going
    tint: 0x5b6d88,
    tintAmt: 0.3,
    sat: 0.62,
    bright: 0.94,
    snow: 0,
    ember: null,
    veil: 0.3, // you race through the rain
    hazards: { steam: 2.6, rocks: 1.8, sun: 0.05, lava: 0.4 },
    grip: 0.88,
    evap: 0.85,
    inflow: 1.22, // the rain fills the valleys
    weight: 1.0,
  },
};

export const BIOME_IDS = Object.keys(BIOMES);

/** Draw the biome for a match from its seed. */
export function biomeFor(rand) {
  let total = 0;
  for (const id of BIOME_IDS) total += BIOMES[id].weight;
  let r = rand() * total;
  for (const id of BIOME_IDS) {
    r -= BIOMES[id].weight;
    if (r <= 0) return BIOMES[id];
  }
  return BIOMES.templado;
}

/**
 * The uniform block every biome-aware material shares (terrain, props). One object, written
 * once per match, read by every shader — no recompiles, no per-frame work.
 */
export const BIOME_UNIFORMS = {
  uBiomeTint: { value: new THREE.Color(1, 1, 1) },
  uBiome: { value: new THREE.Vector4(0, 1, 1, 0) }, // tintAmt, sat, bright, snow
  uBiomeEmber: { value: new THREE.Color(0, 0, 0) },
};

/** Push a biome into the shared uniforms. Called from Game.startMatch. */
export function applyBiomeUniforms(b) {
  BIOME_UNIFORMS.uBiomeTint.value.set(b.tint ?? 0xffffff).convertSRGBToLinear();
  BIOME_UNIFORMS.uBiome.value.set(b.tintAmt ?? 0, b.sat ?? 1, b.bright ?? 1, b.snow ?? 0);
  if (b.ember) BIOME_UNIFORMS.uBiomeEmber.value.set(b.ember).convertSRGBToLinear();
  else BIOME_UNIFORMS.uBiomeEmber.value.setRGB(0, 0, 0);
}

/** The GLSL every biome-aware fragment shader appends. `col` in, `col` out. */
export const BIOME_GRADE_GLSL = /* glsl */ `
uniform vec3 uBiomeTint;
uniform vec4 uBiome;   // tintAmt, sat, bright, snow
uniform vec3 uBiomeEmber;

vec3 applyBiome(vec3 col, float snowMask, float emberMask) {
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(lum), col, uBiome.y);
  col = mix(col, uBiomeTint * (lum * 0.6 + 0.55), uBiome.x);
  col += uBiomeEmber * emberMask;
  col = mix(col, vec3(0.95, 0.97, 1.0), uBiome.w * snowMask);
  return col * uBiome.z;
}
`;
