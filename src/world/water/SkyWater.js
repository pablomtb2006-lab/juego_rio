import * as THREE from 'three';
import { mulberry32 } from '../../core/random.js';

/**
 * Rain clouds you can fly through during the DROP phase to gain water.
 * Same body contract as Lakes (Rules treats both generically):
 *   skyWater.bodies: [{ id, kind: 'cloud', x, y, z, radius, volume, maxVolume }]
 *   skyWater.drain(body, litres) -> litres removed
 *   skyWater.reset()
 */
export class SkyWater {
  constructor(ctx) {
    this.ctx = ctx;
    this.bodies = [];
    this.group = new THREE.Group();
    ctx.scene.add(this.group);
  }

  init() {
    const { terrain } = this.ctx;
    const rand = mulberry32(terrain.seed * 31 + 5);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.7, roughness: 1 });
    const geo = new THREE.IcosahedronGeometry(1, 2);
    for (let i = 0; i < 40; i++) {
      const a = rand() * Math.PI * 2;
      const r = rand() * terrain.size * 0.35;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const y = 1600 + rand() * 1600;
      const radius = 40 + rand() * 60;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, y, z);
      mesh.scale.set(radius * 1.6, radius * 0.7, radius * 1.3);
      this.group.add(mesh);
      const volume = Math.round(radius * radius * 900);
      this.bodies.push({ id: i, kind: 'cloud', x, y, z, radius, volume, maxVolume: volume, mesh });
    }
  }

  drain(body, litres) {
    const taken = Math.min(body.volume, litres);
    body.volume -= taken;
    return taken;
  }

  reset() {
    for (const b of this.bodies) b.volume = b.maxVolume;
  }

  update() {
    for (const b of this.bodies) {
      const f = b.volume / b.maxVolume;
      b.mesh.visible = f > 0.02;
      b.mesh.material.opacity = 0.7;
    }
  }
}
