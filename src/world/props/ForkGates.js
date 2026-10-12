import * as THREE from 'three';

/**
 * Signposts at every fork (see game/Forks.js): two carved posts with a coloured banner for
 * each way out, so the choice is visible from the water instead of hidden in the terrain.
 *   red    CORTA · PELIGROSA
 *   green  LARGA · SEGURA
 *   amber  OBSTÁCULOS
 *
 * Reads ctx.game.forks.list only; owns nothing else. One draw call per part.
 */
const POST_H = 15;
const BANNER_W = 18;

export class ForkGates {
  constructor(ctx) {
    this.ctx = ctx;
    this.group = new THREE.Group();
    this.group.name = 'forkGates';
  }

  /** The world is built before the game, so the gates are raised on the first update. */
  init() {}

  build() {
    const forks = this.ctx.game?.forks?.list ?? [];
    if (!forks.length) return;
    this.built = true;
    const { terrain, scene } = this.ctx;

    const gates = [];
    for (const f of forks) {
      for (const br of f.branches) {
        // stand each sign in its own valley, a little way down, facing back up at the water
        const p = br.points[2] ?? br.points[br.points.length - 1];
        gates.push({ x: p.x, z: p.z, dir: br.dir, color: new THREE.Color(br.color) });
      }
    }

    const postGeo = new THREE.CylinderGeometry(0.75, 1.15, POST_H, 7).translate(0, POST_H / 2, 0);
    const postMat = new THREE.MeshStandardMaterial({ color: 0x8e8174, roughness: 1, flatShading: true });
    this.posts = new THREE.InstancedMesh(postGeo, postMat, gates.length * 2);
    this.posts.castShadow = true;

    const bannerGeo = new THREE.PlaneGeometry(BANNER_W, 8).translate(0, -4, 0);
    const bannerMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, side: THREE.DoubleSide, emissive: 0xffffff, emissiveIntensity: 0.22 });
    this.banners = new THREE.InstancedMesh(bannerGeo, bannerMat, gates.length);
    this.banners.castShadow = false;

    // a chevron floating over the banner, pointing the way
    const arrow = new THREE.ConeGeometry(3.6, 7, 4).rotateX(Math.PI / 2);
    const arrowMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.55, roughness: 0.4 });
    this.arrows = new THREE.InstancedMesh(arrow, arrowMat, gates.length);

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const pos = new THREE.Vector3();
    const one = new THREE.Vector3(1, 1, 1);
    let pi = 0;
    gates.forEach((g, i) => {
      const yaw = Math.atan2(g.dir.x, g.dir.y);
      // the two posts sit across the branch
      const sx = -g.dir.y;
      const sz = g.dir.x;
      for (const side of [-1, 1]) {
        const x = g.x + sx * side * (BANNER_W / 2);
        const z = g.z + sz * side * (BANNER_W / 2);
        m.compose(pos.set(x, terrain.heightAt(x, z) - 0.6, z), q.setFromEuler(e.set(0, yaw, 0)), one);
        this.posts.setMatrixAt(pi++, m);
      }
      const gy = terrain.heightAt(g.x, g.z);
      m.compose(pos.set(g.x, gy + POST_H - 0.6, g.z), q.setFromEuler(e.set(0, yaw, 0)), one);
      this.banners.setMatrixAt(i, m);
      this.banners.setColorAt(i, g.color);
      m.compose(pos.set(g.x, gy + POST_H + 4.5, g.z), q.setFromEuler(e.set(0, yaw, 0)), one);
      this.arrows.setMatrixAt(i, m);
      this.arrows.setColorAt(i, g.color);
    });
    for (const im of [this.posts, this.banners, this.arrows]) {
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.frustumCulled = false;
    }
    this.group.add(this.posts, this.banners, this.arrows);
    scene.add(this.group);
    this.gates = gates;
    this.t = 0;
  }

  update(dt) {
    if (!this.built) {
      this.build();
      if (!this.built) return;
    }
    if (!this.arrows) return;
    // the chevrons bob so they catch the eye from upstream
    this.t += dt;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const pos = new THREE.Vector3();
    const one = new THREE.Vector3(1, 1, 1);
    const { terrain } = this.ctx;
    this.gates.forEach((g, i) => {
      const yaw = Math.atan2(g.dir.x, g.dir.y);
      const y = terrain.heightAt(g.x, g.z) + POST_H + 4.5 + Math.sin(this.t * 2 + i) * 1.1;
      m.compose(pos.set(g.x, y, g.z), q.setFromEuler(e.set(0, yaw, 0)), one);
      this.arrows.setMatrixAt(i, m);
    });
    this.arrows.instanceMatrix.needsUpdate = true;
  }
}
