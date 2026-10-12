import { hex } from './util.js';

/**
 * Stylized island map shared by the minimap and the full map.
 *   painter.base           canvas (N×N) covering the whole terrain square, north (−z) up
 *   painter.toMap(x, z)    world → base-pixel coords
 *   painter.drawOverlay(g, view)   lakes, routes, heads, player on top of a drawn base
 * Uses terrain.createMapCanvas(size) when the terrain module provides one; otherwise paints its own
 * (hillshaded relief, colour bands matching the art bible, coast foam, contour lines).
 */
export class MapPainter {
  constructor(ctx) {
    this.ctx = ctx;
    this.base = null;
    this.N = 0;
  }

  build() {
    const { terrain, quality } = this.ctx;
    const N = (this.N = quality?.name === 'low' ? 640 : quality?.name === 'medium' ? 768 : 1024);
    let canvas = null;
    if (typeof terrain.createMapCanvas === 'function') {
      try {
        canvas = terrain.createMapCanvas(N);
      } catch (e) {
        console.warn('[ui] terrain.createMapCanvas failed, painting our own map', e);
      }
    }
    if (canvas && canvas.width) {
      this.N = canvas.width;
      this.base = canvas;
    } else {
      this.base = paintIsland(terrain, N);
    }
    return this.base;
  }

  toMap(x, z) {
    const { size } = this.ctx.terrain;
    return [(x / size + 0.5) * this.N, (z / size + 0.5) * this.N];
  }

  /**
   * Draw dynamic layers into `g`, whose current transform maps base-pixel space to the canvas.
   * view: { scale (canvas px per base px), lakes: bool, puddles: bool, labels: bool, playerScale }
   */
  drawOverlay(g, view) {
    const { game, world } = this.ctx;
    const k = 1 / view.scale; // base px per canvas px — keeps strokes a constant on-screen width
    const N = this.N;
    const size = this.ctx.terrain.size;
    const toMap = (x) => (x / size + 0.5) * N;

    // lakes & puddles
    const bodies = world?.lakes?.bodies ?? [];
    for (const b of bodies) {
      if (b.kind === 'puddle' && !view.puddles) continue;
      const f = b.maxVolume ? b.volume / b.maxVolume : 1;
      const r = Math.max((b.radius / size) * N * (0.35 + 0.65 * Math.sqrt(Math.max(f, 0))), 1.6 * k);
      g.beginPath();
      g.arc(toMap(b.x), toMap(b.z), r, 0, Math.PI * 2);
      if (f <= 0.01) {
        g.fillStyle = 'rgba(120, 96, 70, 0.55)';
        g.fill();
      } else {
        g.fillStyle = '#2fc4e6';
        g.fill();
        g.lineWidth = 1.2 * k;
        g.strokeStyle = 'rgba(255,255,255,0.85)';
        g.stroke();
      }
    }

    if (!game?.streams?.length) return;

    // routes: dark casing, then colour — rivals first, player on top
    const streams = [...game.streams].sort((a, b) => (a.isPlayer ? 1 : 0) - (b.isPlayer ? 1 : 0));
    g.lineJoin = 'round';
    g.lineCap = 'round';
    for (const s of streams) {
      const t = s.trail;
      if (!t || t.count < 2) continue;
      const step = Math.max(1, Math.floor(t.count / (view.maxPoints ?? 400)));
      const w = (s.isPlayer ? 3.2 : 2.2) * (view.lineScale ?? 1);
      g.beginPath();
      for (let i = 0; i < t.count; i += step) g[i ? 'lineTo' : 'moveTo'](toMap(t.data[i * 4]), toMap(t.data[i * 4 + 2]));
      const li = (t.count - 1) * 4;
      g.lineTo(toMap(t.data[li]), toMap(t.data[li + 2]));
      const dead = s.phase === 'eliminated';
      g.globalAlpha = dead ? 0.45 : 1;
      g.strokeStyle = 'rgba(6, 16, 31, 0.55)';
      g.lineWidth = (w + 2.2) * k;
      g.stroke();
      g.strokeStyle = s.isPlayer ? '#ffffff' : hex(s.color);
      g.lineWidth = w * k;
      g.stroke();
      g.globalAlpha = 1;
    }

    // rival heads
    for (const s of streams) {
      if (s.isPlayer || !(s.alive || s.phase === 'finished')) continue;
      const x = toMap(s.pos.x);
      const y = toMap(s.pos.z);
      const r = (view.headR ?? 4) * k;
      g.beginPath();
      g.arc(x, y, r + 1.6 * k, 0, Math.PI * 2);
      g.fillStyle = 'rgba(6,16,31,.7)';
      g.fill();
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fillStyle = hex(s.color);
      g.fill();
      if (view.labels) {
        g.font = `800 ${11 * k}px Inter, system-ui, sans-serif`;
        g.textAlign = 'left';
        g.textBaseline = 'middle';
        g.lineWidth = 3 * k;
        g.strokeStyle = 'rgba(6,16,31,.85)';
        g.strokeText(s.name, x + r + 4 * k, y);
        g.fillStyle = '#fff';
        g.fillText(s.name, x + r + 4 * k, y);
      }
    }

    // player arrow
    const p = game.player;
    if (p) drawPlayerArrow(g, toMap(p.pos.x), toMap(p.pos.z), Math.atan2(p.heading.y, p.heading.x), k * (view.playerScale ?? 1), view.pulse ?? 0);
  }
}

export function drawPlayerArrow(g, x, y, angle, k, pulse = 0) {
  g.save();
  g.translate(x, y);
  if (pulse > 0) {
    g.beginPath();
    g.arc(0, 0, (10 + pulse * 14) * k, 0, Math.PI * 2);
    g.strokeStyle = `rgba(255,210,63,${0.8 * (1 - pulse)})`;
    g.lineWidth = 2.5 * k;
    g.stroke();
  }
  g.rotate(angle + Math.PI / 2);
  g.beginPath();
  g.moveTo(0, -9 * k);
  g.lineTo(7 * k, 7 * k);
  g.lineTo(0, 3.5 * k);
  g.lineTo(-7 * k, 7 * k);
  g.closePath();
  g.shadowColor = 'rgba(0,0,0,.5)';
  g.shadowBlur = 4 * k;
  g.fillStyle = '#FFD23F';
  g.fill();
  g.shadowBlur = 0;
  g.lineWidth = 2 * k;
  g.strokeStyle = '#2b1a00';
  g.stroke();
  g.restore();
}

// ---------------------------------------------------------------------------------------
// Fallback painter

const C = {
  deep: [10, 92, 143],
  mid: [24, 150, 196],
  shallow: [63, 217, 224],
  foam: [245, 252, 255],
  sand: [232, 211, 160],
  grassA: [93, 187, 58],
  grassB: [140, 203, 63],
  forest: [44, 120, 52],
  dry: [185, 180, 90],
  rock: [142, 129, 116],
  rockDark: [110, 98, 90],
  snow: [244, 248, 255],
};

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
const sat = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a, b, v) => {
  const t = sat((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

function hash(i, j) {
  let h = (i * 374761393 + j * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function valueNoise(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi);
  const b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1);
  const d = hash(xi + 1, yi + 1);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}

export function paintIsland(terrain, N) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = N;
  const g = canvas.getContext('2d');
  const img = g.createImageData(N, N);
  const H = new Float32Array(N * N);
  const size = terrain.size;
  for (let j = 0; j < N; j++) {
    const z = (j / (N - 1) - 0.5) * size;
    for (let i = 0; i < N; i++) H[j * N + i] = terrain.heightAt((i / (N - 1) - 0.5) * size, z);
  }
  const cellW = size / N;
  const maxH = terrain.maxHeight || 1400;
  // light from the north-west, high
  const L = [-0.55, 0.7, -0.45];
  const ll = Math.hypot(...L);
  L[0] /= ll;
  L[1] /= ll;
  L[2] /= ll;
  const contour = maxH / 9;

  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const k = j * N + i;
      const h = H[k];
      const hl = H[j * N + Math.max(i - 1, 0)];
      const hr = H[j * N + Math.min(i + 1, N - 1)];
      const hu = H[Math.max(j - 1, 0) * N + i];
      const hd = H[Math.min(j + 1, N - 1) * N + i];
      let col;
      let light = 1;
      if (h <= 0) {
        const depth = -h;
        col = depth < 14 ? mix(C.shallow, C.mid, smooth(2, 14, depth)) : mix(C.mid, C.deep, smooth(14, 110, depth));
        // soft lighter ring hugging the coast
        const ring = Math.max(hl, hr, hu, hd) > 0 ? 1 : 0;
        if (ring) col = mix(col, C.foam, 0.85);
        // gentle stylised ripples in deep water
        const n = valueNoise(i * 0.06, j * 0.06);
        col = mix(col, C.deep, (n - 0.5) * 0.12);
      } else {
        const dx = (hr - hl) / (2 * cellW);
        const dz = (hd - hu) / (2 * cellW);
        const slope = Math.hypot(dx, dz);
        const ex = 1.5; // mild relief exaggeration: readable, not noisy
        let nx = -dx * ex;
        let ny = 1;
        let nz = -dz * ex;
        const nl = Math.hypot(nx, ny, nz);
        nx /= nl;
        ny /= nl;
        nz /= nl;
        const d = nx * L[0] + ny * L[1] + nz * L[2];
        light = 0.66 + 0.46 * sat(d);

        const s = 1024 / N; // keep feature sizes independent of the canvas resolution
        const n1 = valueNoise(i * 0.02 * s, j * 0.02 * s);
        const n2 = 0.65 * valueNoise(i * 0.045 * s + 40, j * 0.045 * s - 13) + 0.35 * valueNoise(i * 0.09 * s - 7, j * 0.09 * s + 21);
        const hn = h / maxH;
        col = mix(C.grassA, C.grassB, sat(n1 * 1.4 - 0.2));
        // soft forest patches in the low/mid band
        const forest = smooth(0.5, 0.62, n2 * 0.7 + n1 * 0.3) * (1 - smooth(0.33, 0.48, hn)) * smooth(0.02, 0.06, hn);
        col = mix(col, C.forest, forest * 0.6);
        col = mix(col, C.dry, smooth(0.32, 0.5, hn + (n1 - 0.5) * 0.08));
        const rocky = Math.max(smooth(0.8, 1.3, slope), smooth(0.54, 0.66, hn + (n2 - 0.5) * 0.06));
        col = mix(col, mix(C.rock, C.rockDark, n2 * 0.5), rocky);
        col = mix(col, C.snow, smooth(0.78, 0.84, hn + (n1 - 0.5) * 0.05));
        col = mix(col, C.sand, 1 - smooth(4, 14, h));
        // contour lines
        const c0 = Math.floor(h / contour);
        if (Math.floor(hr / contour) !== c0 || Math.floor(hd / contour) !== c0) light *= 0.93;
        // coast foam line
        if (Math.min(hl, hr, hu, hd) <= 0) col = mix(col, C.foam, 0.9);
      }
      // cool, blue-tinted shadows (art bible)
      const r = col[0] * light;
      const gg = col[1] * light;
      const b = col[2] * light + (light < 1 ? (1 - light) * 26 : 0);
      const o = k * 4;
      img.data[o] = r > 255 ? 255 : r;
      img.data[o + 1] = gg > 255 ? 255 : gg;
      img.data[o + 2] = b > 255 ? 255 : b;
      img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return canvas;
}
