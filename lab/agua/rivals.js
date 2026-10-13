import * as THREE from 'three';
import { nominalDuration } from '../../src/fluid/AbsorptionSystem.js';
import { makeValley } from '../../src/fluid/scenes/valley.js';

/**
 * Río Vivo — rivals mode (?modo=rivales). A valley: four rivers are born at springs on the
 * hillside and run down carved channels to the sea; they meet at confluences, where the larger
 * river absorbs the smaller one (src/fluid/scenes/valley.js, docs/RIVALES.md). Every river is real
 * water of the same simulation; nothing holds its shape but the ground.
 */
const VALLEY = makeValley();
export const RIVALS = {
  domain: VALLEY.domain,
  terrain: VALLEY.terrain,
  boxes: [],
  spheres: VALLEY.rocks,
  rivers: VALLEY.rivers,
  neutral: [],
  sink: VALLEY.sink,
  absorption: VALLEY.absorption,
  seaLevel: VALLEY.seaLevel,
  dyeStrength: 1.6, // a tint of the water, not a paint: rivers must still look like water
  maneuver: 3.5,
};

/** Ground, sea and banks of the valley (render only; the solver uses the analytic terrain). */
export function addValleyMeshes(scene, T = RIVALS.terrain) {
  const x0 = -24;
  const x1 = 40;
  const z0 = -22;
  const z1 = 22;
  const nx = 320;
  const nz = 220;
  const geo = new THREE.PlaneGeometry(x1 - x0, z1 - z0, nx, nz);
  geo.rotateX(-Math.PI / 2);
  const p = geo.attributes.position;
  const col = new Float32Array(p.count * 3);
  // linear colours (the compositor tone-maps): dark enough to stay saturated after ACES
  const grass = new THREE.Color(0.075, 0.15, 0.035);
  const dry = new THREE.Color(0.17, 0.18, 0.07);
  const bed = new THREE.Color(0.11, 0.085, 0.06); // wet soil and gravel of the channels
  const sand = new THREE.Color(0.42, 0.36, 0.24);
  const rock = new THREE.Color(0.16, 0.15, 0.14);
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) + (x0 + x1) / 2;
    const z = p.getZ(i) + (z0 + z1) / 2;
    const [h, gx, gz] = T.sample(x, z);
    p.setXYZ(i, x, h, z);
    const U = T.channels(x, z)[0];
    const slope = Math.hypot(gx, gz);
    const n = Math.sin(x * 1.7 + z * 0.9) * Math.sin(z * 2.3 - x * 0.4) * 0.5 + 0.5; // patchiness
    c.copy(grass).lerp(dry, n * 0.45);
    c.lerp(rock, Math.min(1, Math.max(0, (slope - 0.35) * 2.5)));
    c.lerp(bed, Math.min(1, U * 1.25));
    c.lerp(sand, Math.min(1, Math.max(0, (RIVALS.seaLevel + 0.45 - h) * 1.6)) * (x > 6 ? 1 : 0));
    col.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals();
  const ground = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
  ground.receiveShadow = true;
  ground.castShadow = true;
  scene.add(ground);
  const sea = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 80),
    new THREE.MeshStandardMaterial({ color: 0x1b5d74, roughness: 0.12, metalness: 0.05, transparent: true, opacity: 0.9 }),
  );
  sea.rotation.x = -Math.PI / 2;
  sea.position.set(13.2 + 30, RIVALS.seaLevel, 0);
  scene.add(sea);
  // the springs come out of rock outcrops (visual: the source itself is in the solver)
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x5b5f5c, roughness: 0.95, flatShading: true });
  for (const r of RIVALS.rivers) {
    const [x, z] = r.spring.at;
    const g = new THREE.IcosahedronGeometry(0.9, 1);
    const pp = g.attributes.position;
    for (let i = 0; i < pp.count; i++) {
      const v = new THREE.Vector3().fromBufferAttribute(pp, i);
      v.multiplyScalar(1 + Math.sin(v.x * 4.1 + x) * Math.cos(v.z * 3.3) * 0.12);
      pp.setXYZ(i, v.x, v.y * 0.8, v.z);
    }
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, rockMat);
    m.position.set(x - 1.0, T.height(x - 1.0, z) + 0.35, z);
    m.castShadow = m.receiveShadow = true;
    scene.add(m);
  }
  return { ground, sea };
}

const css = (c) => `rgb(${c.map((x) => Math.round(x * 255)).join(',')})`;
const STATE_CLASS = { libre: '', agarre: 'grab', absorbiendo: 'eat', 'siendo absorbido': 'eaten', absorbido: 'dead' };

/** Floating labels over every river + the rivers table + the event feed. */
export class RivalsHud {
  constructor(eco, camera) {
    this.eco = eco;
    this.camera = camera;
    this.layer = document.getElementById('labels');
    this.layer.innerHTML = '';
    this.layer.style.display = 'block';
    this.labels = eco.list.map((r) => {
      const el = document.createElement('div');
      el.className = 'rlabel';
      el.innerHTML = `<b style="color:${css(r.color)}">${r.name}</b><span class="m"></span><div class="bar"><i></i></div><div class="st"></div>`;
      this.layer.appendChild(el);
      return { r, el, m: el.querySelector('.m'), bar: el.querySelector('.bar'), fill: el.querySelector('.bar i'), st: el.querySelector('.st') };
    });
    this.v = new THREE.Vector3();
    this.banner = document.getElementById('banner');
  }

  dispose() {
    this.layer.innerHTML = '';
    this.layer.style.display = 'none';
    this.banner.style.display = 'none';
  }

  /** Every frame: label positions and absorption bars (the bar is the REAL transferred fraction). */
  frame(w, h) {
    const cw = this.layer.clientWidth || w;
    const ch = this.layer.clientHeight || h;
    for (const L of this.labels) {
      const r = L.r;
      if (!r.alive || r.count === 0) {
        L.el.style.display = 'none';
        continue;
      }
      this.v.set(r.com[0], r.com[1] + r.depth * 1.6 + 0.9, r.com[2]).project(this.camera);
      if (this.v.z > 1) {
        L.el.style.display = 'none';
        continue;
      }
      L.el.style.display = 'block';
      L.el.style.transform = `translate(${((this.v.x + 1) / 2) * cw}px, ${((1 - this.v.y) / 2) * ch}px) translate(-50%, -100%)`;
      L.m.textContent = ` ${(r.mass / 1000).toFixed(2)} t`;
      L.el.className = `rlabel ${STATE_CLASS[r.state] ?? ''}`;
      if (r.absorbedBy) {
        L.bar.style.display = 'block';
        L.fill.style.width = `${(r.fusion * 100).toFixed(1)}%`;
        L.fill.style.background = css(r.absorbedBy.color);
        L.st.textContent = `absorbido por ${r.absorbedBy.name} · ${(r.fusion * 100).toFixed(0)} %`;
      } else if (r.absorbing?.length) {
        L.bar.style.display = 'none';
        L.st.textContent = `absorbe a ${r.absorbing.map((b) => b.name).join(', ')}`;
      } else {
        L.bar.style.display = 'none';
        L.st.textContent = r.grabbing ? 'contacto…' : r.ai ? r.ai.mode : '';
      }
    }
    const p = this.eco.player;
    const others = this.eco.list.filter((r) => r.type !== 'player' && r.alive && r.count > 0);
    let msg = '';
    if (p && (!p.alive || p.count === 0)) msg = 'Te han absorbido · R para reiniciar';
    else if (p && others.length === 0) msg = '¡Eres el único río! · R para reiniciar';
    this.banner.style.display = msg ? 'grid' : 'none';
    if (msg) this.banner.textContent = msg;
  }

  /** Panel tables (a few times per second). */
  panel(riversEl, eventsEl) {
    const eco = this.eco;
    riversEl.innerHTML = eco.list
      .map((r) => {
        const f = r.absorbedBy ? ` ${(r.fusion * 100).toFixed(0)}%` : '';
        return `<tr><td><span class="sw" style="background:${css(r.color)}"></span>${r.name} <small>${r.personality ?? r.type}</small></td><td>${(r.mass / 1000).toFixed(2)} t · ${r.volume.toFixed(2)} m³</td></tr><tr class="sub"><td>${r.state}${f}</td><td>${r.speed.toFixed(1)} m/s · Q ${(r.flux / 1000).toFixed(1)} t/s</td></tr>`;
      })
      .join('');
    const n = eco.rivers[eco.rivers.length - 1];
    const c = eco.checks;
    const rows = [
      `<tr><td>Agua libre</td><td>${(n.mass / 1000).toFixed(2)} t</td></tr>`,
      `<tr><td>Masa total / error</td><td class="${c.ok ? 'ok' : 'bad'}">${(c.massTotal / 1000).toFixed(3)} t · ${c.countError} · ${c.bookError}</td></tr>`,
    ];
    for (const ep of eco.absorption.active.values()) {
      if (ep.phase === 'agarre') continue;
      const A = eco.rivers[ep.a];
      const B = eco.rivers[ep.b];
      rows.push(`<tr><td>${A.name} ⟵ ${B.name}</td><td>${ep.phase} ${(ep.f * 100).toFixed(0)}%</td></tr>`);
      rows.push(`<tr class="sub"><td>R ${ep.R0.toFixed(2)} · T(R) ${ep.T.toFixed(1)} s</td><td>A ${ep.area.toFixed(2)} m² · ${(ep.rateModel ?? 0).toFixed(0)} kg/s</td></tr>`);
    }
    for (const ep of eco.absorption.history.slice(-4).reverse()) {
      if (ep.phase === 'rozadura') {
        const [a, b] = ep.key.split('-').map((k) => eco.rivers[+k]);
        rows.push(`<tr class="sub"><td>roce ${a.name}–${b.name}</td><td>${ep.contactDuration.toFixed(2)} s, sin transferencia</td></tr>`);
        continue;
      }
      const A = eco.rivers[ep.a];
      const B = eco.rivers[ep.b];
      rows.push(`<tr class="sub"><td>${A.name} ⟵ ${B.name} ${ep.phase}</td><td>${(ep.mTransferred ?? 0).toFixed(0)} kg · ${(ep.duration ?? 0).toFixed(1)} s · R ${ep.R0.toFixed(1)}</td></tr>`);
    }
    eventsEl.innerHTML = rows.join('');
  }
}

export { nominalDuration };
