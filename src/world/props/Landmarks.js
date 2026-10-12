import * as THREE from 'three';

/**
 * Hand-placed hero props. The rock arch on the highest peak is the iconic drop
 * gate from the reference trailer ("THE GOAL?"). Contract:
 *   landmarks.arch = { position: Vector3, radius }  (drop scenarios aim through it)
 */
export class Landmarks {
  constructor(ctx) {
    this.ctx = ctx;
  }

  init() {
    const { terrain, scene } = this.ctx;
    const peak = terrain.peaks[0] ?? { x: 0, y: 800, z: 0 };
    const geo = new THREE.TorusGeometry(60, 18, 10, 24, Math.PI);
    const mat = new THREE.MeshStandardMaterial({ color: 0x9a8670, roughness: 1 });
    const arch = new THREE.Mesh(geo, mat);
    arch.position.set(peak.x, peak.y - 5, peak.z);
    arch.castShadow = true;
    scene.add(arch);
    this.arch = { position: new THREE.Vector3(peak.x, peak.y + 40, peak.z), radius: 50, mesh: arch };
  }

  update() {}
}
