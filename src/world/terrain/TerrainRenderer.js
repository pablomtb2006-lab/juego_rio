import * as THREE from 'three';

/**
 * Draws ctx.terrain. Skeleton version: a single displaced plane with vertex colours.
 * Contract: constructor(ctx), init(), update(dt, time). Adds its meshes to ctx.scene.
 * Exposes `material` (so props/water can match lighting if needed).
 */
export class TerrainRenderer {
  constructor(ctx) {
    this.ctx = ctx;
  }

  init() {
    const { terrain, scene } = this.ctx;
    const seg = 384;
    const geo = new THREE.PlaneGeometry(terrain.size, terrain.size, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    const n = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const y = terrain.heightAt(x, z);
      pos.setY(i, y);
      terrain.normalAt(x, z, n);
      if (y < 4) c.set(0xd9c79a);
      else if (n.y < 0.75) c.set(0x7d7368);
      else if (y > 900) c.set(0xf2f4f7);
      else c.set(0x5f9a3c).lerp(new THREE.Color(0x8a8a4a), Math.min(y / 900, 1));
      colors.set([c.r, c.g, c.b], i * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    this.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.receiveShadow = true;
    scene.add(this.mesh);
  }

  update() {}
}
