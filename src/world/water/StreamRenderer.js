import * as THREE from 'three';
import { getSkin } from '../../game/skins.js';

/**
 * Draws every stream (player + rivals): the falling drop, the moving head and the
 * river trail it leaves behind. Reads (never writes) ctx.game.streams.
 * Stream fields it relies on (see game/Stream.js): id, phase, pos, vel, volume, radius,
 * skin, color, isPlayer, trail { data: Float32Array [x,y,z,width,...], count, version }.
 * Listens to bus 'splash' { x, y, z, size } for impact splashes.
 */
export class StreamRenderer {
  constructor(ctx) {
    this.ctx = ctx;
    this.views = new Map();
    this.group = new THREE.Group();
    ctx.scene.add(this.group);
  }

  reset() {
    for (const v of this.views.values()) this.disposeView(v);
    this.views.clear();
  }

  createView(stream) {
    const skin = getSkin(stream.skin);
    const tint = new THREE.Color(skin.shallow);
    if (!stream.isPlayer) tint.lerp(new THREE.Color(stream.color), 0.25);
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(1, 24, 16),
      new THREE.MeshStandardMaterial({ color: tint, roughness: 0.15, transparent: true, opacity: 0.9 }),
    );
    const ribbonGeo = new THREE.BufferGeometry();
    const ribbon = new THREE.Mesh(
      ribbonGeo,
      new THREE.MeshStandardMaterial({ color: tint, roughness: 0.1, transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
    );
    ribbon.frustumCulled = false;
    this.group.add(head, ribbon);
    return { head, ribbon, version: -1 };
  }

  disposeView(v) {
    this.group.remove(v.head, v.ribbon);
    v.head.geometry.dispose();
    v.ribbon.geometry.dispose();
  }

  rebuildRibbon(view, trail) {
    const n = trail.count;
    if (n < 2) return;
    const d = trail.data;
    const pos = new Float32Array(n * 2 * 3);
    const idx = [];
    for (let i = 0; i < n; i++) {
      const a = Math.max(i - 1, 0);
      const b = Math.min(i + 1, n - 1);
      let dx = d[b * 4] - d[a * 4];
      let dz = d[b * 4 + 2] - d[a * 4 + 2];
      const len = Math.hypot(dx, dz) || 1;
      dx /= len;
      dz /= len;
      const w = d[i * 4 + 3];
      const x = d[i * 4];
      const y = d[i * 4 + 1] + 0.4;
      const z = d[i * 4 + 2];
      pos.set([x - dz * w, y, z + dx * w, x + dz * w, y, z - dx * w], i * 6);
      if (i < n - 1) {
        const k = i * 2;
        idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
      }
    }
    const geo = view.ribbon.geometry;
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
  }

  update() {
    const streams = this.ctx.game?.streams ?? [];
    for (const s of streams) {
      let view = this.views.get(s.id);
      if (!view) {
        view = this.createView(s);
        this.views.set(s.id, view);
      }
      const visible = s.phase === 'drop' || s.phase === 'flow';
      view.head.visible = visible;
      view.head.position.copy(s.pos);
      view.head.scale.setScalar(s.phase === 'drop' ? s.radius * 1.5 : s.radius);
      if (s.trail.version !== view.version) {
        this.rebuildRibbon(view, s.trail);
        view.version = s.trail.version;
      }
    }
  }
}
