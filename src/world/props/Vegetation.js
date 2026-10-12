import * as THREE from 'three';
import { mulberry32 } from '../../core/random.js';

/** Trees, rocks, grass. Skeleton: instanced cones on gentle slopes. */
export class Vegetation {
  constructor(ctx) {
    this.ctx = ctx;
  }

  init() {
    const { terrain, scene, quality } = this.ctx;
    const rand = mulberry32(terrain.seed + 99);
    const count = Math.floor(6000 * quality.vegetationDensity);
    const geo = new THREE.ConeGeometry(4, 16, 6).translate(0, 8, 0);
    const mat = new THREE.MeshStandardMaterial({ color: 0x2f5a2a, roughness: 0.9 });
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    const m = new THREE.Matrix4();
    const n = new THREE.Vector3();
    let placed = 0;
    for (let tries = 0; tries < count * 6 && placed < count; tries++) {
      const x = (rand() - 0.5) * terrain.size;
      const z = (rand() - 0.5) * terrain.size;
      const y = terrain.heightAt(x, z);
      if (y < 15 || y > 750) continue;
      if (terrain.normalAt(x, z, n).y < 0.85) continue;
      const s = 0.7 + rand() * 0.8;
      m.makeScale(s, s, s).setPosition(x, y - 0.5, z);
      mesh.setMatrixAt(placed++, m);
    }
    mesh.count = placed;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    this.mesh = mesh;
  }

  update() {}
}
