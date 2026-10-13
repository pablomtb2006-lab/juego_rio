import * as THREE from 'three';
import { nominalDuration } from '../../src/fluid/AbsorptionSystem.js';

/**
 * Río Vivo — rivals mode (?modo=rivales). An open arena with a few solids, the player's river and
 * five rival rivers of different colour, mass, speed and personality, plus two puddles of free
 * water. Every river is real water of the same simulation (see docs/RIVALES.md).
 */
export const RIVALS = {
  domain: { min: [-14, 0, -14], max: [14, 5, 14] },
  boxes: [
    { center: [-4, 0.6, 0], half: [0.6, 0.6, 2.5] },
    { center: [5, 0.5, -5], half: [1.5, 0.5, 0.5], rot: [0, 0.5, 0] },
    { center: [5, 0.7, 6.5], half: [0.8, 0.7, 0.8], rot: [0, 0.3, 0] },
    { center: [-7, 0.5, 6], half: [1.2, 0.5, 0.6], rot: [0, -0.4, 0] },
    { center: [0, 0.4, -8.5], half: [2, 0.4, 0.4] },
    { center: [10.5, 0.6, 1], half: [0.5, 0.6, 1.8] },
  ],
  spheres: [
    { center: [2.5, -0.4, 1.5], radius: 1.0 },
    { center: [-9, -0.3, -2], radius: 0.9 },
    { center: [9, -0.3, -3], radius: 0.8 },
  ],
  rivers: [
    { name: 'Tú', type: 'player', color: [0.1, 0.85, 0.8], at: [-9, -9], volume: 4, resistance: 0.4 },
    { name: 'Voltio', color: [0.15, 0.45, 1.0], at: [9, -9], volume: 2.5, personality: 'agresivo' },
    { name: 'Jade', color: [0.1, 0.8, 0.4], at: [8.5, 8.5], volume: 5, personality: 'territorial' },
    { name: 'Malva', color: [0.62, 0.3, 1.0], at: [-1.5, 4.5], volume: 8, personality: 'oportunista' },
    { name: 'Ámbar', color: [1.0, 0.68, 0.1], at: [-9, 9], volume: 1.5, personality: 'evasivo' },
    { name: 'Coral', color: [1.0, 0.38, 0.32], at: [1.5, -3.5], volume: 3.5, personality: 'agresivo' },
  ],
  neutral: [
    { at: [5.5, 0], volume: 0.4 },
    { at: [-5.5, -4.5], volume: 0.35 },
  ],
};

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
