import * as THREE from 'three';

/** The sea around the island (the finish line). Skeleton: flat translucent plane. */
export class Ocean {
  constructor(ctx) {
    this.ctx = ctx;
  }

  init() {
    const size = this.ctx.terrain.size * 4;
    const geo = new THREE.PlaneGeometry(size, size, 1, 1);
    geo.rotateX(-Math.PI / 2);
    this.material = new THREE.MeshStandardMaterial({
      color: 0x1aa6c9,
      roughness: 0.15,
      metalness: 0.0,
      transparent: true,
      opacity: 0.85,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.position.y = this.ctx.terrain.seaLevel;
    this.ctx.scene.add(this.mesh);
  }

  update() {}
}
