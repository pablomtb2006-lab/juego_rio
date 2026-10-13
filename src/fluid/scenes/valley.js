import { Terrain } from '../Terrain.js';

/**
 * El valle — four rivers born at springs on a hillside, running down carved channels that join
 * pairwise (two confluences) and then into one main river that reaches the sea. Rivers meet the
 * way real ones do: at confluences. Units: metres. Downhill is +x.
 *
 *   springs (x = −13.5)        confluences                    sea (x > 13.5)
 *   z = −6.5  ─┐
 *              ├─ (−3, −4.2) ─┐
 *   z = −2    ─┘              │
 *                             ├─ (7, −0.2) ── main river ──▶ sink
 *   z = 2.5   ─┐              │
 *              ├─ (−1, 4.0) ──┘
 *   z = 7     ─┘
 */
export const VALLEY_DOMAIN = { min: [-15, 0, -10], max: [15, 6, 10] };

export const VALLEY_TERRAIN = {
  base: {
    x0: -15,
    h0: 3.4,
    slope: 0.1, // 10 %: water reaches ~1–2 m/s, like a mountain stream
    drop: { from: 10.5, to: 15, depth: 0.9 }, // the land falls into the sea
    edges: { from: 6.5, to: 10, rise: 1.8 }, // the valley sides
    waves: [
      [0.12, 0.55, 0.32],
      [0.08, -0.31, 0.71],
    ],
  },
  depth: 0.75,
  channels: [
    { width: 0.85, points: [[-15.5, -6.5], [-10, -6.9], [-6, -5.6], [-3, -4.2]] },
    { width: 0.85, points: [[-15.5, -2], [-10, -2.5], [-6, -3.3], [-3, -4.2]] },
    { width: 0.85, points: [[-15.5, 2.5], [-10, 3.2], [-5, 3.7], [-1, 4.0]] },
    { width: 0.85, points: [[-15.5, 7], [-10, 6.7], [-5, 5.5], [-1, 4.0]] },
    { width: 1.1, points: [[-3, -4.2], [1, -3.6], [4.5, -1.9], [7, -0.2]] },
    { width: 1.1, points: [[-1, 4.0], [3, 3.3], [5.5, 1.4], [7, -0.2]] },
    { width: 1.35, points: [[7, -0.2], [9.5, 0.7], [12, 0.3], [16, 0]] },
  ],
};

export const VALLEY_SINK = { min: [13.6, -1, -10], max: [15, 3, 10] };
export const SEA_LEVEL = 0.62;

/** Rocks in the water (spheres), placed on the ground of the terrain. */
export function valleyRocks(terrain) {
  return [
    [-8.2, -2.9, 0.38],
    [-7.5, 6.2, 0.42],
    [2.6, -3.1, 0.45],
    [4.4, 2.3, 0.4],
    [9.8, 0.75, 0.5],
    [11.6, 0.0, 0.35],
  ].map(([x, z, r]) => ({ center: [x, terrain.height(x, z) - r * 0.25, z], radius: r }));
}

/** Rivers: different springs → different flows → different masses. Springs sit on their channel's axis. */
export const VALLEY_RIVERS = [
  { name: 'Tú', type: 'player', color: [0.1, 0.85, 0.8], spring: { at: [-13.5, -2.18], dir: [1, -0.35, -0.09], radius: 0.4, speed: 1.6 }, resistance: 0.4 },
  { name: 'Voltio', color: [0.15, 0.45, 1.0], spring: { at: [-13.5, -6.65], dir: [1, -0.35, -0.07], radius: 0.28, speed: 1.5 }, personality: 'agresivo' },
  { name: 'Jade', color: [0.1, 0.8, 0.4], spring: { at: [-13.5, 2.75], dir: [1, -0.35, 0.13], radius: 0.38, speed: 1.6 }, personality: 'territorial' },
  { name: 'Coral', color: [1.0, 0.38, 0.32], spring: { at: [-13.5, 6.89], dir: [1, -0.35, -0.05], radius: 0.3, speed: 1.5 }, personality: 'oportunista' },
];

/**
 * Absorption at a confluence: the streams meet side by side, so the contact surface is smaller than
 * in a head-on duel of two bodies (measured: 0.7–3 m² for 1–3 m³ rivers, against 3–12 m²). The
 * reference area for φ_A is scaled accordingly; all other rules are the same.
 */
export const VALLEY_ABSORPTION = { areaRefCoef: 1.0 };

export function makeValley() {
  const terrain = new Terrain(VALLEY_TERRAIN);
  return { domain: VALLEY_DOMAIN, terrain, rocks: valleyRocks(terrain), sink: VALLEY_SINK, rivers: VALLEY_RIVERS, seaLevel: SEA_LEVEL, absorption: VALLEY_ABSORPTION };
}
