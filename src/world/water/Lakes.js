import * as THREE from 'three';

/**
 * Still water you can swallow (lakes + puddles). Contract used by game/Rules.js:
 *   lakes.bodies: [{ id, kind: 'lake'|'puddle', x, y, z, radius, volume, maxVolume, drainedBy }]
 *     (x, y, z) = centre of the water surface; radius in metres; volume in litres.
 *   lakes.drain(body, litres) -> litres actually removed (also animates the surface).
 *   lakes.reset() refills everything for a new match.
 * A body is "empty" when volume <= 0; the renderer should show it dried out.
 */
export class Lakes {
  constructor(ctx) {
    this.ctx = ctx;
    this.bodies = [];
    this.group = new THREE.Group();
    ctx.scene.add(this.group);
  }

  init() {
    const { terrain } = this.ctx;
    const mat = new THREE.MeshStandardMaterial({ color: 0x2bb8cf, roughness: 0.1, transparent: true, opacity: 0.85 });
    const sites = [
      ...terrain.lakeSites.map((s) => ({ ...s, kind: 'lake' })),
      ...terrain.puddleSites.map((s) => ({ ...s, kind: 'puddle' })),
    ];
    sites.forEach((s, id) => {
      const mesh = new THREE.Mesh(new THREE.CircleGeometry(s.radius, 32).rotateX(-Math.PI / 2), mat);
      mesh.position.set(s.x, s.level, s.z);
      this.group.add(mesh);
      this.bodies.push({ id, kind: s.kind, x: s.x, y: s.level, z: s.z, radius: s.radius, volume: s.volume, maxVolume: s.volume, drainedBy: null, mesh });
    });
  }

  drain(body, litres) {
    const taken = Math.min(body.volume, litres);
    body.volume -= taken;
    return taken;
  }

  reset() {
    for (const b of this.bodies) {
      b.volume = b.maxVolume;
      b.drainedBy = null;
    }
  }

  update() {
    for (const b of this.bodies) {
      const f = b.volume / b.maxVolume;
      b.mesh.visible = f > 0.01;
      b.mesh.scale.setScalar(0.3 + 0.7 * Math.sqrt(f));
    }
  }
}
