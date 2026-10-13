import { TerrainRenderer } from './terrain/TerrainRenderer.js';
import { Ocean } from './water/Ocean.js';
import { Lakes } from './water/Lakes.js';
import { StreamRenderer } from './water/StreamRenderer.js';
import { AbilityFx } from './props/AbilityFx.js';
import { SkyWater } from './water/SkyWater.js';
import { Vegetation } from './props/Vegetation.js';
import { Landmarks } from './props/Landmarks.js';
import { ForkGates } from './props/ForkGates.js';
import { HazardField } from './props/HazardField.js';

/**
 * Builds and updates everything that lives in the world (not the player logic).
 *   world.terrainRenderer, world.ocean, world.lakes, world.streams (StreamRenderer),
 *   world.skyWater, world.vegetation, world.landmarks
 */
export class World {
  constructor(ctx) {
    this.ctx = ctx;
    this.terrainRenderer = new TerrainRenderer(ctx);
    this.ocean = new Ocean(ctx);
    this.lakes = new Lakes(ctx);
    this.skyWater = new SkyWater(ctx);
    this.vegetation = new Vegetation(ctx);
    this.landmarks = new Landmarks(ctx);
    this.forkGates = new ForkGates(ctx);
    this.hazardField = new HazardField(ctx);
    this.abilityFx = new AbilityFx(ctx);
    this.streams = new StreamRenderer(ctx);
    this.parts = [this.terrainRenderer, this.ocean, this.lakes, this.skyWater, this.vegetation, this.landmarks, this.forkGates, this.hazardField, this.abilityFx, this.streams];
  }

  async init(onProgress = () => {}) {
    for (let i = 0; i < this.parts.length; i++) {
      await this.parts[i].init?.();
      onProgress((i + 1) / this.parts.length);
    }
  }

  /** Reset per-match state (lakes refilled, trails cleared). */
  reset() {
    for (const p of this.parts) p.reset?.();
  }

  update(dt, time) {
    for (const p of this.parts) p.update?.(dt, time);
  }
}
