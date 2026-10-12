import * as THREE from 'three';

/**
 * Summit-arch geometry helpers (contract: landmarks.arch = { position, radius, mesh?, normal?, center? }).
 * The props owner may expose `center` (middle of the opening) and `normal` (direction through
 * it); otherwise both are derived from the mesh so the drop / camera line up with the hole.
 */
const _box = new THREE.Box3();
const cache = new WeakMap();

/** Horizontal unit vector through the opening. */
export function archNormal(arch) {
  if (arch.normal) return new THREE.Vector3(arch.normal.x, 0, arch.normal.z).normalize();
  const n = new THREE.Vector3(0, 0, 1);
  if (arch.mesh) n.applyQuaternion(arch.mesh.getWorldQuaternion(new THREE.Quaternion()));
  n.y = 0;
  if (n.lengthSq() < 1e-6) n.set(0, 0, 1);
  return n.normalize();
}

/** { center: Vector3 (middle of the opening), radius, normal } */
export function archGate(arch) {
  let g = cache.get(arch);
  if (g) return g;
  const center = (arch.center ?? arch.position).clone();
  const radius = arch.radius ?? 50;
  if (!arch.center && arch.mesh) {
    arch.mesh.updateWorldMatrix(true, false);
    _box.setFromObject(arch.mesh);
    if (!_box.isEmpty()) {
      // an arch's opening sits in the lower-middle of its silhouette
      const mid = _box.min.y + (_box.max.y - _box.min.y) * 0.4;
      center.y = Math.min(center.y, Math.max(mid, _box.min.y + radius * 0.4));
    }
  }
  g = { center, radius, normal: archNormal(arch) };
  cache.set(arch, g);
  return g;
}
