// Quality presets. Every system reads ctx.quality instead of hard-coding costs.
export const PRESETS = {
  low: {
    name: 'low',
    pixelRatio: 0.75,
    shadows: false,
    shadowMapSize: 1024,
    shadowCascades: 1,
    ao: false,
    bloom: true,
    terrainRings: 4,
    terrainGrid: 64,
    vegetationDensity: 0.35,
    grass: false,
    particles: 0.4,
    drawDistance: 6000,
  },
  medium: {
    name: 'medium',
    pixelRatio: 1,
    shadows: true,
    shadowMapSize: 1024,
    shadowCascades: 2,
    ao: false,
    bloom: true,
    terrainRings: 5,
    terrainGrid: 96,
    vegetationDensity: 0.6,
    grass: true,
    particles: 0.7,
    drawDistance: 9000,
  },
  high: {
    name: 'high',
    pixelRatio: 1.5,
    shadows: true,
    shadowMapSize: 2048,
    shadowCascades: 3,
    ao: true,
    bloom: true,
    terrainRings: 6,
    terrainGrid: 128,
    vegetationDensity: 1,
    grass: true,
    particles: 1,
    drawDistance: 14000,
  },
  ultra: {
    name: 'ultra',
    pixelRatio: 2,
    shadows: true,
    shadowMapSize: 4096,
    shadowCascades: 4,
    ao: true,
    bloom: true,
    terrainRings: 7,
    terrainGrid: 160,
    vegetationDensity: 1.4,
    grass: true,
    particles: 1.3,
    drawDistance: 18000,
  },
};

export function detectQuality(requested) {
  if (requested && PRESETS[requested]) return { ...PRESETS[requested] };
  const mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  const cores = navigator.hardwareConcurrency || 4;
  if (mobile) return { ...PRESETS[cores >= 8 ? 'medium' : 'low'] };
  return { ...PRESETS[cores >= 8 ? 'high' : 'medium'] };
}
